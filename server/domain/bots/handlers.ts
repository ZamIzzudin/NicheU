import axios from 'axios';
import { runSerpApiSearch } from '../../integrations/search/serpapi';
import { humanizeSearchResult } from './searchSynthesize';
import type { SearchItem, SearchResult } from './searchTypes';

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
 * Web search via SerpAPI (background).
 * Snippets + answer box / knowledge graph → LLM rekap intisari natural multipesan.
 * Empty results → soft "gak nemu" (not hard error / no link dump).
 */
register('google_search', async (params, ctx) => {
  const query = String(params.query || params.q || '').trim();
  if (!query) throw new Error('query required');
  const limit = Number(params.limit || ctx.config?.defaultLimit || 5);
  ctx.log(`google_search (serpapi) query="${query}" limit=${limit}`);

  let message = '';
  let ok = false;
  let count = 0;
  let engine: string = 'serpapi';
  let tookMs = 0;
  let results: SearchItem[] = [];
  let warning: string | undefined;

  try {
    const serp = await runSerpApiSearch({
      query,
      limit,
      log: (m, extra) => ctx.log(m, extra),
    });

    engine = serp.engine;
    tookMs = serp.tookMs;
    count = serp.count;
    ok = serp.ok;
    warning = serp.warning;
    results = serp.results.map((r) => ({
      rank: r.rank,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));

    if (serp.answerBox || serp.knowledgeGraph) {
      const extra = [serp.answerBox, serp.knowledgeGraph].filter(Boolean).join(' | ');
      if (results[0]) {
        results[0] = {
          ...results[0],
          snippet: cleanSnippet(`${extra}. ${results[0].snippet || ''}`),
        };
      } else if (extra) {
        results = [
          {
            rank: 1,
            title: query,
            url: '',
            snippet: cleanSnippet(extra),
          },
        ];
        count = 1;
        ok = true;
      }
    }

    const raw: SearchResult = {
      ok,
      engine,
      query,
      count,
      results,
      tookMs,
      warning,
    };

    const human = await humanizeSearchResult(raw, (m) => ctx.log(m));
    message = human.message;
  } catch (error: any) {
    const err = error?.message || String(error);
    ctx.log(`serpapi failed: ${err}`);
    warning = err;
    if (/SERPAPI_API_KEY missing|auth failed/i.test(err)) {
      message =
        'aduuh fitur carinya belum siap 😞\n\n(kunci SerpAPI belum diset di server)\n\ncoba bilang admin yaa';
    } else if (/429|quota|rate limit/i.test(err)) {
      message = 'waduh barusan kuota search-nya abis 😞\n\ncoba lagi nanti yaa';
    } else {
      message = 'waduh barusan gagal nyariin 😞\n\ncoba lagi bentar yaa';
    }
  }

  if (!message.trim()) {
    message = `waduh barusan aku cariin\n\ntapi gak nemu yang jelas 😞`;
  }

  return {
    ok: ok || count > 0,
    query,
    count,
    engine,
    tookMs,
    results,
    warning,
    message,
    notifyStyle: 'human_chat',
  };
});

function cleanSnippet(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

export function getBotHandler(name: string): BotHandler | undefined {
  return handlers.get(name);
}

export function listHandlerNames(): string[] {
  return Array.from(handlers.keys()).sort();
}
