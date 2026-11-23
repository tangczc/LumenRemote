package com.lumen.remote.protocol

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end crypto for the media plane. Mirrors `src/protocol/crypto.ts`
 * exactly: same transcript order, same HKDF info strings, same nonce layout,
 * otherwise a phone and a PC could never agree on a key.
 *
 * X25519 is implemented here with BigInteger because Android exposes the XDH
 * KeyAgreement only from API 33, and minSdk is 26. It runs twice per session, so
 * bignum arithmetic is fast enough and keeps a single code path on every device.
 */
object Crypto {
    private val P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    private val A24 = BigInteger.valueOf(121665)
    private val RANDOM = SecureRandom()

    const val NONCE_LEN = 12
    private const val TAG_LEN = 16

    private fun leToBig(bytes: ByteArray): BigInteger {
        // n+1 bytes so the value is always interpreted as positive; the LE input
        // occupies positions 1..n, i.e. index n holds bytes[0].
        val be = ByteArray(bytes.size + 1)
        for (i in bytes.indices) be[bytes.size - i] = bytes[i]
        return BigInteger(be)
    }

    private fun bigToLe(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(32)
        var idx = raw.size - 1
        var i = 0
        while (idx >= 0 && i < 32) {
            out[i++] = raw[idx--]
        }
        return out
    }

    fun x25519(scalarIn: ByteArray, uIn: ByteArray): ByteArray {
        require(scalarIn.size == 32 && uIn.size == 32) { "x25519 needs 32-byte inputs" }

        val k = scalarIn.copyOf()
        k[0] = (k[0].toInt() and 248).toByte()
        k[31] = (k[31].toInt() and 127).toByte()
        k[31] = (k[31].toInt() or 64).toByte()

        val u = uIn.copyOf()
        u[31] = (u[31].toInt() and 127).toByte()

        val x1 = leToBig(u).mod(P)
        var x2 = BigInteger.ONE
        var z2 = BigInteger.ZERO
        var x3 = x1
        var z3 = BigInteger.ONE
        var swap = 0

        for (t in 254 downTo 0) {
            val kt = ((k[t ushr 3].toInt() ushr (t and 7)) and 1)
            swap = swap xor kt
            if (swap == 1) {
                val tx = x2; x2 = x3; x3 = tx
                val tz = z2; z2 = z3; z3 = tz
            }
            swap = kt

            val a = x2.add(z2).mod(P)
            val aa = a.multiply(a).mod(P)
            val b = x2.subtract(z2).mod(P)
            val bb = b.multiply(b).mod(P)
            val e = aa.subtract(bb).mod(P)
            val c = x3.add(z3).mod(P)
            val d = x3.subtract(z3).mod(P)
            val da = d.multiply(a).mod(P)
            val cb = c.multiply(b).mod(P)

            val daPlusCb = da.add(cb)
            x3 = daPlusCb.multiply(daPlusCb).mod(P)
            val daMinusCb = da.subtract(cb)
            z3 = x1.multiply(daMinusCb.multiply(daMinusCb).mod(P)).mod(P)

            x2 = aa.multiply(bb).mod(P)
            z2 = e.multiply(aa.add(A24.multiply(e))).mod(P)
        }

        if (swap == 1) {
            val tx = x2; x2 = x3; x3 = tx
            val tz = z2; z2 = z3; z3 = tz
        }

        val result = x2.multiply(z2.modPow(P.subtract(BigInteger.TWO), P)).mod(P)
        return bigToLe(result)
    }

    fun generateEphemeral(): Pair<ByteArray, ByteArray> {
        val priv = ByteArray(32)
        RANDOM.nextBytes(priv)
        val base = ByteArray(32).also { it[0] = 9 }
        return Pair(priv, x25519(priv, base))
    }

