package io.github.mrksrus.unihub

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.GeneralSecurityException

// The example message of RFC 8291 section 5 (keys and body as published there;
// the private key is the RFC's user agent key in PKCS #8 form).
class PushCryptoTest {
    private val rfcKeys = PushCrypto.restore(
        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgq1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM96hRANCAAQlcbK-zf3jYFUarx7Q9M02bBHOvlVfiby3sYalMzkXMWjs4uvgGFl70wR5uG48j47O1XfKWRh-kkaZDbaCAIsO",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
    )
    private val rfcMessage = PushCrypto.unb64(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    )

    @Test
    fun decryptsTheRfcExample() {
        assertEquals("When I grow up, I want to be a watermelon", String(PushCrypto.decrypt(rfcKeys, rfcMessage)))
    }

    @Test
    fun refusesAMessageForOtherKeysOrChanged() {
        assertThrows(GeneralSecurityException::class.java) { PushCrypto.decrypt(PushCrypto.generate(), rfcMessage) }
        val changed = rfcMessage.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertThrows(GeneralSecurityException::class.java) { PushCrypto.decrypt(rfcKeys, changed) }
        assertThrows(GeneralSecurityException::class.java) { PushCrypto.decrypt(rfcKeys, rfcMessage.copyOf(40)) }
    }

    // A chat preview sealed to the RFC's keys by the server's own Web Push library.
    private val preview = "lBwCztNn8mBBKzlWowKVBwAAEABBBD3IWLBDzhz69gic3HayiloK7Hv6PJlCBNiYYEH1fhCyRRER1mC6xqZFlPB8GDK6Eqb2rozq7uC4EjS8YrnMGZr4X81t4_Rr7dyXxcXxVf1YOki-sM-5eHLwLsusU0sKag_qiV4"

    @Test
    fun opensAChatPreviewOrGivesNothing() {
        assertEquals("Lunch at noon? \uD83C\uDF5C", PushCrypto.openPreview(rfcKeys, preview))
        assertNull(PushCrypto.openPreview(PushCrypto.generate(), preview))
        assertNull(PushCrypto.openPreview(rfcKeys, preview.dropLast(2) + "AA"))
        assertNull(PushCrypto.openPreview(rfcKeys, "not a sealed message"))
        assertNull(PushCrypto.openPreview(rfcKeys, ""))
    }

    @Test
    fun storedKeysComeBackTheSame() {
        val keys = PushCrypto.generate()
        assertEquals(65, keys.publicKey.size)
        assertEquals(4.toByte(), keys.publicKey[0])
        assertEquals(16, keys.auth.size)
        val restored = PushCrypto.restore(keys.privateKeyText(), keys.p256dh(), keys.authSecret())
        assertArrayEquals(keys.privateKey.encoded, restored.privateKey.encoded)
        assertArrayEquals(keys.publicKey, restored.publicKey)
        assertArrayEquals(keys.auth, restored.auth)
    }
}
