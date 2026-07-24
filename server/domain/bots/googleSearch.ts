/**
 * Background web search via Playwright Firefox.
 *
 * Reality check: Google often shows CAPTCHA for headless / VPS / datacenter IPs.
 * Default engine order is Bing → DuckDuckGo → Google so users still get results.
 * Override with SEARCH_ENGINES=google,bing,ddg if you have residential proxy.
 */

export type SearchEngine = 'google' | 'bing' | 'ddg';

export type GoogleSearchItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
};

export type GoogleSearchResult = {
  ok: boolean;
  engine: 'google' | 'bing' | 'ddg' | 'bing_fallback' | 'ddg_fallback';
  query: string;
  count: number;
  results: GoogleSearchItem[];
  tookMs: number;
  warning?: string;
  /** Machine summary (internal) */
  summary: string;
  /** Natural WhatsApp multipesan reply for user (preferred notify body) */
  message: string;
  pagesRead?: number;
  tried?: string[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function humanPause(minMs = 250, maxMs = 900) {
  await sleep(rand(minMs, maxMs));
}

function cleanText(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
}

function absolutizeGoogleHref(href: string): string {
  if (!href) return '';
  try {
    if (href.startsWith('/url?')) {
      const u = new URL(href, 'https://www.google.com');
      const q = u.searchParams.get('q') || u.searchParams.get('url');
      if (q && /^https?:\/\//i.test(q)) return q;
    }
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `https://www.google.com${href}`;
  } catch {
    // ignore
  }
  return href;
}

function unwrapBingUrl(href: string): string {
  try {
    const u = new URL(href);
    const enc = u.searchParams.get('u');
    if (enc && enc.startsWith('a1')) {
      const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch {
    // ignore
  }
  return href;
}

function buildSummary(query: string, engine: string, results: GoogleSearchItem[]): string {
  if (!results.length) {
    return `Pencarian "${query}" (${engine}) tidak menemukan hasil.`;
  }
  const lines = [
    `Hasil ${engine} untuk: ${query}`,
    '',
    ...results.map(
      (r) => `${r.rank}. ${r.title}\n${r.url}\n${r.snippet || '(no snippet)'}`.trim()
    ),
  ];
  return lines.join('\n\n').slice(0, 2800);
}

function parseEngineOrder(): SearchEngine[] {
  // Default: avoid Google-first on VPS (CAPTCHA). Residential proxy users can set google first.
  const raw = (process.env.SEARCH_ENGINES || 'bing,ddg,google').toLowerCase();
  const allowed = new Set(['google', 'bing', 'ddg']);
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SearchEngine => allowed.has(s));
  return list.length ? list : ['bing', 'ddg', 'google'];
}

async function typeHuman(page: any, selector: string, text: string) {
  await page.click(selector, { delay: rand(40, 120) }).catch(() => undefined);
  await humanPause(150, 400);
  await page.fill(selector, '').catch(() => undefined);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: rand(45, 140) });
    if (Math.random() < 0.08) await humanPause(120, 320);
  }
}

async function dismissConsent(page: any, log: (m: string) => void) {
  const candidates = [
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    'button:has-text("Accept")',
    'button:has-text("Saya setuju")',
    'button:has-text("Terima semua")',
    '#L2AGLb',
    'form[action*="consent"] button',
    '#bnp_btn_accept',
    'button[aria-label*="Accept"]',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 600 })) {
        await loc.click({ delay: rand(40, 100) });
        log(`dismissed consent via ${sel}`);
        await humanPause(300, 700);
        return;
      }
    } catch {
      // next
    }
  }
}

async function detectGoogleBlocked(page: any): Promise<string | null> {
  const url = page.url();
  const title = (await page.title().catch(() => '')) || '';
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const blob = `${url}\n${title}\n${bodyText.slice(0, 2500)}`.toLowerCase();
  if (
    blob.includes('unusual traffic') ||
    blob.includes('/sorry/') ||
    blob.includes('captcha') ||
    blob.includes('detected unusual traffic') ||
    blob.includes('not a robot') ||
    blob.includes('our systems have detected')
  ) {
    return 'Google blocked automated traffic (CAPTCHA / unusual traffic).';
  }
  return null;
}