    private fun hex(s: String): ByteArray {
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte()
        }
        return out
    }

    private fun hexOf(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    /**
     * X25519 is hand-rolled here, so verify it against RFC 7748 on startup. A
     * silent failure would look like "connection established but no video".
     */
    fun selfTest(): String {
        val scalar = hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
        val u = hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
        val expected = "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"
        val got = hexOf(x25519(scalar, u))
        if (got != expected) return "x25519 FAIL got=$got"

        val scalar2 = hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
        val base = ByteArray(32).also { it[0] = 9 }
        // Cross-checked against OpenSSL's X25519 with the same inputs.
        val pubExpected = "1c9fd88f45606d932a80c71824ae151d15d73e77de38e8e000852e614fae7019"
        if (hexOf(x25519(scalar2, base)) != pubExpected) return "x25519 basepoint FAIL"
        return "ok"
    }

    fun sha256(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        for (p in parts) md.update(p)
        return md.digest()
    }

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** HKDF-SHA256 extract-and-expand, output length limited to 255*32 bytes. */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmacSha256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            counter++
        }
        return out
    }

    /** nonce = prefix(4) || seq(4) || direction(1) || zero(3) */
    fun buildNonce(prefix: ByteArray, seq: Long, direction: Int): ByteArray {
        val nonce = ByteArray(NONCE_LEN)
        System.arraycopy(prefix, 0, nonce, 0, 4)
        Bytes.putU32(nonce, 4, seq and 0xffff_ffffL)
        nonce[8] = direction.toByte()
        return nonce
    }
}

/** 4 groups of 4 digits derived from the SAS digest, identical to the desktop. */
fun sasFromDigest(digest: ByteArray): String {
    val sb = StringBuilder()
    for (i in 0 until 4) {
        val v = Bytes.getU32(digest, i * 4) % 10000
        if (i > 0) sb.append(' ')
        sb.append(v.toString().padStart(4, '0'))
    }
    return sb.toString()
}

class AeadKey(private val key: ByteArray, private val noncePrefix: ByteArray, private val direction: Int) {
    fun seal(seq: Long, aad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, Crypto.buildNonce(noncePrefix, seq, direction)),
        )
        cipher.updateAAD(aad)
        val body = cipher.doFinal(plaintext)
        // JCE returns ciphertext||tag, which is exactly the wire layout.
        return body
    }

    fun open(seq: Long, aad: ByteArray, sealed: ByteArray): ByteArray? {
        if (sealed.size < 16) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, Crypto.buildNonce(noncePrefix, seq, direction)),
            )
            cipher.updateAAD(aad)
            cipher.doFinal(sealed)
        } catch (_: Exception) {
            null
        }
    }
}

class SessionKeys(
    val hostToPeer: ByteArray,
    val peerToHost: ByteArray,
    val hostNoncePrefix: ByteArray,
    val peerNoncePrefix: ByteArray,
    val transcriptHash: ByteArray,
    val sas: String,
)

class DirectionalKeys(val tx: AeadKey, val rx: AeadKey)

object Handshake {
    /**
     * Must hash the same byte sequence on both peers, so the host/controller
     * public keys are ordered by role rather than by who is local.
     */
    fun deriveKeys(
        sessionId: String,
        localPrivate: ByteArray,
        localPublic: ByteArray,
        peerPublic: ByteArray,
        isHost: Boolean,
        password: String?,
    ): SessionKeys {
        require(peerPublic.size == 32) { "x25519 public key must be 32 bytes" }
        val shared = Crypto.x25519(localPrivate, peerPublic)

        val hostPub = if (isHost) localPublic else peerPublic
        val ctrlPub = if (isHost) peerPublic else localPublic

        val transcript = Crypto.sha256(
            "rd/transcript/v1".toByteArray(Charsets.UTF_8),
            sessionId.toByteArray(Charsets.UTF_8),
            hostPub,
            ctrlPub,
        )

        val ikm = if (!password.isNullOrEmpty()) {
            Crypto.sha256(shared, password.toByteArray(Charsets.UTF_8))
        } else {
            shared
        }

        val okm = Crypto.hkdfSha256(ikm, transcript, "rd/keys/v1".toByteArray(Charsets.UTF_8), 80)
        val sasDigest = Crypto.sha256(transcript, okm)

        return SessionKeys(
            hostToPeer = okm.copyOfRange(0, 32),
            peerToHost = okm.copyOfRange(32, 64),
            hostNoncePrefix = okm.copyOfRange(64, 68),
            peerNoncePrefix = okm.copyOfRange(68, 72),
            transcriptHash = transcript,
            sas = sasFromDigest(sasDigest),
        )
    }

    fun directional(keys: SessionKeys, isHost: Boolean): DirectionalKeys = if (isHost) {
        DirectionalKeys(
            tx = AeadKey(keys.hostToPeer, keys.hostNoncePrefix, 0),
            rx = AeadKey(keys.peerToHost, keys.peerNoncePrefix, 1),
        )
    } else {
        DirectionalKeys(
            tx = AeadKey(keys.peerToHost, keys.peerNoncePrefix, 1),
            rx = AeadKey(keys.hostToPeer, keys.hostNoncePrefix, 0),
        )
    }
}
