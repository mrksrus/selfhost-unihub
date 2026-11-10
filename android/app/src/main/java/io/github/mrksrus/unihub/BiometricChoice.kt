package io.github.mrksrus.unihub

/**
 * How BiometricAuth unlocks on each Android version, and what its answers
 * mean, without Android classes (BiometricChoiceTest).
 */
object BiometricChoice {
    // android.hardware.biometrics.BiometricManager.Authenticators (API 30).
    const val BIOMETRIC_WEAK = 0x00FF
    const val DEVICE_CREDENTIAL = 0x8000

    // BiometricManager.canAuthenticate and BiometricPrompt error codes.
    const val SUCCESS = 0
    const val ERROR_HW_UNAVAILABLE = 1
    const val ERROR_CANCELED = 5
    const val ERROR_LOCKOUT = 7
    const val ERROR_LOCKOUT_PERMANENT = 9
    const val ERROR_USER_CANCELED = 10
    const val ERROR_NONE_ENROLLED = 11
    const val ERROR_NO_HARDWARE = 12
    const val ERROR_NEGATIVE_BUTTON = 13
    const val ERROR_NO_DEVICE_CREDENTIAL = 14
    const val ERROR_SECURITY_UPDATE_REQUIRED = 15

    sealed class Way {
        /** No screen lock on the phone: the page asks for its UniHub PIN. */
        object Pin : Way()
        /** Android 11+: BiometricPrompt with these authenticators (the phone's PIN, pattern or password inside the prompt). */
        data class Prompt(val authenticators: Int) : Way()
        /**
         * Android 10: KeyguardManager's credential screen, which offers the
         * fingerprint and "Use PIN" itself. Android 10's BiometricPrompt with
         * the device credential allowed cancels as soon as "Use PIN" is
         * tapped (the 0.29 CI spike: 17 of 18 times), so it is not used.
         */
        object KeyguardScreen : Way()
    }

    fun way(sdk: Int, deviceSecure: Boolean): Way = when {
        !deviceSecure -> Way.Pin
        sdk >= 30 -> Way.Prompt(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
        else -> Way.KeyguardScreen
    }

    /** What BiometricManager says about the phone's biometrics: available, not_enrolled or none. */
    fun biometric(status: Int) = when (status) {
        SUCCESS -> "available"
        ERROR_NONE_ENROLLED -> "not_enrolled"
        else -> "none"
    }

    /** The method the page shows: the phone's biometrics, its PIN (or pattern, password), or a UniHub PIN without a screen lock. */
    fun method(deviceSecure: Boolean, biometric: String) = when {
        !deviceSecure -> "pin"
        biometric == "available" -> "biometric"
        else -> "device_credential"
    }

    /** The page's answer for a BiometricPrompt error. */
    fun result(error: Int) = when (error) {
        ERROR_LOCKOUT, ERROR_LOCKOUT_PERMANENT -> "lockout"
        ERROR_HW_UNAVAILABLE, ERROR_NONE_ENROLLED, ERROR_NO_HARDWARE, ERROR_NO_DEVICE_CREDENTIAL, ERROR_SECURITY_UPDATE_REQUIRED -> "unavailable"
        else -> "cancelled"
    }
}
