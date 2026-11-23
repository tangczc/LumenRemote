import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ACCESS_CODE_ALPHABET, ACCESS_CODE_LENGTH } from '../src/app/access-code.ts';

describe('access code alphabet', () => {
  test('avoids every glyph that is easy to confuse when typed', () => {
    for (const glyph of ['0', 'O', 'o', '1', 'l', 'I']) {
      assert.equal(ACCESS_CODE_ALPHABET.includes(glyph), false, `alphabet must not contain ${glyph}`);
    }
  });

  test('covers digits plus upper and lower case letters', () => {
    assert.match(ACCESS_CODE_ALPHABET, /[A-Z]/);
    assert.match(ACCESS_CODE_ALPHABET, /[a-z]/);
    assert.match(ACCESS_CODE_ALPHABET, /[0-9]/);
    // No duplicates, otherwise the modulo picks some glyphs more often.
    assert.equal(new Set(ACCESS_CODE_ALPHABET).size, ACCESS_CODE_ALPHABET.length);
  });

  test('is long enough that guessing is hopeless', () => {
    const combinations = ACCESS_CODE_ALPHABET.length ** ACCESS_CODE_LENGTH;
    assert.ok(combinations > 1e9, `only ${combinations} combinations`);
  });
});
