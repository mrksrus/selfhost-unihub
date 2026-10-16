package io.github.mrksrus.unihub

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Web Push message encryption (RFC 8291, aes128gcm of RFC 8188), the
 * receiving side. The server encrypts every notification for this phone's
 * keys exactly as it would for a browser (api/src/services/notification-transports.ts),
 * so only this app can read it. Plain JDK crypto: P-256 ECDH, HKDF-SHA-256
 * and AES-128-GCM.
 */
object PushCrypto {
    /** A device's keys: the private key stays on the phone; public key and auth secret go to the server. */
    class Keys(val privateKey: PrivateKey, val publicKey: ByteArray, val auth: ByteArray) {
        fun p256dh(): String = b64(publicKey)
        fun authSecret(): String = b64(auth)
        fun privateKeyText(): String = b64(privateKey.encoded)
    }

    fun generate(): Keys {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
        return Keys(pair.private, uncompressed(pair.public as ECPublicKey), auth)
    }

    /** Keys stored by [Keys.privateKeyText], [Keys.p256dh] and [Keys.authSecret]. */
    fun restore(privateKey: String, publicKey: String, auth: String): Keys {
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(unb64(privateKey)))
        return Keys(key, unb64(publicKey), unb64(auth))
    }

    /** The plaintext of one aes128gcm message for these keys. Throws when it is not for them. */
    fun decrypt(keys: Keys, message: ByteArray): ByteArray {
        val buffer = ByteBuffer.wrap(message)
        if (message.size < 21 + 65 + 17) throw GeneralSecurityException("Message too short")
        val salt = ByteArray(16).also { buffer.get(it) }
        val recordSize = buffer.int.toLong() and 0xffffffffL
        val keyIdLength = buffer.get().toInt() and 0xff
        if (keyIdLength != 65 || recordSize < 18) throw GeneralSecurityException("Not a Web Push message")
        val senderKey = ByteArray(65).also { buffer.get(it) }
        val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }
        // One record: the server's messages stay far below 4096 bytes.
        if (ciphertext.size > recordSize) throw GeneralSecurityException("More than one record")

        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(keys.privateKey)
        agreement.doPhase(publicKeyFrom(senderKey), true)
        val shared = agreement.generateSecret()

        // RFC 8291 section 3.4: the input keying material.
        val keyInfo = "WebPush: info".toByteArray() + byteArrayOf(0) + keys.publicKey + senderKey
        val ikm = hkdf(keys.auth, shared, keyInfo, 32)
        // RFC 8188 section 2.2 and 2.3: content key and nonce.
        val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16)
        val nonce = hkdf(salt, ikm, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val padded = cipher.doFinal(ciphertext)
        // The last record ends with the delimiter 2, then zero padding.
        var end = padded.size - 1
        while (end >= 0 && padded[end] == 0.toByte()) end--
        if (end < 0 || padded[end] != 2.toByte()) throw GeneralSecurityException("Bad padding")
        return padded.copyOf(end)
    }

    private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        return expand.doFinal(info + byteArrayOf(1)).copyOf(length)
    }

    private fun uncompressed(key: ECPublicKey): ByteArray {
        fun coordinate(value: BigInteger): ByteArray {
            val bytes = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
            return ByteArray(32 - bytes.size) + bytes
        }
        return byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY)
    }

    private val P256 by lazy {
        (KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().public as ECPublicKey).params
    }

    // The ECDH step rejects a point that is not on the curve.
    private fun publicKeyFrom(bytes: ByteArray): java.security.PublicKey {
        if (bytes.size != 65 || bytes[0] != 4.toByte()) throw GeneralSecurityException("Not an uncompressed P-256 key")
        val point = ECPoint(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, P256))
    }

    fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun unb64(text: String): ByteArray = Base64.getUrlDecoder().decode(text)
}
