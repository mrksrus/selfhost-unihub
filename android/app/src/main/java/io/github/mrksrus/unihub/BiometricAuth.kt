package io.github.mrksrus.unihub

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import org.json.JSONObject

/**
 * Unlocking with the phone's own lock: fingerprint, face or its PIN, pattern
 * or password, through the framework's prompt (no androidx.biometric, so
 * MainActivity stays a plain Activity). BiometricChoice picks the way per
 * Android version. One prompt at a time; a newer request answers the older
 * one `cancelled`.
 */
class BiometricAuth(private val activity: Activity) {
    private var pending: ((String) -> Unit)? = null
    private var cancel: CancellationSignal? = null
    // Android 10's credential screen is open; its result answers the newest request.
    private var screenOpen = false

    private fun deviceSecure() = activity.getSystemService(KeyguardManager::class.java).isDeviceSecure

    private fun biometricStatus(): Int {
        val manager = activity.getSystemService(BiometricManager::class.java) ?: return BiometricChoice.ERROR_NO_HARDWARE
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
        } else {
            @Suppress("DEPRECATION")
            manager.canAuthenticate()
        }
    }

    /** The page's `method` answer: method, biometric, deviceSecure and what the app can do. */
    fun method(): JSONObject {
        val secure = deviceSecure()
        val biometric = BiometricChoice.biometric(biometricStatus())
        return JSONObject()
            .put("method", BiometricChoice.method(secure, biometric))
            .put("biometric", biometric)
            .put("deviceSecure", secure)
            .put("capabilities", capabilities())
    }

    /**
     * Asks the phone's lock. [done] gets ok, cancelled, lockout, unavailable,
     * or pin when the phone has no screen lock (the page asks for its own PIN).
     */
    fun authenticate(title: String, subtitle: String?, done: (String) -> Unit) {
        if (screenOpen) {
            pending?.invoke("cancelled")
            pending = done
            return
        }
        finish("cancelled")
        when (val way = BiometricChoice.way(Build.VERSION.SDK_INT, deviceSecure())) {
            BiometricChoice.Way.Pin -> done("pin")
            BiometricChoice.Way.KeyguardScreen -> {
                @Suppress("DEPRECATION")
                val intent = activity.getSystemService(KeyguardManager::class.java).createConfirmDeviceCredentialIntent(title, subtitle)
                if (intent == null) {
                    done("pin")
                    return
                }
                pending = done
                try {
                    @Suppress("DEPRECATION")
                    activity.startActivityForResult(intent, REQUEST_CREDENTIAL)
                    screenOpen = true
                } catch (_: Exception) {
                    finish("unavailable")
                }
            }
            is BiometricChoice.Way.Prompt -> prompt(way.authenticators, title, subtitle, done)
        }
    }

    private fun prompt(authenticators: Int, title: String, subtitle: String?, done: (String) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return done("unavailable")
        val builder = BiometricPrompt.Builder(activity)
            .setTitle(title)
            .setAllowedAuthenticators(authenticators)
            // Face unlock opens without a second tap.
            .setConfirmationRequired(false)
        subtitle?.let(builder::setSubtitle)
        val signal = CancellationSignal()
        pending = done
        cancel = signal
        try {
            builder.build().authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (cancel === signal) finish("ok")
                }

                // A finger it did not recognise: the prompt stays and says so.
                override fun onAuthenticationFailed() {}

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (cancel === signal) finish(BiometricChoice.result(errorCode))
                }
            })
        } catch (_: Exception) {
            finish("unavailable")
        }
    }

    /** MainActivity hands over the credential screen's result (Android 10). */
    fun onActivityResult(requestCode: Int, resultCode: Int): Boolean {
        if (requestCode != REQUEST_CREDENTIAL) return false
        screenOpen = false
        finish(if (resultCode == Activity.RESULT_OK) "ok" else "cancelled")
        return true
    }

    /** The activity goes away: an open prompt answers cancelled. */
    fun close() {
        screenOpen = false
        finish("cancelled")
    }

    private fun finish(result: String) {
        val answer = pending ?: return
        pending = null
        cancel?.let { signal -> cancel = null; if (result != "ok") signal.cancel() }
        answer(result)
    }

    companion object {
        const val REQUEST_CREDENTIAL = 40

        /** What the app can do on this phone, for the device record (DeviceCapabilities). */
        fun capabilities(): JSONObject = JSONObject()
            .put("secureWindow", true)
            .put("hideRecents", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            .put("deviceLockSignal", true)
    }
}
