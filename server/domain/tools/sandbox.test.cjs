'use strict';
/**
 * Sandbox runner tests (plain node, no TS): node --test server/domain/tools/sandbox.test.cjs
 * Exercises the ISOLATED runner exactly the way sandbox.ts spawns it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const RUNNER = path.join(__dirname, 'sandbox_runner.cjs');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Same flag probing as sandbox.ts
const probe = spawnSync(process.execPath, ['--experimental-permission', '-e', '0'], { timeout: 8000 });
const FLAGS = probe.status === 0 ? ['--experimental-permission', `--allow-fs-read=${REPO_ROOT}`] : [];

function runTool(code, params = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...FLAGS, RUNNER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', () => {
      try {
        const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: 'unparseable: ' + out.slice(0, 200) });
      }
    });
    child.stdin.write(JSON.stringify({ code, params, timeoutMs }));
    child.stdin.end();
  });
}

test('permission model tersedia di runtime ini', () => {
  console.log('permission flags:', FLAGS.length ? 'AKTIF' : 'tidak didukung (vm-only fallback)');
});

test('tool komputasi normal berhasil', async () => {
  const res = await runTool(
    `async function execute(params) {
      const total = params.angka.reduce((a, b) => a + b, 0);
      return { total, waktu: typeof Date.now() === 'number' };
    }`,
    { angka: [1, 2, 3, 4] }
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.result.total, 10);
  assert.strictEqual(res.result.waktu, true);
});

test('escape via constructor.constructor DIBLOKIR (codegen off)', async () => {
  const res = await runTool(
    `async function execute(params) {
      const grabber = this.constructor.constructor('return process');
      return { versi: grabber().version };
    }`
  );
  assert.strictEqual(res.ok, false);
  assert.match(String(res.error), /code generation|eval|EvalError|blocked/i);
});

test('kode berisi require ditolak sebelum eksekusi', async () => {
  const res = await runTool(
    `async function execute(params) {
      const fs = req' + 'uire("fs");
      return fs.readFileSync("/etc/passwd", "utf8").slice(0, 50);
    }`.replace("req' + 'uire", 'require')
  );
  assert.strictEqual(res.ok, false);
  assert.match(String(res.error), /blocked by safety policy/);
});

test('timeout async terhenti dengan bersih', async () => {
  const start = Date.now();
  const res = await runTool(
    `async function execute(params) {
      await new Promise(function (resolve) { setTimeout(resolve, 60000); });
      return 'never';
    }`,
    {},
    1500
  );
  const elapsed = Date.now() - start;
  assert.strictEqual(res.ok, false);
  assert.match(String(res.error), /timeout/i);
  assert.ok(elapsed < 10000, `seharusnya berhenti cepat, tidak ${elapsed}ms`);
});

test('helper httpGetJson bisa dipakai (network terkontrol)', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jawaban: 42, path: req.url }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const res = await runTool(
    `async function execute(params) {
      const data = await httpGetJson('http://127.0.0.1:' + params.port + '/tes');
      return data;
    }`,
    { port }
  );
  server.close();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.result.jawaban, 42);
  assert.strictEqual(res.result.path, '/tes');
});

test('httpGetJson menolak URL non-http(s)', async () => {
  const res = await runTool(
    `async function execute(params) {
      return await httpGetJson('file:///etc/passwd');
    }`
  );
  assert.strictEqual(res.ok, false);
});
