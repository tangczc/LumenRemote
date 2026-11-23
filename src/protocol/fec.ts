/**
 * Interleaved XOR FEC.
 *
 * `r` parity packets are produced for a block of `k` data packets. Data packet
 * `i` belongs to parity group `i % r`, so a block repairs up to one loss per
 * group (i.e. `r` losses total, ideally spread out). Overhead is `r / k`.
 *
 * This is deliberately simple: XOR costs ~1 GB/s per core, needs no
 * pre-computed matrix, and covers the bursty loss that shows up on mobile and
 * Wi-Fi links once the stripes are interleaved.
 */

export function xorInto(acc: Buffer, src: Buffer): void {
  const n = Math.min(acc.length, src.length);
  for (let i = 0; i < n; i++) acc[i]! ^= src[i]!;
}

export function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const n = Math.max(a.length, b.length);
  const out = Buffer.allocUnsafe(n);
  out.fill(0);
  a.copy(out, 0);
  xorInto(out, b);
  return out;
}

export interface FecParity {
  /** Parity index in [0, r). */
  parityIdx: number;
  data: Buffer;
}

/** Build `r` parity buffers for `data` (indexed by fragment index). */
export function buildParity(data: (Buffer | null)[], r: number): FecParity[] {
  if (r <= 0) return [];
  let maxLen = 0;
  for (const d of data) if (d && d.length > maxLen) maxLen = d.length;
  const parity: FecParity[] = [];
  for (let j = 0; j < r; j++) {
    parity.push({ parityIdx: j, data: Buffer.alloc(maxLen) });
  }
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (!d) continue;
    xorInto(parity[i % r]!.data, d);
  }
  return parity;
}

/**
 * Recover missing fragments using parity.
 *
 * @param parts      received fragments, `null` where missing
 * @param parity     parity buffers keyed by parity index
 * @param r          number of parity groups
 * @param lengthOf   expected byte length per fragment index
 * @returns recovered fragments, index -> buffer
 */
export function recoverMissing(
  parts: (Buffer | null)[],
  parity: Map<number, Buffer>,
  r: number,
  lengthOf: (index: number) => number,
): Map<number, Buffer> {
  const recovered = new Map<number, Buffer>();
  if (r <= 0) return recovered;

  for (let j = 0; j < r; j++) {
    const par = parity.get(j);
    if (!par) continue;
    const members: number[] = [];
    const missing: number[] = [];
    for (let i = j; i < parts.length; i += r) {
      members.push(i);
      if (!parts[i]) missing.push(i);
    }
    if (missing.length !== 1) continue;

    const acc = Buffer.alloc(par.length);
    par.copy(acc);
    for (const i of members) {
      const d = parts[i];
      if (d) xorInto(acc, d);
    }
    const target = missing[0]!;
    recovered.set(target, Buffer.from(acc.subarray(0, lengthOf(target))));
  }
  return recovered;
}

/** Pick a redundancy count for a given fragment count and loss rate. */
export function parityCountFor(fragCount: number, lossRate: number, minRatio = 0.125, maxRatio = 0.5): number {
  if (fragCount <= 1) return 0;
  const ratio = Math.min(maxRatio, Math.max(minRatio, lossRate * 2.5 + minRatio));
  return Math.max(1, Math.min(Math.floor(fragCount * ratio), 64));
}
