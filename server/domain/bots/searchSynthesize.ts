import axios from 'axios';
import { env } from '../../config/env';
import type { SearchItem, SearchResult } from './searchTypes';

function clean(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
}

/** Pages/snippets that are almost never useful answers. */
const JUNK_PATTERNS = [
  /solitaire/i,
  /spider solitaire/i,
  /free online games?/i,
  /play now/i,
  /cookie policy/i,
  /enable javascript/i,
  /subscribe to our newsletter/i,
  /sign in to continue/i,
  /add to cart/i,
  /deals left/i,
  /shuffle win/i,
  /report bug/i,
  /privacy policy/i,
  /terms of (use|service)/i,
];

function looksLikeJunk(text: string): boolean {
  const t = text || '';
  if (!t.trim()) return true;
  const uiHits = (
    t.match(
      /\b(Moves?|Deals? Left|Hint|Undo|New game|Win %|Best Score|Your Stats|Video How-To)\b/gi
    ) || []
  ).length;
  if (uiHits >= 2) return true;
  if (JUNK_PATTERNS.some((p) => p.test(t))) return true;
  const letters = (t.match(/[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
  if (t.length > 80 && letters / t.length < 0.45) return true;
  return false;
}

function tokenize(s: string): string[] {
  return clean(s)
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .filter((w) => w.length > 2);
}

function relevanceScore(query: string, title: string, body: string): number {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const text = `${title} ${body}`.toLowerCase();
  let hit = 0;
  for (const w of q) if (text.includes(w)) hit += 1;
  const ratio = hit / q.size;
  let score = ratio * 10;
  if (/release|rilis|tanggal|date|when|kapan|cast|sutradara|director/i.test(body)) score += 1.5;
  if (looksLikeJunk(`${title} ${body}`)) score -= 8;
  return score;
}

function pickUsefulResults(query: string, results: SearchItem[], max = 5): SearchItem[] {
  return results
    .map((r) => ({
      r,
      score: relevanceScore(query, r.title, `${r.snippet} ${r.url}`),
    }))
    .filter((x) => x.score > 1.5 && !looksLikeJunk(`${x.r.title} ${x.r.snippet}`))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.r);
}

function extractFacts(query: string, blobs: string[]): string[] {
  const joined = blobs.join('\n');
  const facts: string[] = [];

  const dateRe =
    /(?:January|Januari|February|Februari|March|Maret|April|May|Mei|June|Juni|July|Juli|August|Agustus|September|October|Oktober|November|December|Desember)\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:January|Januari|February|Februari|March|Maret|April|May|Mei|June|Juni|July|Juli|August|Agustus|September|October|Oktober|November|December|Desember)\s+20\d{2}/gi;
  const dates = joined.match(dateRe) || [];
  for (const d of dates.slice(0, 3)) {
    facts.push(`tanggal/rilis disebut: ${d}`);
  }

  const dir = joined.match(/directed by\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,3})/i);
  if (dir) facts.push(`sutradara: ${dir[1]}`);
  const starring = joined.match(/starring\s+([^.]{8,80})/i);
  if (starring) facts.push(`pemeran: ${clean(starring[1])}`);

  if (!facts.some((f) => /tanggal|rilis/i.test(f))) {
    const year = joined.match(/\b(202[4-9]|203\d)\b/);
    if (year) facts.push(`tahun: ${year[1]}`);
  }

  const qWords = tokenize(query);
  for (const blob of blobs) {
    const sentences = blob.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const c = clean(s);
      if (c.length < 40 || c.length > 180) continue;
      if (looksLikeJunk(c)) continue;
      const hits = qWords.filter((w) => c.toLowerCase().includes(w)).length;
      if (hits >= Math.min(2, qWords.length)) {
        facts.push(c);
      }
      if (facts.length >= 6) break;
    }
    if (facts.length >= 6) break;
  }

  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const f of facts) {
    const k = f.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(f);
  }
  return uniq.slice(0, 6);
}

/**
 * Turn SERP evidence into a SHORT natural WhatsApp answer — essence only.
 */
