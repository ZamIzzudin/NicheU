import axios from 'axios';
import { getSerpApiKey } from '../../config/env';

export type SerpApiItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

export type SerpApiSearchResult = {
  ok: boolean;
  engine: 'serpapi_google' | 'serpapi_bing' | 'serpapi';
  query: string;
  count: number;
  results: SerpApiItem[];
  tookMs: number;
  warning?: string;
  answerBox?: string;
  knowledgeGraph?: string;
};

function clean(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
}

function pickEngine(): string {
  // google | bing | duckduckgo — google is default SerpAPI engine
  const raw = (process.env.SERPAPI_ENGINE || 'google').toLowerCase().trim();
  if (raw === 'bing' || raw === 'duckduckgo' || raw === 'google') return raw;
  return 'google';
}

/**
 * Google (or Bing/DDG) search via SerpAPI JSON.
 * Docs: https://serpapi.com/search-api
 */
export async function runSerpApiSearch(options: {
  query: string;
  limit?: number;
  log?: (msg: string, extra?: unknown) => void;
}): Promise<SerpApiSearchResult> {
  const query = String(options.query || '').trim();
  const limit = Math.min(10, Math.max(1, Number(options.limit || 5)));
  const log = options.log || ((m: string) => console.log('[serpapi]', m));
  if (!query) throw new Error('query required');

  // Always read live process.env (Dokploy injects at runtime; do not rely on boot snapshot only)
  const apiKey = getSerpApiKey();
  if (!apiKey) {
    throw new Error(
      'SERPAPI_API_KEY missing in container env. Set it in Dokploy Environment and ensure compose passes SERPAPI_API_KEY=${SERPAPI_API_KEY}'
    );
  }

  const engine = pickEngine();
  const started = Date.now();
  log(`serpapi engine=${engine} q="${query}" limit=${limit}`);

  const params: Record<string, string | number> = {
    api_key: apiKey,
    engine,
    q: query,
    num: limit,
    hl: process.env.SERPAPI_HL || 'id',
    gl: process.env.SERPAPI_GL || 'id',
  };

  // Soft location bias (optional)
  if (process.env.SERPAPI_LOCATION) {
    params.location = process.env.SERPAPI_LOCATION;
  }

  const res = await axios.get('https://serpapi.com/search.json', {
    params,
    timeout: Number(process.env.SERPAPI_TIMEOUT_MS || 30000),
    validateStatus: () => true,
  });

  const tookMs = Date.now() - started;

  if (res.status === 401 || res.status === 403) {
    throw new Error(`SerpAPI auth failed (${res.status}). Check SERPAPI_API_KEY.`);
  }
  if (res.status === 429) {
    throw new Error('SerpAPI rate limit / quota exhausted (429).');
  }
  if (res.status >= 400) {
    const errMsg =
      res.data?.error ||
      res.data?.search_metadata?.status ||
      JSON.stringify(res.data).slice(0, 200);
    throw new Error(`SerpAPI HTTP ${res.status}: ${errMsg}`);
  }

  const data = res.data || {};
  if (data.error) {
    throw new Error(`SerpAPI error: ${data.error}`);
  }

  const organic: any[] = Array.isArray(data.organic_results) ? data.organic_results : [];
  const results: SerpApiItem[] = organic.slice(0, limit).map((r: any, i: number) => ({
    rank: Number(r.position || i + 1),
    title: clean(r.title || ''),
    url: String(r.link || r.url || ''),
    snippet: clean(r.snippet || r.snippet_highlighted_words?.join?.(' ') || ''),
    source: clean(r.source || r.displayed_link || '') || undefined,
  })).filter((r: SerpApiItem) => r.title || r.snippet);

  // Optional rich blocks → short text for synthesizer
  let answerBox = '';
  if (data.answer_box) {
    const ab = data.answer_box;
    answerBox = clean(
      [
        ab.title,
        ab.answer,
        ab.snippet,
        ab.result,
        Array.isArray(ab.list) ? ab.list.join('; ') : '',
      ]
        .filter(Boolean)
        .join(' — ')
    ).slice(0, 500);
  }

  let knowledgeGraph = '';
  if (data.knowledge_graph) {
    const kg = data.knowledge_graph;
    knowledgeGraph = clean(
      [
        kg.title,
        kg.type,
        kg.description,
        kg.release_date ? `release: ${kg.release_date}` : '',
        kg.director ? `director: ${kg.director}` : '',
      ]
        .filter(Boolean)
        .join(' — ')
    ).slice(0, 500);
  }

  // Also fold answer box / kg into pseudo results if organic empty
  if (!results.length && (answerBox || knowledgeGraph)) {
    results.push({
      rank: 1,
      title: clean(data.knowledge_graph?.title || data.answer_box?.title || query),
      url: String(data.knowledge_graph?.website || data.answer_box?.link || ''),
      snippet: answerBox || knowledgeGraph,
    });
  }

  const engineLabel =
    engine === 'bing' ? 'serpapi_bing' : engine === 'google' ? 'serpapi_google' : 'serpapi';

  log(`serpapi ok count=${results.length} ${tookMs}ms`);

  return {
    ok: results.length > 0 || Boolean(answerBox || knowledgeGraph),
    engine: engineLabel,
    query,
    count: results.length,
    results,
    tookMs,
    answerBox: answerBox || undefined,
    knowledgeGraph: knowledgeGraph || undefined,
    warning: results.length ? undefined : 'SerpAPI returned no organic results',
  };
}
