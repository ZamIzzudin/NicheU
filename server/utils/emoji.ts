/**
 * Filter emoji "manusia" untuk output Nisa.
 *
 * Keluhan: model suka memakai emoji benda/makanan/hewan (🍕🐟🌸🎯) yang nyaris
 * tidak pernah dipakai manusia di chat sehari-hari. Manusia umumnya cuma pakai
 * emoji wajah/emosi, tangan, dan hati. Sanitizer ini membuang semua emoji di
 * luar daftar putih — deterministic, jadi tidak bergantung pada kepatuhan model.
 */

// Base emoji (tanpa VS16 \uFE0F dan tanpa skin tone modifier) yang diizinkan.
const ALLOWED_BASES = new Set<string>(
  [
    // Wajah senang / tawa
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇',
    '🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑',
    // Wajah netral / mikir
    '🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥',
    // Wajah sedih / lelah / sakit
    '😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯',
    '😭','😢','😞','😩','😫','🥱',
    // Wajah ekspresif lain
    '🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹','😮','😯','😲','😳','🥺',
    '😦','😧','😨','😰','😥','😓','🤬','😡','😠','😤','😱','🥹',
    // Karakter banter umum
    '💀','👻','🤡','😈','👿','🙈','🙉','🙊','👀','🤦','🤷','💋',
    // Tangan / gesture
    '👋','🤚','✋','🖖','👌','🤌','🤏','✌','🤞','🤟','🤘','🤙','👈','👉',
    '👆','👇','☝','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤳',
    '💪','🙏','✍','💅','🤝',
    // Hati
    '❤','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💔','❣','💕','💞','💓',
    '💗','💖','💘','💝','💟','♥',
    // Gender sign — hanya muncul sebagai bagian ZWJ (🤦‍♀️ 🤷‍♂️)
    '♀','♂',
  ].map((e) => e.replace(/\uFE0F/g, ''))
);

// Cluster emoji: pictographic (+VS16) (+skin tone) (+ZWJ pictographic)…
const EMOJI_CLUSTER =
  /\p{Extended_Pictographic}\uFE0F?(?:[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

/** true kalau seluruh cluster emoji termasuk yang manusiawi. */
export function isHumanEmoji(cluster: string): boolean {
  const base = cluster.replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '');
  if (ALLOWED_BASES.has(base)) return true;
  // ZWJ sequence: izinkan kalau SEMUA bagian manusiawi (mis. 🤦‍♀️)
  return base
    .split('\u200D')
    .every((part) => part === '' || ALLOWED_BASES.has(part));
}

/**
 * Buang emoji non-manusia dari teks + rapikan spasi/tanda baca sisa.
 * Emoji yang diizinkan dibiarkan persis apa adanya.
 */
export function sanitizeEmojis(text: string): string {
  const cleaned = text.replace(EMOJI_CLUSTER, (m) => (isHumanEmoji(m) ? m : ''));
  return cleaned
    .replace(/[ \t]{2,}/g, ' ') // spasi ganda sisa emoji dibuang
    .replace(/[ \t]+([,.!?;:])/g, '$1') // "kata , jadi" -> "kata, jadi"
    .trim();
}