async function parseGoogleResults(page: any, limit: number): Promise<GoogleSearchItem[]> {
  const items = (await page.evaluate((max: number) => {
    const document = (globalThis as any).document;
    const out: Array<{ title: string; url: string; snippet: string }> = [];
    const blocks = Array.from(
      document.querySelectorAll('#search .g, #rso .g, div[data-sokoban-container]')
    ) as any[];
    for (const block of blocks) {
      if (out.length >= max) break;
      const a = block.querySelector('a[href]');
      const h3 = block.querySelector('h3');
      if (!a || !h3) continue;
      const href = a.href || a.getAttribute('href') || '';
      if (!href || href.includes('google.com/search')) continue;
      const title = (h3.textContent || '').trim();
      if (!title) continue;
      const snippetEl =
        block.querySelector('[data-sncf], .VwiC3b, .yXK7lf, .MUxGbd, span.st') ||
        block.querySelector('div[style*="-webkit-line-clamp"]');
      const snippet = (snippetEl?.textContent || '').trim();
      out.push({ title, url: href, snippet });
    }
    if (!out.length) {
      for (const h3 of Array.from(document.querySelectorAll('h3')) as any[]) {
        if (out.length >= max) break;
        const a = h3.closest('a') || h3.parentElement?.closest('a');
        if (!a) continue;
        const href = a.href || '';
        const title = (h3.textContent || '').trim();
        if (!title || !href || href.includes('google.com/search')) continue;
        out.push({ title, url: href, snippet: '' });
      }
    }
    return out.slice(0, max);
  }, limit)) as Array<{ title: string; url: string; snippet: string }>;

  const seen = new Set<string>();
  const results: GoogleSearchItem[] = [];
  for (const raw of items) {
    const url = absolutizeGoogleHref(raw.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (url.includes('google.com') && !url.includes('google.com/maps')) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      rank: results.length + 1,
      title: cleanText(raw.title).slice(0, 160),
      url: key,
      snippet: cleanText(raw.snippet).slice(0, 320),
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function parseBingResults(page: any, limit: number): Promise<GoogleSearchItem[]> {
  const items = (await page.evaluate((max: number) => {
    const document = (globalThis as any).document;
    const out: Array<{ title: string; url: string; snippet: string }> = [];
    for (const li of Array.from(document.querySelectorAll('li.b_algo')) as any[]) {
      if (out.length >= max) break;
      const a = li.querySelector('h2 a');
      if (!a) continue;
      const title = (a.textContent || '').trim();
      const url = a.href || '';
      const snippet = (li.querySelector('.b_caption p, p')?.textContent || '').trim();
      if (title && url) out.push({ title, url, snippet });
    }
    return out;
  }, limit)) as Array<{ title: string; url: string; snippet: string }>;

  return items.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    title: cleanText(r.title).slice(0, 160),
    url: unwrapBingUrl(r.url),
    snippet: cleanText(r.snippet).slice(0, 320),
  }));
}

async function parseDdgResults(page: any, limit: number): Promise<GoogleSearchItem[]> {
  const items = (await page.evaluate((max: number) => {
    const document = (globalThis as any).document;
    const out: Array<{ title: string; url: string; snippet: string }> = [];
    for (const a of Array.from(
      document.querySelectorAll('a.result__a, a[data-testid="result-title-a"]')
    ) as any[]) {
      if (out.length >= max) break;
      const title = (a.textContent || '').trim();
      const url = a.href || '';
      const parent = a.closest('article, .result, li') || a.parentElement;
      const snippet = (
        parent?.querySelector('.result__snippet, [data-result="snippet"]')?.textContent || ''
      ).trim();
      if (title && url) out.push({ title, url, snippet });
    }
    return out;
  }, limit)) as Array<{ title: string; url: string; snippet: string }>;

  return items.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    title: cleanText(r.title).slice(0, 160),
    url: r.url,
    snippet: cleanText(r.snippet).slice(0, 320),
  }));
}

