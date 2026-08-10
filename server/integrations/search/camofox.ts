import axios from 'axios';
import { env } from '../../config/env';
import type { SearchItem, SearchProviderResult } from '../../domain/bots/searchTypes';

/**
 * Web search via a camofox-browser server (anti-detection, no quota).
 * https://github.com/jo-inc/camofox-browser
 *
 * Flow (REST):
 *   1. POST /tabs {userId, sessionKey, url: google search URL}  -> { tabId }
 *   2. GET  /tabs/:tabId/snapshot?userId=...                    -> { url, snapshot: SERP YAML }
 *   3. DELETE /tabs/:tabId?userId=...                           (best-effort cleanup)
 *
 * camofox's `extractGoogleSerp` produces a structured YAML snapshot of the
 * Google results page (title / url / cite / snippet per result) — we parse
 * that into the same SearchItem shape used by the rest of the search chain
 * (synthesize/humanize), so nothing downstream needs to change.
 */

function googleSearchUrl(query: string, limit?: number): string {
  const params = new URLSearchParams({
    q: query,
    hl: 'id',
    gl: 'id',
  });
  if (limit && limit > 0) params.set('num', String(Math.min(10, limit)));
  return `https://www.google.com/search?${params.toString()}`;
}

function clean(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
}

/**
 * Parse camofox Google SERP YAML:
 *   - link "Judul Hasil" [e3]:
 *     - /url: https://...
 *     - cite: example.com
 *     - text: snippet hasil...
 *
 * Nav links, PAA buttons, headings etc. have no `/url` child and are dropped.
 */
function parseSerpSnapshot(yaml: string, max: number): SearchItem[] {
  const results: SearchItem[] = [];
  let cur: { title: string; url: string; cite: string; snippet: string } | null = null;

  const flush = () => {
    if (cur && /^https?:\/\//i.test(cur.url)) {
      results.push({
        rank: results.length + 1,
        title: cur.title || cur.url,
        url: cur.url,
        snippet: cur.snippet,
        source: cur.cite || undefined,
      });
    }
    cur = null;
  };

  for (const rawLine of yaml.split('\n')) {
    if (results.length >= max) break;
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    const link = line.match(/^- link "([^"]*)" \[e\d+\]:?\s*$/);
    const url = line.match(/^-\s*\/url:\s*(\S+)\s*$/);
    const cite = line.match(/^-\s*cite:\s*(.+)$/);
    const text = line.match(/^-\s*text:\s*(.+)$/);

    if (link) {
      flush();
      cur = { title: clean(link[1]), url: '', cite: '', snippet: '' };
    } else if (url && cur) {
      cur.url = clean(url[1]);
    } else if (cite && cur) {
      cur.cite = clean(cite[1]);
    } else if (text && cur) {
      cur.snippet = cur.snippet ? `${cur.snippet} ${clean(text[1])}` : clean(text[1]);
    } else if (line.startsWith('- ')) {
      flush();
    }
  }
  flush();
  return results.slice(0, max);
}

export async function runCamofoxSearch(options: {
  query: string;
  limit?: number;
  userId?: string;
  log?: (msg: string, extra?: unknown) => void;
}): Promise<SearchProviderResult> {
  const query = String(options.query || '').trim();
  const limit = Math.min(10, Math.max(1, Number(options.limit || 5)));
  const log = options.log || ((m: string) => console.log('[camofox]', m));
  if (!query) throw new Error('query required');

  const baseUrl = env.camofoxUrl || 'http://localhost:9377';
  const timeout = env.camofoxTimeoutMs;
  const started = Date.now();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.camofoxAccessKey) headers.Authorization = `Bearer ${env.camofoxAccessKey}`;

  // Session isolation di server camofox (userId + sessionKey per pencarian)
  const userId = String(options.userId || 'niche-daily');
  const sessionKey = `search_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  log(`camofox q="${query}" limit=${limit} url=${baseUrl}`);

  let tabId: string | null = null;
  try {
    // 1. Buka tab langsung di URL SERP Google
    const created = await axios.post(
      `${baseUrl}/tabs`,
      { userId, sessionKey, url: googleSearchUrl(query, limit) },
      { headers, timeout, validateStatus: () => true }
    );
    if (created.status >= 400) {
      throw new Error(
        `camofox create tab HTTP ${created.status}: ${JSON.stringify(created.data).slice(0, 200)}`
      );
    }
    tabId = created.data?.tabId || null;
    if (!tabId) throw new Error('camofox create tab: no tabId in response');
    log(`tab ${tabId} created`);

    // 2. Snapshot — extractGoogleSerp menunggu hasil render di sisi server
    const snap = await axios.get(
      `${baseUrl}/tabs/${encodeURIComponent(tabId)}/snapshot`,
      { params: { userId }, headers, timeout, validateStatus: () => true }
    );
    if (snap.status >= 400) {
      throw new Error(
        `camofox snapshot HTTP ${snap.status}: ${JSON.stringify(snap.data).slice(0, 200)}`
      );
    }

    const snapData = snap.data || {};
    const pageUrl = String(snapData.url || '');
    const yaml = String(snapData.snapshot || '');
    const tookMs = Date.now() - started;

    // 3. Deteksi blokir Google (halaman "sorry"/captcha)
    if (/google\.com\/sorry\//i.test(pageUrl) || /googleBlocked/i.test(JSON.stringify(snapData))) {
      log('google blocked (sorry page)');
      return {
        ok: false,
        engine: 'camofox_google',
        query,
        count: 0,
        results: [],
        tookMs,
        warning: 'google-blocked-captcha',
      };
    }
    if (!yaml.trim()) {
      return {
        ok: false,
        engine: 'camofox_google',
        query,
        count: 0,
        results: [],
        tookMs,
        warning: 'empty-snapshot',
      };
    }

    const results = parseSerpSnapshot(yaml, limit);
    log(`camofox ok count=${results.length} ${tookMs}ms`);

    return {
      ok: results.length > 0,
      engine: 'camofox_google',
      query,
      count: results.length,
      results,
      tookMs,
      warning: results.length ? undefined : 'camofox returned no parseable results',
    };
  } finally {
    // 4. Cleanup best-effort: tutup tab supaya session tidak bocor
    if (tabId) {
      axios
        .delete(`${baseUrl}/tabs/${encodeURIComponent(tabId)}`, {
          params: { userId },
          headers,
          timeout: Math.min(timeout, 15000),
          validateStatus: () => true,
        })
        .catch(() => undefined);
    }
  }
}
