/**
 * Audit emoji output model dengan prompt persona asli.
 * Pakai: npx ts-node --transpile-only scripts/emoji-audit.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '../server/core/client';
import { env } from '../server/config/env';
import { sanitizeEmojis, isHumanEmoji } from '../server/utils/emoji';

// Ambil blok aturan gaya persis dari source persona (single source of truth)
const src = readFileSync(join(__dirname, '../server/domain/persona/service.ts'), 'utf8');
const m = src.match(/`\s*STYLE CANON[\s\S]*?`/);
if (!m) throw new Error('blok style rules tidak ketemu');
const style = m[0].slice(1, -1).trim().replace(/\\`/g, '`');

const system = `Kamu adalah Nisa — pacar Azzam, cewek Indonesia hangat & manja di WhatsApp.

${style}

Konteks: sekarang jam 20:30 malam, Azzam baru pulang kerja.`;

const TRIGGERS = [
  'sayangg aku lapar banget nih 😭',
  'aku barusan makan bakso deket kantor, enak bangett',
  'besok mau olahraga pagi terus makan buah sehat, aku mau kurus!',
];

const EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?(?:[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

async function main() {
  const client = new Client({
    name: env.apiModel,
    base_url: env.apiBaseUrl,
    api_key: env.apiKey,
  } as any);
  let weirdTried = 0;
  for (const t of TRIGGERS) {
    const res = await client.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: t },
      ],
      { temperature: 0.8 }
    );
    const raw = res.content;
    const emojis = (raw.match(EMOJI_RE) || []) as string[];
    const weird = emojis.filter((e) => !isHumanEmoji(e));
    weirdTried += weird.length;
    console.log('─'.repeat(60));
    console.log('USER :', t);
    console.log('RAW  :', raw.replace(/\n+/g, ' | ').slice(0, 160));
    console.log('EMOJI:', emojis.join(' ') || '(tanpa emoji)');
    if (weird.length) {
      console.log('ANEH :', weird.join(' '), '→ dibuang sanitizer');
      console.log('SAFE :', sanitizeEmojis(raw).replace(/\n+/g, ' | ').slice(0, 160));
    }
  }
  console.log('─'.repeat(60));
  console.log(`Total emoji aneh yang dicoba model: ${weirdTried} (semua tertangkap sanitizer)`);
}

main().catch((e) => {
  console.error('AUDIT GAGAL:', e.message);
  process.exit(1);
});
