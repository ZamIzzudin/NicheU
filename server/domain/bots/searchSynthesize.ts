import axios from 'axios';
import { env } from '../../config/env';
import type { GoogleSearchItem, GoogleSearchResult } from './googleSearch';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clean(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
}

/**
 * Open top result pages and pull readable text for the LLM to rekap.
 * Best-effort; failures are skipped.
 */
export async function readResultPages(
  page: any,
  results: GoogleSearchItem[],
  options: {
    maxPages?: number;
    log?: (msg: string) => void;
  } = {}
): Promise<Array<{ title: string; url: string; text: string }>> {
  const maxPages = Math.min(4, Math.max(1, options.maxPages || 3));
  const log = options.log || (() => undefined);
  const out: Array<{ title: string; url: string; text: string }> = [];

  for (const item of results.slice(0, maxPages)) {
    try {
      log(`reading page: ${item.url}`);
      await page.goto(item.url, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      await sleep(400 + Math.floor(Math.random() * 500));

      const extracted = (await page.evaluate(() => {
        const document = (globalThis as any).document;
        // Drop script/style noise
        for (const sel of ['script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'footer', 'header']) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            try {
              (el as any).remove();
            } catch {
              // ignore
            }
          }
        }
        const root =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const title = document.title || '';
        const text = (root?.innerText || document.body?.innerText || '').slice(0, 6000);
        return { title, text };
      })) as { title: string; text: string };

      const text = clean(extracted.text).slice(0, 3500);
      if (text.length < 80) {
        // keep snippet at least
        out.push({
          title: item.title,
          url: item.url,
          text: clean(item.snippet || extracted.title || '').slice(0, 500),
        });
      } else {
        out.push({
          title: clean(extracted.title || item.title).slice(0, 160),
          url: item.url,
          text,
        });
      }
    } catch (error: any) {
      log(`page read failed ${item.url}: ${error?.message || error}`);
      if (item.snippet) {
        out.push({
          title: item.title,
          url: item.url,
          text: clean(item.snippet).slice(0, 500),
        });
      }
    }
  }

  return out;
}

/**
 * Turn raw search evidence into a natural multipesan WhatsApp reply (no link dump).
 */
export async function synthesizeSearchReply(input: {
  query: string;
  pages: Array<{ title: string; url: string; text: string }>;
  results: GoogleSearchItem[];
  engine?: string;
}): Promise<string> {
  const evidenceFromPages = input.pages
    .map(
      (p, i) =>
        `Sumber ${i + 1}: ${p.title}\nCuplikan:\n${p.text.slice(0, 2200)}`
    )
    .join('\n\n---\n\n');

  const evidenceFromSnippets =
    !evidenceFromPages &&
    input.results
      .slice(0, 5)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ''}`)
      .join('\n\n');

  const evidence = evidenceFromPages || evidenceFromSnippets || '(tidak ada evidence)';

  if (
    (!input.pages.length && !input.results.length) ||
    evidence === '(tidak ada evidence)'
  ) {
    return naturalEmpty(input.query);
  }

  const system = `Kamu membalas di WhatsApp sebagai cewek Indonesia (pasangan), multipesan natural.
Tugas: rekap hasil pencarian web untuk user.

ATURAN KETAT:
1. Jawab seperti manusia yang baru selesai nyariin, BUKAN report mesin.
2. JANGAN tampilkan daftar 1. 2. 3. atau URL/link (kecuali user minta link).
3. JANGAN sebut "Bing", "Google", "fallback", "engine", "bot", "Playwright", "id run".
4. JANGAN pakai emoji ✅❌ berlebihan; boleh 0-1 emoji biasa.
5. Multipesan: pisah bubble dengan baris kosong; 2-5 bubble pendek.
6. Kalau data tanggal/fakta bentrok antar sumber, bilang ada info beda dan sebut versi paling kredibel (Marvel resmi lebih kuat dari agregrator).
7. Kalau evidence jelek/ga nemu jawaban: jujur gak nemu, gaya "waduh gak nemu apa-apa..." / "aduh barusan gak ketemu...".
8. Bahasa: chat santai Indonesia (boleh sedikit manja: iyaa, duluu, yaa) — jangan formal.
9. Fokus jawab pertanyaan user, bukan copy-paste cuplikan panjang.
10. Max ~500 karakter total (singkat).`;

  const user = `Pertanyaan user / query: ${input.query}