async function searchGoogle(
  page: any,
  query: string,
  limit: number,
  log: (m: string) => void
): Promise<{ results: GoogleSearchItem[]; warning?: string }> {
  log(`trying Google for: ${query}`);
  // Direct SERP is faster; if captcha, bail immediately (common on VPS)
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=id&gl=id&pws=0&num=${Math.min(10, limit)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await humanPause(400, 800);
  await dismissConsent(page, log);

  const blocked = await detectGoogleBlocked(page);
  if (blocked) {
    log(blocked + ' — skip Google quickly');
    return { results: [], warning: blocked };
  }

  // Optional more human path if not blocked: re-type and search
  try {
    const box = page.locator('textarea[name="q"], input[name="q"]').first();
    if (await box.isVisible({ timeout: 800 })) {
      await typeHuman(page, 'textarea[name="q"], input[name="q"]', query);
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await humanPause(600, 1200);
      const blocked2 = await detectGoogleBlocked(page);
      if (blocked2) return { results: [], warning: blocked2 };
    }
  } catch {
    // keep current page results
  }

  await page.mouse.wheel(0, rand(180, 500)).catch(() => undefined);
  const results = await parseGoogleResults(page, limit);
  if (!results.length) return { results: [], warning: 'Google returned 0 organic results' };
  return { results };
}

async function searchBing(
  page: any,
  query: string,
  limit: number,
  log: (m: string) => void
): Promise<{ results: GoogleSearchItem[]; warning?: string }> {
  log(`trying Bing for: ${query}`);
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id`, {
    waitUntil: 'domcontentloaded',
    timeout: 35000,
  });
  await humanPause(500, 1000);
  await dismissConsent(page, log);
  await page.mouse.wheel(0, rand(150, 400)).catch(() => undefined);
  const results = await parseBingResults(page, limit);
  if (!results.length) return { results: [], warning: 'Bing returned 0 results' };
  return { results };
}

async function searchDdg(
  page: any,
  query: string,
  limit: number,
  log: (m: string) => void
): Promise<{ results: GoogleSearchItem[]; warning?: string }> {
  log(`trying DuckDuckGo HTML for: ${query}`);
  await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 35000,
  });
  await humanPause(400, 800);
  const results = await parseDdgResults(page, limit);
  if (!results.length) return { results: [], warning: 'DuckDuckGo returned 0 results' };
  return { results };
}

export async function runGoogleSearchBot(options: {
  query: string;
  limit?: number;
  log?: (msg: string, extra?: unknown) => void;
}): Promise<GoogleSearchResult> {
  const query = String(options.query || '').trim();
  const limit = Math.min(10, Math.max(1, Number(options.limit || 5)));
  const log = options.log || ((m: string) => console.log('[web_search_bot]', m));
  if (!query) throw new Error('query required');

  const started = Date.now();
  const engines = parseEngineOrder();
  log(`engine order: ${engines.join(' → ')}`);

  // Lazy import synthesizer (LLM rekap + page read)
  const { humanizeSearchResult } = await import('./searchSynthesize');

  let firefox: any;
  try {
    ({ firefox } = await import('playwright'));
  } catch {
    throw new Error(
      'Playwright not installed. Run: npm i playwright && npx playwright install firefox'
    );
  }

  const browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      'dom.webdriver.enabled': false,
      'privacy.trackingprotection.enabled': false,
    },
  });

  const tried: string[] = [];
  const warnings: string[] = [];

  try {
    const context = await browser.newContext({
      locale: 'id-ID',
      timezoneId: process.env.TIMEZONE || 'Asia/Jakarta',
      viewport: { width: 1365 + rand(-20, 20), height: 900 + rand(-30, 30) },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
      colorScheme: 'light',
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(35000);

    for (const engine of engines) {
      tried.push(engine);
      try {
        let hit: { results: GoogleSearchItem[]; warning?: string };
        if (engine === 'google') hit = await searchGoogle(page, query, limit, log);
        else if (engine === 'bing') hit = await searchBing(page, query, limit, log);
        else hit = await searchDdg(page, query, limit, log);

        if (hit.warning) warnings.push(hit.warning);
        if (hit.results.length) {
          const label =
            engine === 'google' ? 'Google' : engine === 'bing' ? 'Bing' : 'DuckDuckGo';
          log(`${engine} ok count=${hit.results.length} — reading top pages + humanize`);

          const raw: GoogleSearchResult = {
            ok: true,
            engine,
            query,
            count: hit.results.length,
            results: hit.results,
            tookMs: Date.now() - started,
            warning: warnings.length ? warnings.join(' | ') : undefined,
            summary: buildSummary(query, label, hit.results),
            message: '',
            tried,
          };

          // Open top results one-by-one, then LLM rekap as natural chat (no link dump)
          const human = await humanizeSearchResult(page, raw, (m) => log(m));
          const tookMs = Date.now() - started;
          log(`humanize done pagesRead=${human.pagesRead} ${tookMs}ms`);

          await context.close().catch(() => undefined);
          return {
            ...raw,
            tookMs,
            message: human.message,
            // Prefer natural reply for any consumer of summary/message
            summary: human.message,
            pagesRead: human.pagesRead,
          };
        }
        log(`${engine}: no results, next engine...`);
      } catch (error: any) {
        const msg = error?.message || String(error);
        log(`${engine} error: ${msg}`);
        warnings.push(`${engine}: ${msg}`);
      }
    }

    const tookMs = Date.now() - started;
    await context.close().catch(() => undefined);
    // Natural empty — do NOT throw (would look like hard failure to user)
    const emptyHuman = await humanizeSearchResult(
      null,
      {
        ok: false,
        engine: engines[0] || 'bing',
        query,
        count: 0,
        results: [],
        tookMs,
        warning: warnings.join(' | ') || 'no results',
        summary: '',
        message: '',
        tried,
      },
      (m) => log(m)
    );
    return {
      ok: false,
      engine: engines[0] || 'bing',
      query,
      count: 0,
      results: [],
      tookMs,
      warning: warnings.join(' | ') || 'All engines empty/failed',
      summary: emptyHuman.message,
      message: emptyHuman.message,
      pagesRead: 0,
      tried,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
