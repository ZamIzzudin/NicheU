import axios from 'axios';
import { runGoogleSearchBot } from './googleSearch';

export type BotHandlerContext = {
  userId: string;
  botName: string;
  runId: string;
  config?: Record<string, unknown>;
  log: (msg: string, extra?: unknown) => void;
};

export type BotHandler = (
  params: Record<string, unknown>,
  ctx: BotHandlerContext
) => Promise<unknown>;

/**
 * Manually registered heavy handlers.
 * Add your own bots here — agent will only call bots present in DB that map to these or functionCode.
 */
const handlers = new Map<string, BotHandler>();

function register(name: string, handler: BotHandler) {
  handlers.set(name, handler);
}

register('echo', async (params, ctx) => {
  ctx.log('echo handler');
  return {
    ok: true,
    echo: params,
    userId: ctx.userId,
    at: new Date().toISOString(),
  };
});

/** Example heavy-ish handler: fetch URL and return summary fields (background safe). */
register('http_fetch', async (params, ctx) => {
  const url = String(params.url || ctx.config?.defaultUrl || '').trim();
  if (!url) throw new Error('url required');
  ctx.log(`http_fetch ${url}`);
  const res = await axios.get(url, {
    timeout: Number(ctx.config?.timeoutMs || 60000),
    maxContentLength: Number(ctx.config?.maxBytes || 2_000_000),
    validateStatus: () => true,
  });
  const body =
    typeof res.data === 'string'
      ? res.data.slice(0, 4000)
      : JSON.stringify(res.data).slice(0, 4000);
  return {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    url,
    sample: body,
  };
});

/** Simulated long job for testing background + WA notify. */
register('demo_long_job', async (params, ctx) => {
  const seconds = Math.min(120, Math.max(1, Number(params.seconds || 5)));
  const label = String(params.label || 'demo');
  ctx.log(`demo_long_job start ${seconds}s label=${label}`);
  const step = Math.max(1, Math.floor(seconds / 3));
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i > 0 && i % step === 0) ctx.log(`demo_long_job progress ${i}/${seconds}`);
  }
  return {
    ok: true,
    label,
    ranSeconds: seconds,
    finishedAt: new Date().toISOString(),
  };
});

/**
 * Web search via Playwright (background).
 * After SERP: open top pages, rekap with LLM into natural multipesan chat.
 * Empty results → soft "gak nemu" (not hard error).
 */
register('google_search', async (params, ctx) => {
  const query = String(params.query || params.q || '').trim();
  if (!query) throw new Error('query required');
  const limit = Number(params.limit || ctx.config?.defaultLimit || 5);
  ctx.log(`google_search query="${query}" limit=${limit}`);
  const result = await runGoogleSearchBot({
    query,
    limit,
    log: (m, extra) => ctx.log(m, extra),
  });

  const message =
    (result.message && result.message.trim()) ||
    (result.summary && result.summary.trim()) ||
    `waduh barusan aku cariin\n\ntapi gak nemu yang jelas 😞`;

  // Always succeed with natural reply body — notify uses message only
  return {
    ok: result.ok || result.count > 0,
    query: result.query,
    count: result.count,
    engine: result.engine,
    pagesRead: result.pagesRead || 0,
    tookMs: result.tookMs,
    // Keep raw for logs/debug storage, but notify must not dump this
    results: result.results,
    message,
    // Flag for BotService: notify with pure human message (no run id / bot chrome)
    notifyStyle: 'human_chat',
  };
});

export function getBotHandler(name: string): BotHandler | undefined {
  return handlers.get(name);
}

export function listHandlerNames(): string[] {
  return Array.from(handlers.keys()).sort();
}
