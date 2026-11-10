package io.github.mrksrus.unihub

import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BiometricChoiceTest {
    @Test
    fun theConstantsAreAndroids() {
        // Compile-time constants, inlined: no Android class runs here.
        assertEquals(BiometricManager.Authenticators.BIOMETRIC_WEAK, BiometricChoice.BIOMETRIC_WEAK)
        assertEquals(BiometricManager.Authenticators.DEVICE_CREDENTIAL, BiometricChoice.DEVICE_CREDENTIAL)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED, BiometricChoice.ERROR_USER_CANCELED)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_CANCELED, BiometricChoice.ERROR_CANCELED)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT, BiometricChoice.ERROR_LOCKOUT)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT, BiometricChoice.ERROR_LOCKOUT_PERMANENT)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS, BiometricChoice.ERROR_NONE_ENROLLED)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT, BiometricChoice.ERROR_NO_HARDWARE)
        assertEquals(BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL, BiometricChoice.ERROR_NO_DEVICE_CREDENTIAL)
        assertEquals(BiometricManager.BIOMETRIC_SUCCESS, BiometricChoice.SUCCESS)
        assertEquals(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED, BiometricChoice.ERROR_NONE_ENROLLED)
    }

    @Test
    fun eachAndroidVersionUnlocksItsOwnWay() {
        val prompt = BiometricChoice.Way.Prompt(BiometricChoice.BIOMETRIC_WEAK or BiometricChoice.DEVICE_CREDENTIAL)
        // Android 10: KeyguardManager's screen, never BiometricPrompt with the credential allowed.
        assertEquals(BiometricChoice.Way.KeyguardScreen, BiometricChoice.way(29, deviceSecure = true))
        // Android 11+: fingerprint or class 2 face, and the phone's PIN in the same prompt.
        for (sdk in listOf(30, 33, 36)) assertEquals(prompt, BiometricChoice.way(sdk, deviceSecure = true))
        // No screen lock: the page's UniHub PIN.
        for (sdk in listOf(29, 30, 36)) assertEquals(BiometricChoice.Way.Pin, BiometricChoice.way(sdk, deviceSecure = false))
    }

    @Test
    fun theMethodFollowsTheScreenLockAndBiometrics() {
        assertEquals("available", BiometricChoice.biometric(BiometricChoice.SUCCESS))
        assertEquals("not_enrolled", BiometricChoice.biometric(BiometricChoice.ERROR_NONE_ENROLLED))
        assertEquals("none", BiometricChoice.biometric(BiometricChoice.ERROR_NO_HARDWARE))
        assertEquals("none", BiometricChoice.biometric(BiometricChoice.ERROR_HW_UNAVAILABLE))
        assertEquals("biometric", BiometricChoice.method(deviceSecure = true, biometric = "available"))
        assertEquals("device_credential", BiometricChoice.method(deviceSecure = true, biometric = "not_enrolled"))
        assertEquals("device_credential", BiometricChoice.method(deviceSecure = true, biometric = "none"))
        // Android 10 keeps an enrolled fingerprint without a screen lock; it cannot unlock alone.
        assertEquals("pin", BiometricChoice.method(deviceSecure = false, biometric = "available"))
    }

    @Test
    fun promptErrorsBecomeThePagesAnswers() {
        for (code in listOf(BiometricChoice.ERROR_USER_CANCELED, BiometricChoice.ERROR_CANCELED, BiometricChoice.ERROR_NEGATIVE_BUTTON, 3, 99)) {
            assertEquals("code $code", "cancelled", BiometricChoice.result(code))
        }
        assertEquals("lockout", BiometricChoice.result(BiometricChoice.ERROR_LOCKOUT))
        assertEquals("lockout", BiometricChoice.result(BiometricChoice.ERROR_LOCKOUT_PERMANENT))
        for (code in listOf(BiometricChoice.ERROR_HW_UNAVAILABLE, BiometricChoice.ERROR_NONE_ENROLLED, BiometricChoice.ERROR_NO_HARDWARE,
            BiometricChoice.ERROR_NO_DEVICE_CREDENTIAL, BiometricChoice.ERROR_SECURITY_UPDATE_REQUIRED)) {
            assertEquals("code $code", "unavailable", BiometricChoice.result(code))
        }
    }

    @Test
    fun thePagesConfigurationIsCheckedAndNormalised() {
        fun parse(json: String) = AppLock.parse(JSONObject(json))
        val whole = parse("""{"scope":["mail","app"],"relockAfterMs":0,"onDeviceLock":false,"blockScreenshots":true}""")!!
        assertEquals(setOf("app"), whole.first.scope)
        assertEquals(0L, whole.first.relockAfterMs)
        assertEquals(false, whole.first.onDeviceLock)
        assertEquals(true, whole.second)
        val modules = parse("""{"scope":["mail","contacts"],"relockAfterMs":300000}""")!!
        assertEquals(setOf("mail", "contacts"), modules.first.scope)
        assertEquals(true, modules.first.onDeviceLock)
        assertEquals(false, modules.second)
        assertEquals(emptySet<String>(), parse("""{"on":false,"scope":["app"],"relockAfterMs":60000}""")!!.first.scope)
        assertEquals("on without a scope locks the whole app", setOf("app"), parse("""{"on":true,"relockAfterMs":60000}""")!!.first.scope)
        // Screenshots follow the policy also with the lock off.
        assertEquals(true, parse("""{"scope":[],"blockScreenshots":true}""")!!.second)
        assertNull("an unknown area", parse("""{"scope":["files"]}"""))
        assertNull("a negative time", parse("""{"scope":["app"],"relockAfterMs":-1}"""))
        assertNull("not a number", parse("""{"scope":["app"],"relockAfterMs":"soon"}"""))
    }
}
