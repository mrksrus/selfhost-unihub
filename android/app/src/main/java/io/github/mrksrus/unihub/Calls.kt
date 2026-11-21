package io.github.mrksrus.unihub

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import org.json.JSONObject

/** A notification of kind `call`: a call rings on this phone, or stops ringing. */
data class CallMessage(val id: String, val ring: Boolean, val name: String) {
    companion object {
        private val ID = Regex("[A-Za-z0-9-]{1,64}")

        fun parse(payload: JSONObject): CallMessage? {
            if (payload.optString("kind") != "call") return null
            val call = payload.optJSONObject("call") ?: return null
            val id = call.optString("id").takeIf { ID.matches(it) } ?: return null
            val ring = when (call.optString("event")) {
                "ring" -> true
                "end" -> false
                else -> return null
            }
            return CallMessage(id, ring, payload.optString("title").take(120))
        }
    }
}

/**
 * Voice calls through Android's call handling (Telecom): the app is its own
 * call provider (a self-managed phone account), so Android counts a UniHub
 * call like a phone call (one at a time, headsets, cars). CallService holds
 * the call; CallActivity shows the server's /call page, which runs the call.
 */
object Calls {
    private const val TAG = "UniHubCalls"
    const val EXTRA_ID = "callId"
    const val EXTRA_NAME = "callName"
    const val EXTRA_ORIGIN = "callOrigin"

    private val main = Handler(Looper.getMainLooper())

    fun account(context: Context) = PhoneAccountHandle(ComponentName(context, CallService::class.java), "unihub")

    /** Hands a `call` message to Telecom. Any thread. */
    fun receive(context: Context, origin: String, message: CallMessage, locked: Boolean) {
        main.post { ring(context, origin, message, locked) }
    }

    private fun ring(context: Context, origin: String, message: CallMessage, locked: Boolean) {
        if (!message.ring) {
            CallService.ended(message.id, android.telecom.DisconnectCause.REMOTE)
            return
        }
        if (CallService.known(message.id)) return
        val name = if (locked || message.name.isEmpty()) context.getString(R.string.call_incoming) else message.name
        try {
            val telecom = context.getSystemService(TelecomManager::class.java)
            val handle = account(context)
            telecom.registerPhoneAccount(PhoneAccount.builder(handle, context.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build())
            val extras = Bundle().apply {
                putString(EXTRA_ID, message.id)
                putString(EXTRA_NAME, name)
                putString(EXTRA_ORIGIN, origin)
            }
            telecom.addNewIncomingCall(handle, Bundle().apply {
                putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, Uri.fromParts("unihub", message.id, null))
                putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, extras)
            })
            // Telecom answers on this thread, after this.
            CallService.expect(message.id)
        } catch (error: RuntimeException) {
            Log.w(TAG, "Telecom refused the call: ${error.javaClass.simpleName}")
        }
    }
}
