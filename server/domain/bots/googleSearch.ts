/**
 * Background Google search via Playwright Firefox.
 * Human-like delays/typing to reduce bot fingerprints.
 * Note: Google may still show CAPTCHA / consent walls from VPS IPs.
 */

export type GoogleSearchItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
};

export type GoogleSearchResult = {
  ok: boolean;
  engine: 'google' | 'bing_fallback' | 'ddg_fallback';
  query: string;
  count: number;
  results: GoogleSearchItem[];
  tookMs: number;
  warning?: string;
  summary: string;
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
  // Google redirect: /url?q=https://...&sa=...
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

function buildSummary(query: string, engine: string, results: GoogleSearchItem[]): string {
  if (!results.length) {
    return `Pencarian "${query}" (${engine}) tidak menemukan hasil.`;
  }
  const lines = [
    `Hasil ${engine} untuk: ${query}`,
    '',
    ...results.map(
      (r) =>
        `${r.rank}. ${r.title}\n${r.url}\n${r.snippet || '(no snippet)'}`.trim()
    ),
  ];
  return lines.join('\n\n').slice(0, 2800);
}

async function typeHuman(page: any, selector: string, text: string) {
  await page.click(selector, { delay: rand(40, 120) }).catch(() => undefined);
  await humanPause(150, 400);
  // clear existing
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
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 })) {
        await loc.click({ delay: rand(40, 100) });
        log(`dismissed consent via ${sel}`);
        await humanPause(400, 900);
        return;
      }
    } catch {
      // try next
    }
  }
}

async function detectBlocked(page: any): Promise<string | null> {
  const url = page.url();
  const title = (await page.title().catch(() => '')) || '';
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const blob = `${url}\n${title}\n${bodyText}`.toLowerCase();
  if (
    blob.includes('unusual traffic') ||
    blob.includes('/sorry/') ||
    blob.includes('captcha') ||
    blob.includes('detected unusual traffic') ||
    blob.includes('not a robot')
  ) {
    return 'Google blocked automated traffic (CAPTCHA / unusual traffic).';
  }
  return null;
}

async function parseGoogleResults(page: any, limit: number): Promise<GoogleSearchItem[]> {
  // Prefer organic blocks (evaluate runs in browser; use any to avoid DOM lib in node tsc)
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

    // Fallback: any h3>a patterns
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

function unwrapBingUrl(href: string): string {
  try {
    const u = new URL(href);
    // Bing redirect embeds target in u=a1 + base64(url)
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

  return items.slice(0, limit).map((r: { title: string; url: string; snippet: string }, i: number) => ({
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

  return items.slice(0, limit).map((r: { title: string; url: string; snippet: string }, i: number) => ({
    rank: i + 1,
    title: cleanText(r.title).slice(0, 160),
    url: r.url,
    snippet: cleanText(r.snippet).slice(0, 320),
  }));
}

export async function runGoogleSearchBot(options: {
  query: string;
  limit?: number;
  log?: (msg: string, extra?: unknown) => void;
}): Promise<GoogleSearchResult> {
  const query = String(options.query || '').trim();
  const limit = Math.min(10, Math.max(1, Number(options.limit || 5)));
  const log = options.log || ((m: string) => console.log('[google_search]', m));
  if (!query) throw new Error('query required');

  const started = Date.now();
  // Dynamic import so server can boot even if playwright missing in old images
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
    page.setDefaultTimeout(45000);

    // --- Google ---
    log(`opening google for: ${query}`);
    await page.goto('https://www.google.com/ncr?hl=id', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await humanPause(600, 1400);
    await dismissConsent(page, log);

    const blockedHome = await detectBlocked(page);
    if (blockedHome) {
      log(blockedHome);
    } else {
      // Prefer typing into the search box (more human than ?q= direct)
      const boxSelectors = ['textarea[name="q"]', 'input[name="q"]'];
      let typed = false;
      for (const sel of boxSelectors) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 1500 })) {
            await typeHuman(page, sel, query);
            typed = true;
            break;
          }
        } catch {
          // next
        }
      }

      if (!typed) {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=id&gl=id&pws=0&num=${limit}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } else {
        await humanPause(200, 500);
        await page.keyboard.press('Enter');
      }

      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await humanPause(900, 1800);
      // mild human scroll
      await page.mouse.wheel(0, rand(200, 600)).catch(() => undefined);
      await humanPause(400, 900);

      const blocked = await detectBlocked(page);
      if (!blocked) {
        const results = await parseGoogleResults(page, limit);
        if (results.length) {
          const tookMs = Date.now() - started;
          log(`google ok count=${results.length} ${tookMs}ms`);
          await context.close().catch(() => undefined);
          return {
            ok: true,
            engine: 'google',
            query,
            count: results.length,
            results,
            tookMs,
            summary: buildSummary(query, 'Google', results),
          };
        }
        log('google returned 0 organic results');
      } else {
        log(blocked);
      }
    }

    // --- Bing fallback ---
    log('trying Bing fallback');
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await humanPause(700, 1400);
    await page.mouse.wheel(0, rand(150, 400)).catch(() => undefined);
    const bing = await parseBingResults(page, limit);
    if (bing.length) {
      const tookMs = Date.now() - started;
      await context.close().catch(() => undefined);
      return {
        ok: true,
        engine: 'bing_fallback',
        query,
        count: bing.length,
        results: bing,
        tookMs,
        warning: 'Google blocked/empty; used Bing fallback',
        summary: buildSummary(query, 'Bing (fallback)', bing),
      };
    }

    // --- DuckDuckGo HTML fallback (still via browser) ---
    log('trying DuckDuckGo fallback');
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await humanPause(500, 1000);
    const ddg = await parseDdgResults(page, limit);
    const tookMs = Date.now() - started;
    await context.close().catch(() => undefined);

    if (ddg.length) {
      return {
        ok: true,
        engine: 'ddg_fallback',
        query,
        count: ddg.length,
        results: ddg,
        tookMs,
        warning: 'Google/Bing empty; used DuckDuckGo HTML fallback',
        summary: buildSummary(query, 'DuckDuckGo (fallback)', ddg),
      };
    }

    return {
      ok: false,
      engine: 'google',
      query,
      count: 0,
      results: [],
      tookMs,
      warning: 'No results from Google/Bing/DDG (possible block)',
      summary: `Tidak ada hasil untuk "${query}".`,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
