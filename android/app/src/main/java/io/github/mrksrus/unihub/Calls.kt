package io.github.mrksrus.unihub

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.telecom.DisconnectCause
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
 * Voice calls through Android's call handling (Telecom, by Jetpack's
 * Core-Telecom library), so Android counts a UniHub call like a phone call
 * (one at a time, headsets, cars). CallService holds the call; CallActivity
 * shows the server's /call page, which runs the call.
 */
object Calls {
    const val EXTRA_ID = "callId"

    private val main = Handler(Looper.getMainLooper())

    /** Hands a `call` message to Telecom. Any thread. */
    fun receive(context: Context, origin: String, message: CallMessage, locked: Boolean) {
        val app = context.applicationContext
        main.post {
            if (!message.ring) {
                CallService.ended(message.id, DisconnectCause.REMOTE)
            } else {
                val name = if (locked || message.name.isEmpty()) app.getString(R.string.call_incoming) else message.name
                CallService.ring(app, origin, message.id, name)
            }
        }
    }
}
