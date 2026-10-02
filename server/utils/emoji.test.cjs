'use strict';
/**
 * Test sanitizer emoji (butuh ts-node untuk load emoji.ts):
 *   node --test server/utils/emoji.test.cjs
 */
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { sanitizeEmojis, isHumanEmoji } = require('./emoji.ts');
const test = require('node:test');
const assert = require('node:assert');

test('emoji makanan/hewan/benda dibuang', () => {
  assert.equal(sanitizeEmojis('iya sayang 🍕 nanti aku pesen ya'), 'iya sayang nanti aku pesen ya');
  assert.equal(sanitizeEmojis('hehe 🐟 lucu banget'), 'hehe lucu banget');
  assert.equal(sanitizeEmojis('udah makan? 🍚🍚'), 'udah makan?');
  assert.equal(sanitizeEmojis('semangat 🚀🏆'), 'semangat');
});

test('emoji manusia dipertahankan', () => {
  assert.equal(sanitizeEmojis('aku sayang kamu ❤️'), 'aku sayang kamu ❤️');
  assert.equal(sanitizeEmojis('oke deh 👍'), 'oke deh 👍');
  assert.equal(sanitizeEmojis('wkwk 😂😂😂'), 'wkwk 😂😂😂');
  assert.equal(sanitizeEmojis('makasih ya 🥰🙏'), 'makasih ya 🥰🙏');
  // Regresi audit live: 😭 dan 😤 pernah salah dibuang
  assert.equal(sanitizeEmojis('kangen 😭'), 'kangen 😭');
  assert.equal(sanitizeEmojis('kesel 😤'), 'kesel 😤');
  assert.equal(sanitizeEmojis('capek banget 😩'), 'capek banget 😩');
});

test('campuran: yang aneh dibuang, yang manusia tetap', () => {
  assert.equal(sanitizeEmojis('ngantuk 🐼 ❤️ banget'), 'ngantuk ❤️ banget');
  assert.equal(sanitizeEmojis('bingung 🤔 harus makan apa 🍜'), 'bingung 🤔 harus makan apa');
});

test('skin tone & varian diizinkan', () => {
  assert.ok(isHumanEmoji('👍🏽'));
  assert.ok(isHumanEmoji('✌️'));
  assert.equal(sanitizeEmojis('gas 👍🏽 yok'), 'gas 👍🏽 yok');
});

test('tanda baca & spasi dibersihkan rapi', () => {
  assert.equal(sanitizeEmojis('iya 🍟, nanti ya'), 'iya, nanti ya');
  assert.equal(sanitizeEmojis('bentar 🐠 aku mandi dulu'), 'bentar aku mandi dulu');
});

test('teks tanpa emoji tidak berubah', () => {
  assert.equal(sanitizeEmojis('iya sayang ntar kabarin ya'), 'iya sayang ntar kabarin ya');
});

test('ZWJ sequence manusiawi diizinkan, ZWJ aneh dibuang', () => {
  assert.ok(isHumanEmoji('🤦‍♀️'));
  assert.equal(sanitizeEmojis('yaampun 🤦‍♀️'), 'yaampun 🤦‍♀️');
});