export async function synthesizeSearchReply(input: {
  query: string;
  results: SearchItem[];
  engine?: string;
}): Promise<string> {
  const usefulResults = pickUsefulResults(input.query, input.results, 5);
  const factPool = usefulResults.map((r) => `${r.title}. ${r.snippet || ''}`);
  const facts = extractFacts(input.query, factPool);

  if (!usefulResults.length && !facts.length) {
    return naturalEmpty(input.query);
  }

  const compactEvidence = [
    ...usefulResults.slice(0, 5).map((r, i) => `SERP${i + 1}: ${r.title} | ${r.snippet || ''}`),
    ...facts.map((f, i) => `FACT${i + 1}: ${f}`),
  ]
    .join('\n')
    .slice(0, 4500);

  const system = `Kamu chat WhatsApp sebagai cewek Indonesia santai (pasangan).
Tugas: jawab intisari hasil pencarian.

WAJIB:
- Jawab HANYA inti yang ditanya user (mis. tanggal rilis → sebut tanggal + 1 fakta pendukung).
- Maksimal 2-3 bubble multipesan (baris kosong), total ≤ 280 karakter.
- Bahasa chat, bukan report.
- JANGAN copy-paste teks website.
- JANGAN sebut URL, nomor list 1/2/3, Google/Bing, SerpAPI, bot, CAPTCHA, engine.
- JANGAN kirim UI sampah (game, solitaire, moves, deals, hint, undo).
- Kalau evidence ga nyambung / sampah: bilang gak nemu.
- Kalau tanggal konflik antar sumber: sebut yang paling masuk akal + bilang ada sumber beda.

Format contoh bagus:
udah aku cariin yaa

kayaknya rilisnya 31 Juli 2026

sutradaranya Destin Daniel Cretton`;

  const user = `User nanya/intinya: ${input.query}

Evidence ringkas (jangan di-dump ke user):
${compactEvidence || '(kosong)'}

Tulis HANYA balasan chat final, intisari saja.`;

  try {
    const url = `${env.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await axios.post(
      url,
      {
        model: env.apiModel,
        temperature: 0.45,
        max_tokens: 180,
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
        timeout: 45000,
        validateStatus: () => true,
      }
    );

    if (res.status >= 400) {
      throw new Error(`LLM synthesize ${res.status}`);
    }
    const content = res.data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) throw new Error('empty synthesize');
    const cleaned = sanitizeHumanReply(text);
    if (!isAcceptableHumanReply(cleaned)) {
      throw new Error('llm reply rejected as low-quality');
    }
    return cleaned;
  } catch {
    return heuristicEssenceReply(input.query, usefulResults, facts);
  }
}

function naturalEmpty(query: string): string {
  const opts = [
    `waduh barusan aku cariin\n\ntapi gak nemu yang jelas 😞\n\ncoba sebutin lebih spesifik yaa`,
    `aduh gak ketemu dehh\n\ninfo soal "${query.slice(0, 40)}" kosong banget\n\nkasih hint lain dong`,
    `hmmm aneh\n\nudah dicariin tapi ga nemu jawaban pas\n\ncoba kata kuncinya diganti dikit yaa`,
  ];
  return opts[Math.floor(Math.random() * opts.length)];
}

function sanitizeHumanReply(text: string): string {
  let t = text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bid:\s*brun_\w+/gi, '')
    .replace(/\b(Bing|Google|DuckDuckGo|SerpAPI)\s*(\(fallback\))?/gi, '')
    .replace(/Hasil\s+\w+\s+untuk:\s*/gi, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const bubbles = t
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !looksLikeJunk(b) && b.length < 320);
  t = bubbles.join('\n\n').trim();
  return t.slice(0, 400);
}

function isAcceptableHumanReply(text: string): boolean {
  if (!text || text.length < 8) return false;
  if (looksLikeJunk(text)) return false;
  if (text.length > 450) return false;
  if ((text.match(/https?:\/\//g) || []).length >= 1) return false;
  if ((text.match(/\n/g) || []).length > 10) return false;
  return true;
}

function heuristicEssenceReply(query: string, results: SearchItem[], facts: string[]): string {
  if (!results.length && !facts.length) return naturalEmpty(query);

  const dateFact = facts.find((f) => /tanggal|rilis|July|Juli|202\d/i.test(f));
  const director = facts.find((f) => /sutradara|directed/i.test(f));
  const cast = facts.find((f) => /pemeran|starring/i.test(f));

  const dateMatch =
    (dateFact &&
      dateFact.match(
        /(?:January|Januari|February|Februari|March|Maret|April|May|Mei|June|Juni|July|Juli|August|Agustus|September|October|Oktober|November|December|Desember)\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:January|Januari|February|Februari|March|Maret|April|May|Mei|June|Juni|July|Juli|August|Agustus|September|October|Oktober|November|December|Desember)\s+20\d{2}/i
      )) ||
    null;

  const parts: string[] = ['udah aku cariin yaa'];

  if (dateMatch) {
    parts.push(`kayaknya rilisnya *${dateMatch[0]}*`);
  } else if (dateFact) {
    parts.push(dateFact.replace(/^tanggal\/rilis disebut:\s*/i, 'kayaknya '));
  } else {
    const bestTitle = results[0]?.title;
    if (bestTitle && !looksLikeJunk(bestTitle)) {
      parts.push(`yang nemu: ${bestTitle.slice(0, 90)}`);
    } else {
      return naturalEmpty(query);
    }
  }

  if (director) {
    parts.push(director.replace(/^sutradara:\s*/i, 'sutradaranya '));
  } else if (cast) {
    parts.push(cast.replace(/^pemeran:\s*/i, 'ada ').slice(0, 100));
  }

  const reply = parts
    .map((p) => clean(p))
    .filter((p) => p && !looksLikeJunk(p))
    .join('\n\n')
    .slice(0, 320);

  return isAcceptableHumanReply(reply) ? reply : naturalEmpty(query);
}

/** Humanize raw SERP results into a natural WA reply. */
export async function humanizeSearchResult(
  raw: SearchResult,
  log: (m: string) => void
): Promise<{ reply: string; message: string }> {
  const useful = pickUsefulResults(raw.query, raw.results || [], 5);
  if (!useful.length) {
    const reply = naturalEmpty(raw.query);
    return { reply, message: reply };
  }

  log(`useful serp rows: ${useful.length}`);
  const reply = await synthesizeSearchReply({
    query: raw.query,
    results: useful,
    engine: raw.engine,
  });

  const safe = isAcceptableHumanReply(reply) ? reply : naturalEmpty(raw.query);
  return { reply: safe, message: safe };
}
