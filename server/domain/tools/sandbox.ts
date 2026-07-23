import vm from 'vm';

const BLOCKED_PATTERNS = [
  /require\s*\(/,
  /process\./,
  /child_process/,
  /fs\./,
  /while\s*\(\s*true\s*\)/,
  /for\s*\(\s*;\s*;\s*\)/,
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

export async function runToolCode(
  functionCode: string,
  parameters: Record<string, unknown>,
  helpers: Record<string, unknown> = {},
  timeoutMs = 10000
): Promise<unknown> {
  assertSafeCode(functionCode);

  const sandbox: Record<string, unknown> = {
    parameters,
    Math,
    Date,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    console: {
      log: (...args: unknown[]) => console.log('[tool]', ...args),
      warn: (...args: unknown[]) => console.warn('[tool]', ...args),
      error: (...args: unknown[]) => console.error('[tool]', ...args),
    },
    ...helpers,
    __resolve: null as unknown,
    __reject: null as unknown,
  };

  vm.createContext(sandbox);

  const wrapped = `
    ${functionCode}
    new Promise(async (resolve, reject) => {
      try {
        const out = await execute(parameters);
        resolve(out);
      } catch (err) {
        reject(err);
      }
    }).then(
      (v) => { __resolve = v; __done = true; },
      (e) => { __reject = e; __done = true; }
    );
    var __done = false;
  `;

  const script = new vm.Script(wrapped, { filename: 'custom-tool.js' });
  script.runInContext(sandbox, { timeout: Math.min(timeoutMs, 1000) });

  const start = Date.now();
  while (!(sandbox as any).__done && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15));
    // drain microtasks
    await new Promise((r) => setImmediate(r));
  }

  if (!(sandbox as any).__done) {
    throw new Error('Tool execution timeout');
  }
  if ((sandbox as any).__reject) {
    const err = (sandbox as any).__reject;
    throw err instanceof Error ? err : new Error(String(err));
  }
  return (sandbox as any).__resolve;
}
