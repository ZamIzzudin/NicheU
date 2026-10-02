#!/usr/bin/env node
'use strict';
/**
 * Isolated runner for untrusted custom tool code.
 *
 * Protocol: stdin  = JSON { code, params, timeoutMs }
 *           stdout = JSON { ok: true, result } | { ok: false, error }
 *
 * This process is spawned by sandbox.ts (parent) with Node's permission model
 * enabled when available (--experimental-permission), so even if tool code
 * escapes the vm context it cannot write files, spawn processes, or load
 * native addons. Only reads under the repo root are allowed (needed to
 * require('axios') for the httpGetJson helper).
 *
 * Defense layers (parent -> child):
 *   1. Parent-side assertSafeCode blocklist (quick reject)
 *   2. Child runs under Node permission model (no fs write / child_process / worker / addons)
 *   3. vm context with codeGeneration { strings: false, wasm: false }
 *      -> kills `this.constructor.constructor('return process')()` style escapes
 *   4. Sync vm timeout (1s) + async deadline poll -> parent SIGKILL as backstop
 */

const vm = require('node:vm');
const fs = require('node:fs');

const INPUT_LIMIT = 512 * 1024;

// Keep in sync with server/domain/tools/sandbox.ts (duplicated on purpose:
// the child must not trust that the parent already validated the code).
const BLOCKED_PATTERNS = [
  /require\s*\(/,
  /process\./,
  /child_process/,
  /fs\./,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /constructor\s*\.\s*constructor/,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /import\s*\(/,
  /while\s*\(\s*true\s*\)/,
  /for\s*\(\s*;\s*;\s*\)/,
  /globalThis/,
  /global\s*\[/,
];

function assertSafeCode(code) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Tool code blocked by safety policy: ${pattern}`);
    }
  }
  if (!/async\s+function\s+execute\s*\(/.test(code) && !/function\s+execute\s*\(/.test(code)) {
    throw new Error('Tool code must define function execute(params)');
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > INPUT_LIMIT) {
        reject(new Error('input too large'));
        process.stdin.destroy();
        return;
      }
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emit(payload) {
  // Exit immediately after the payload is flushed: pending timers/promises
  // created by tool code must not keep the child process alive.
  process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(0));
  // Backstop if the write callback never fires (e.g. broken stdout).
  setTimeout(() => process.exit(0), 250).unref();
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (err) {
    emit({ ok: false, error: `bad input: ${(err && err.message) || err}` });
    return;
  }

  const { code, params, timeoutMs } = input;
  const deadlineMs = Math.max(1000, Math.min(Number(timeoutMs) || 10000, 60000));

  try {
    assertSafeCode(code);
  } catch (err) {
    emit({ ok: false, error: (err && err.message) || String(err) });
    return;
  }

  // Helper surface intentionally tiny: controlled HTTP GET only.
  const helpers = {
    httpGetJson: async (url) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw new Error('httpGetJson: only http(s) URLs are allowed');
      }
      const axios = require('axios');
      const res = await axios.get(url, { timeout: 10000 });
      return res.data;
    },
  };

  const sandbox = {
    parameters: params,
    Math,
    Date,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    ...helpers,
    __resolve: null,
    __reject: null,
    __done: false,
  };

  let context;
  try {
    context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
  } catch {
    // Older Node without per-context codeGeneration options: still isolate via vm.
    context = vm.createContext(sandbox);
  }

  const wrapped = `
    ${code}
    var __clone = function (v) {
      if (v === undefined) return null;
      try { return JSON.parse(JSON.stringify(v)); }
      catch (e1) {
        try { return { __string: String(v) }; }
        catch (e2) { return { __string: 'unserializable' }; }
      }
    };
    new Promise(function (resolve, reject) {
      execute(parameters).then(resolve, reject);
    }).then(
      function (v) { __resolve = __clone(v); __done = true; },
      function (e) { __reject = String((e && e.message) || e); __done = true; }
    );
  `;

  try {
    const script = new vm.Script(wrapped, { filename: 'custom-tool.js' });
    script.runInContext(context, { timeout: Math.min(deadlineMs, 1000) });
  } catch (err) {
    emit({ ok: false, error: (err && err.message) || String(err) });
    return;
  }

  const start = Date.now();
  while (!sandbox.__done && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, 15));
    // Drain the microtask queue so context promises can settle.
    await new Promise((r) => setImmediate(r));
  }

  if (!sandbox.__done) {
    emit({ ok: false, error: 'Tool execution timeout' });
    return;
  }
  if (sandbox.__reject !== null && sandbox.__reject !== undefined) {
    emit({ ok: false, error: String(sandbox.__reject) });
    return;
  }
  emit({ ok: true, result: sandbox.__resolve });
}

main().catch((err) => {
  emit({ ok: false, error: `runner crash: ${(err && err.message) || String(err)}` });
});
