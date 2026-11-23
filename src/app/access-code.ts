import { randomInt } from 'node:crypto';

/**
 * Alphabet for generated verification codes.
 *
 * The code is read off one screen and typed into a phone, so every glyph pair
 * that is easy to confuse is left out: `0/O/o` and `1/l/I`. What remains is 56
 * symbols, which over 6 characters gives ~3.1e10 combinations — far beyond
 * guessing over a LAN, and still short enough to type.
 */
export const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export const ACCESS_CODE_LENGTH = 6;

/** Random code for 单次 mode. */
export function generateAccessCode(): string {
  let out = '';
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) {
    out += ACCESS_CODE_ALPHABET[randomInt(ACCESS_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Deterministic code from a digest: 今日 mode derives one from
 * HMAC(secret, date) so it survives restarts and rolls over at midnight.
 */
export function deriveAccessCode(mac: Buffer): string {
  let out = '';
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) {
    out += ACCESS_CODE_ALPHABET[mac.readUInt32BE(i * 4) % ACCESS_CODE_ALPHABET.length];
  }
  return out;
}
