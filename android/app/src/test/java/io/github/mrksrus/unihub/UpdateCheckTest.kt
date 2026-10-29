package io.github.mrksrus.unihub

import io.github.mrksrus.unihub.UpdateCheck.Apk
import io.github.mrksrus.unihub.UpdateCheck.Refusal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateCheckTest {
    private val own = "io.github.mrksrus.unihub"
    private val releaseKey = "a1".repeat(32)
    private val debugKey = "d0".repeat(32)
    private val installed = Apk(own, 25001, setOf(releaseKey))

    @Test
    fun theSameAppBySameSignerInANewerOrTheSameVersionIsInstalled() {
        assertNull(UpdateCheck.refusal(installed, Apk(own, 25002, setOf(releaseKey))))
        assertNull(UpdateCheck.refusal(installed, Apk(own, 25001, setOf(releaseKey))))
        // A rotated key: the update's lineage includes the installed signer.
        assertNull(UpdateCheck.refusal(installed, Apk(own, 26000, setOf(releaseKey, "b2".repeat(32)))))
    }

    @Test
    fun anotherAppIsRefusedWhateverItsVersionOrSigner() {
        assertEquals(Refusal.NOT_UNIHUB, UpdateCheck.refusal(installed, Apk("com.example.other", 99999, setOf(releaseKey))))
        assertEquals(Refusal.NOT_UNIHUB, UpdateCheck.refusal(installed, Apk("io.github.mrksrus.unihub.evil", 99999, setOf("e1".repeat(32)))))
    }

    @Test
    fun thisAppSignedWithAnotherKeyIsRefused() {
        assertEquals(Refusal.NOT_UNIHUB, UpdateCheck.refusal(installed, Apk(own, 25002, setOf(debugKey))))
        // Rotated away from the installed key, or the installed signers unknown.
        assertEquals(Refusal.NOT_UNIHUB, UpdateCheck.refusal(Apk(own, 25001, setOf(releaseKey, debugKey)), Apk(own, 25002, setOf(releaseKey))))
        assertEquals(Refusal.NOT_UNIHUB, UpdateCheck.refusal(Apk(own, 25001, emptySet()), Apk(own, 25002, setOf(releaseKey))))
    }

    @Test
    fun anOlderVersionOrAnUnreadableFileIsRefused() {
        assertEquals(Refusal.OLDER, UpdateCheck.refusal(installed, Apk(own, 25000, setOf(releaseKey))))
        assertEquals(Refusal.UNREADABLE, UpdateCheck.refusal(installed, null))
        assertEquals(Refusal.UNREADABLE, UpdateCheck.refusal(installed, Apk(own, 25002, emptySet())))
    }
}