Evidence (untuk kamu saja, jangan dump ke user):
${evidence.slice(0, 9000)}

Tulis balasan WhatsApp final saja.`;

  try {
    const url = `${env.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await axios.post(
      url,
      {
        model: env.apiModel,
        temperature: 0.7,
        max_tokens: 400,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${env.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    if (res.status >= 400) {
      throw new Error(`LLM synthesize ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    const content = res.data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) throw new Error('empty synthesize');
    return sanitizeHumanReply(text);
  } catch (error: any) {
    // fallback tanpa LLM: jawaban human sederhana dari snippet terbaik
    return heuristicHumanReply(input.query, input.results, input.pages);
  }
}

function naturalEmpty(query: string): string {
  const opts = [
    `waduh barusan aku cariin "${query}"\n\ntapi gak nemu apa-apa yang jelas 😞\n\ncoba kasih kata kunci yang lebih spesifik yaa`,
    `aduh gak ketemu dehh\n\nudah aku coba cariin tapi kosong banget\n\nkasih detail sedikit lagi dong`,
    `hmmm aneh\n\naku cariin tapi ga nemu info yang nyambung\n\ncoba sebutin lebih detil yaa`,
  ];
  return opts[Math.floor(Math.random() * opts.length)];
}

function sanitizeHumanReply(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bid:\s*brun_\w+/gi, '')
    .replace(/\b(Bing|Google|DuckDuckGo)\s*(\(fallback\))?/gi, '')
    .replace(/Hasil\s+\w+\s+untuk:\s*/gi, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1200);
}

function heuristicHumanReply(
  query: string,
  results: GoogleSearchItem[],
  pages: Array<{ title: string; url: string; text: string }>
): string {
  if (!results.length && !pages.length) return naturalEmpty(query);

  // Try extract a date-like fact from snippets/pages
  const blob = [
    ...pages.map((p) => p.text),
    ...results.map((r) => `${r.title} ${r.snippet}`),
  ].join(' ');

  const dateMatch = blob.match(
    /(?:July|Juli|August|Agustus|September|October|Oktober|November|December|Desember)\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:January|Januari|February|Februari|March|Maret|April|May|Mei|June|Juni|July|Juli|August|Agustus|September|October|Oktober|November|December|Desember)\s+20\d{2}|20\d{2}-\d{2}-\d{2}/i
  );

  const top = pages[0]?.text || results[0]?.snippet || results[0]?.title || '';
  const short = clean(top).slice(0, 220);

  if (dateMatch) {
    return (
      `udah aku cariin yaa\n\n` +
      `yang paling sering muncul: *${dateMatch[0]}*\n\n` +
      (short ? `${short.slice(0, 140)}...\n\n` : '') +
      `kalo beda sumber kadang nulis tanggal beda dikit sih`
    );
  }

  if (short) {
    return `udah aku cariin\n\n${short}\n\nkurang lebih gituu`;
  }
  return naturalEmpty(query);
}

export async function humanizeSearchResult(
  page: any,
  raw: GoogleSearchResult,
  log: (m: string) => void
): Promise<{ reply: string; message: string; pagesRead: number }> {
  if (!raw.results?.length) {
    const reply = naturalEmpty(raw.query);
    return { reply, message: reply, pagesRead: 0 };
  }

  let pages: Array<{ title: string; url: string; text: string }> = [];
  if (page) {
    pages = await readResultPages(page, raw.results, {
      maxPages: Number(process.env.SEARCH_READ_PAGES || 3),
      log,
    });
    log(`pages read: ${pages.length}`);
  }

  const reply = await synthesizeSearchReply({
    query: raw.query,
    pages,
    results: raw.results,
    engine: raw.engine,
  });

  return { reply, message: reply, pagesRead: pages.length };
}
