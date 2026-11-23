import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * End-to-end crypto for the media plane.
 *
 * Handshake: ephemeral X25519 on both sides, exchanged through signalling.
 * The transcript (both public keys + session id) is hashed and used as HKDF
 * salt, so a party that tampers with the signalling exchange produces a
 * different key. An optional connection password is mixed into `info`, which
 * authenticates manual device-code entry.
 *
 * Records: AES-256-GCM with a per-direction key. The packet header is
 * authenticated as AAD, so sequence numbers, channel ids and flags cannot be
 * rewritten in flight.
 *
 * AES-GCM rather than ChaCha20-Poly1305 because Electron's embedded Node links
 * BoringSSL, which does not expose `chacha20-poly1305` to `crypto` at all: the
 * desktop build would throw ERR_CRYPTO_UNKNOWN_CIPHER on the first packet.
 * AES-GCM is present in every Node and Electron build, and on x86-64 with
 * AES-NI it is faster than ChaCha20.
 */

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface EphemeralKeyPair {
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
}

export function generateEphemeral(): EphemeralKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKey, publicKeyRaw: der.subarray(der.length - 32) };
}

export function importPeerPublic(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new RangeError(`x25519 public key must be 32 bytes, got ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export interface SessionKeys {
  /** host -> controller key. */
  hostToPeer: Buffer;
  /** controller -> host key. */
  peerToHost: Buffer;
  hostNoncePrefix: Buffer;
  peerNoncePrefix: Buffer;
  /** SHA-256 of the transcript, useful as a short authentication string. */
  transcriptHash: Buffer;
  sas: string;
}

export interface HandshakeMaterial {
  sessionId: string;
  localEphemeral: EphemeralKeyPair;
  peerPublicRaw: Buffer;
  /** 'host' performs the host->peer key derivation. */
  role: 'host' | 'controller';
  password?: string;
  /** Extra public material bound into the transcript (device ids, version). */
  context?: Buffer;
}

export function deriveSessionKeys(m: HandshakeMaterial): SessionKeys {
  const peerKey = importPeerPublic(m.peerPublicRaw);
  const shared = diffieHellman({ privateKey: m.localEphemeral.privateKey, publicKey: peerKey });

  // Ordered by role so both peers hash identical bytes regardless of who is local.
  const hostPub = m.role === 'host' ? m.localEphemeral.publicKeyRaw : m.peerPublicRaw;
  const ctrlPub = m.role === 'host' ? m.peerPublicRaw : m.localEphemeral.publicKeyRaw;

  const transcript = createHash('sha256')
    .update('rd/transcript/v1')
    .update(m.sessionId)
    .update(hostPub)
    .update(ctrlPub)
    .update(m.context ?? Buffer.alloc(0))
    .digest();

  const ikm = m.password
    ? createHash('sha256').update(shared).update(Buffer.from(m.password, 'utf8')).digest()
    : shared;

  const okm = Buffer.from(hkdfSync('sha256', ikm, transcript, Buffer.from('rd/keys/v1'), 80));

  // okm is byte-identical on both peers (same shared secret, salt and info),
  // so slices map to a fixed direction regardless of local role.
  const hostToPeerKey = okm.subarray(0, 32);
  const peerToHostKey = okm.subarray(32, 64);
  const hostNoncePrefix = okm.subarray(64, 68);
  const peerNoncePrefix = okm.subarray(68, 72);
  const sasDigest = createHash('sha256').update(transcript).update(okm).digest();

  return {
    hostToPeer: hostToPeerKey,
    peerToHost: peerToHostKey,
    hostNoncePrefix,
    peerNoncePrefix,
    transcriptHash: transcript,
    sas: sasFromTranscript(sasDigest),
  };
}

/** Short authentication string shown to both users (4 groups of 4 digits). */
export function sasFromTranscript(transcript: Buffer): string {
  const digits: string[] = [];
  for (let i = 0; i < 4; i++) {
    const v = transcript.readUInt32BE(i * 4) % 10000;
    digits.push(v.toString().padStart(4, '0'));
  }
  return digits.join(' ');
}

export const NONCE_LEN = 12;

const AEAD_CIPHER = 'aes-256-gcm';
const AEAD_TAG_LEN = 16;

/** Fail at load time rather than mid-session if the runtime lacks AES-GCM. */
(function assertAeadAvailable(): void {
  try {
    const probe = createCipheriv(AEAD_CIPHER, Buffer.alloc(32), Buffer.alloc(NONCE_LEN), {
      authTagLength: AEAD_TAG_LEN,
    });
    probe.final();
  } catch (err) {
    throw new Error(`运行时缺少 ${AEAD_CIPHER} 支持，无法建立加密会话: ${(err as Error).message}`);
  }
})();
/** nonce = prefix(4) || seq(4) || direction(1) || zero(3) */
export function buildNonce(prefix: Buffer, seq: number, direction: 0 | 1): Buffer {
  const nonce = Buffer.alloc(NONCE_LEN);
  prefix.copy(nonce, 0, 0, 4);
  nonce.writeUInt32BE(seq >>> 0, 4);
  nonce.writeUInt8(direction, 8);
  return nonce;
}

export class AeadKey {
  constructor(
    private readonly key: Buffer,
    private readonly noncePrefix: Buffer,
    private readonly direction: 0 | 1,
  ) {}

  seal(seq: number, aad: Buffer, plaintext: Buffer): Buffer {
    const cipher = createCipheriv(AEAD_CIPHER, this.key, buildNonce(this.noncePrefix, seq, this.direction), {
      authTagLength: AEAD_TAG_LEN,
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  open(seq: number, aad: Buffer, sealed: Buffer): Buffer | null {
    if (sealed.length < AEAD_TAG_LEN) return null;
    const body = sealed.subarray(0, sealed.length - AEAD_TAG_LEN);
    const tag = sealed.subarray(sealed.length - AEAD_TAG_LEN);
    try {
      const decipher = createDecipheriv(AEAD_CIPHER, this.key, buildNonce(this.noncePrefix, seq, this.direction), {
        authTagLength: AEAD_TAG_LEN,
      });
      decipher.setAAD(aad, { plaintextLength: body.length });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      return null;
    }
  }
}

export interface DirectionalKeys {
  /** Key used to seal outgoing packets. */
  tx: AeadKey;
  /** Key used to open incoming packets. */
  rx: AeadKey;
}

export function directionalKeys(keys: SessionKeys, role: 'host' | 'controller'): DirectionalKeys {
  if (role === 'host') {
    return {
      tx: new AeadKey(keys.hostToPeer, keys.hostNoncePrefix, 0),
      rx: new AeadKey(keys.peerToHost, keys.peerNoncePrefix, 1),
    };
  }
  return {
    tx: new AeadKey(keys.peerToHost, keys.peerNoncePrefix, 1),
    rx: new AeadKey(keys.hostToPeer, keys.hostNoncePrefix, 0),
  };
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** Constant-time-ish comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
