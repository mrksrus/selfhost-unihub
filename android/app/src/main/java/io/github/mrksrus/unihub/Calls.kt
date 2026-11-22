package io.github.mrksrus.unihub

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telecom.DisconnectCause
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** A notification of kind `call` (or the open page's hand-over): a call rings on this phone, or stops ringing. */
data class CallMessage(val id: String, val ring: Boolean, val name: String) {
    companion object {
        val ID = Regex("[A-Za-z0-9-]{1,64}")

        fun parse(payload: JSONObject): CallMessage? {
            if (payload.optString("kind") != "call") return null
            val call = payload.optJSONObject("call") ?: return null
            return of(call.optString("id"), call.optString("event"), payload.optString("title"))
        }

        /** The main page's `{type: "call", action: "ring" | "end", id, name}`. */
        fun fromPage(data: JSONObject): CallMessage? = of(data.optString("id"), data.optString("action"), data.optString("name"))

        private fun of(id: String, event: String, name: String): CallMessage? {
            if (!ID.matches(id)) return null
            val ring = when (event) {
                "ring" -> true
                "end" -> false
                else -> return null
            }
            return CallMessage(id, ring, name.take(120))
        }
    }
}

/** What the call screen's page reports: `{type: "call", state, id, muted}`; state "none" once it shows no call. */
data class PageReport(val state: String, val id: String?, val muted: Boolean) {
    companion object {
        private val STATES = setOf("calling", "ringing", "connecting", "active", "reconnecting", "ended", "none")

        fun parse(data: JSONObject): PageReport? {
            if (data.optString("type") != "call") return null
            val state = data.optString("state").takeIf { it in STATES } ?: return null
            val id = if (data.isNull("id")) null else data.optString("id").takeIf { CallMessage.ID.matches(it) }
            return PageReport(state, id, data.optBoolean("muted", false))
        }
    }
}

/** What the call's notification says, from what the app and the page know of the call. */
enum class CallWords { OPEN_TO_TALK, CALLING, CONNECTING, ONGOING, RECONNECTING;
    companion object {
        // Answered by Telecom (a headset, a car) but not yet at the server: no sound flows until the call screen opens.
        fun of(outgoing: Boolean, atServer: Boolean, state: String): CallWords = when {
            !outgoing && !atServer -> OPEN_TO_TALK
            state == "calling" -> CALLING
            state == "connecting" -> CONNECTING
            state == "reconnecting" -> RECONNECTING
            else -> ONGOING
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

    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** Endpoint types of Core-Telecom's CallEndpointCompat, as the page names them. */
    fun routeKind(type: Int): String? = when (type) {
        1 -> "earpiece"
        2 -> "bluetooth"
        3 -> "wired"
        4 -> "speaker"
        else -> null
    }

    /**
     * Whether this app can take a call: the WebView can talk to the call page
     * (Android 10's original WebView cannot), a microphone service type exists
     * (Android 11) and the phone has Android's call handling. What puts
     * UniHubCalls in the main page's user agent.
     */
    fun supported(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            context.packageManager.hasSystemFeature(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) PackageManager.FEATURE_TELECOM
                else @Suppress("DEPRECATION") PackageManager.FEATURE_CONNECTION_SERVICE)

    /** The lock report's `calls`: servers then ring this app by its notification connection while it is closed. */
    fun ringsWhileClosed(context: Context): Boolean = RINGS_WHILE_CLOSED && supported(context)

    private const val RINGS_WHILE_CLOSED = false

    /** Hands a `call` message to Telecom. Any thread. */
    fun receive(context: Context, origin: String, message: CallMessage, locked: Boolean) {
        val app = context.applicationContext
        main.post {
            if (!message.ring) {
                CallService.stopRinging(message.id)
            } else if (supported(app)) {
                val name = if (locked || message.name.isEmpty()) app.getString(R.string.call_incoming) else message.name
                CallService.ring(app, origin, message.id, name)
            }
        }
    }
}
