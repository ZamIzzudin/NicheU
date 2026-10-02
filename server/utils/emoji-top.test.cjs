'use strict';
/**
 * Validasi allowlist terhadap daftar emoji yang paling sering dipakai manusia
 * di chat (WhatsApp/Unicode top-usage). Yang harus lolos = true.
 * Pakai: node --test server/utils/emoji-top.test.cjs
 */
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { isHumanEmoji } = require('./emoji.ts');
const test = require('node:test');
const assert = require('node:assert');

// ✨🎉 memang populer, tapi user minta ketat: hanya emosi + jari/tangan + hati.

test('emoji top-usage wajah/hands/hearts semua harus lolos', () => {
  const mustPass = ['😂','🥹','❤️','🤣','🙌','😭','😋','😍','😅','🥺','👏','🥰','😘','💗','😊','🤩','🤨','😐','🙂','😏','🤤','👍','🙏','💕','😢','😤','😱','😩','😫','🥱','👋','🤝','✌️','👀','💀','🙈'];
  const fails = mustPass.filter((e) => !isHumanEmoji(e));
  assert.deepStrictEqual(fails, [], `emoji umum yang salah ditolak: ${fails.join(' ')}`);
});

test('emoji benda/makanan/hewan tetap ditolak', () => {
  const mustFail = ['🍕','🐟','🌸','🚀','🎯','🔥','⭐','🍚','🐼','🍜','🎉','✨','🏆','💡','📅','⚡'];
  const leaks = mustFail.filter((e) => isHumanEmoji(e));
  assert.deepStrictEqual(leaks, [], `emoji bot yang lolos: ${leaks.join(' ')}`);
});
