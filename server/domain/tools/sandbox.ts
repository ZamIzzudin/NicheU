import { spawn, spawnSync } from 'child_process';
import * as path from 'path';

/**
 * Custom tool execution used to run LLM-generated code inside a `vm` context
 * in the server process. `vm` is NOT a security boundary: the old blocklist
 * could be bypassed (e.g. `this.constructor.constructor('return process')()`),
 * meaning a malicious tool = remote code execution on the host.
 *
 * Now tool code runs in a SEPARATE node child process (sandbox_runner.cjs):
 *   - spawned with Node's permission model when supported
 *     (--experimental-permission): fs write / child_process / worker_threads /
 *     native addons are denied outright
 *   - inside that child, code still runs in a hardened vm context with
 *     codeGeneration disabled (kills string-eval escapes)
 *   - parent enforces a hard timeout with SIGKILL
 *   - a crash/OOM in tool code can only kill the disposable child
 */

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

export function assertSafeCode(code: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Tool code blocked by safety policy: ${pattern}`);
    }
  }
  if (!/async\s+function\s+execute\s*\(/.test(code) && !/function\s+execute\s*\(/.test(code)) {
    throw new Error('Tool code must define function execute(params)');
  }
}

const RUNNER_PATH = path.join(__dirname, 'sandbox_runner.cjs');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STDOUT_LIMIT = 1024 * 1024;

/** Cached probe result: permission-model flags if the runtime supports them. */
let permissionFlagsCache: string[] | null = null;

function permissionFlags(): string[] {
  if (permissionFlagsCache) return permissionFlagsCache;
  try {
    const probe = spawnSync(
      process.execPath,
      ['--experimental-permission', '-e', '0'],
      { timeout: 8000 }
    );
    permissionFlagsCache =
      probe.status === 0
        ? [
            '--experimental-permission',
            `--allow-fs-read=${REPO_ROOT}`,
          ]
        : [];
  } catch {
    permissionFlagsCache = [];
  }
  return permissionFlagsCache;
}

/**
 * Execute untrusted tool code in an isolated child process.
 *
 * The legacy in-process `helpers` argument is accepted for API compatibility
 * but ignored: helpers (httpGetJson) are recreated inside the runner, where
 * they are the only way to touch the network.
 */
export async function runToolCode(
  functionCode: string,
  parameters: Record<string, unknown>,
  _helpers?: Record<string, unknown>,
  timeoutMs = 10000
): Promise<unknown> {
  assertSafeCode(functionCode);

  const deadline = Math.max(1000, Math.min(timeoutMs, 60000));
  const child = spawn(process.execPath, [...permissionFlags(), RUNNER_PATH], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
    },
  });

  let stdout = '';
  let stderr = '';
  let killed = false;

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < STDOUT_LIMIT) stdout += chunk.toString('utf-8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 16384) stderr += chunk.toString('utf-8');
  });

  const finished = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => {
      stderr += `spawn error: ${(err as Error).message}`;
      resolve({ code: null, signal: null });
    });
  });

  // Clone parameters so host-realm objects never enter the child context.
  const payload = JSON.stringify({
    code: functionCode,
    params: JSON.parse(JSON.stringify(parameters ?? {})),
    timeoutMs: deadline,
  });
  child.stdin.write(payload);
  child.stdin.end();

  const timer = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, deadline + 2500);

  let exit: { code: number | null; signal: string | null };
  try {
    exit = await finished;
  } finally {
    clearTimeout(timer);
  }

  if (killed) {
    throw new Error('Tool execution timeout (killed)');
  }

  // Parse the LAST JSON line of stdout (runner emits exactly one).
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  const last = lines[lines.length - 1];
  if (last) {
    let parsed: { ok?: boolean; result?: unknown; error?: string } | null = null;
    try {
      parsed = JSON.parse(last);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.ok === true) return parsed.result;
    if (parsed && parsed.ok === false) throw new Error(String(parsed.error));
  }

  const detail = (stderr || stdout || `exit=${exit.code} signal=${exit.signal}`).slice(-400);
  throw new Error(`Tool execution failed: ${detail}`);
}
