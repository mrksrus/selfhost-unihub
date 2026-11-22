package io.github.mrksrus.unihub

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.telecom.DisconnectCause
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.net.URLEncoder

/**
 * The call screen: the server's /call page in a WebView of its own (its user
 * agent says UniHubCallScreen), over the lock screen, for as long as the call
 * lasts. The page runs the call's sound and connection. It reports the call
 * (`{type: "call", state, id, muted}`, the first report saying it is ready),
 * asks for a route (`{type: "call", action: "route", route}`) or for the app
 * (`{type: "call", action: "open", path}`); the app tells it what the person
 * did natively (`{type: "call", command: "answer" | "decline" | "hangUp" |
 * "start" | "mute", …}`) and the routes there are (`{type: "call", routes}`).
 * No address answers or places a call by itself. The screen closes when the
 * page shows no call any more; Back ends the call.
 */
class CallActivity : Activity() {
    private var webView: WebView? = null
    private var id: String? = null
    private var page: JavaScriptReplyProxy? = null
    private var proximity: PowerManager.WakeLock? = null
    private val listener: (CallService.Call, JSONObject?) -> Unit = { call, message ->
        if (call.id == id) {
            if (message == null) callEnded() else post(message)
            nearEar(call)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Chat is never captured, and a call is part of Chat.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val call = CallService.of(intent.getStringExtra(Calls.EXTRA_ID))
        if (call == null || ServerAddress.saved(this) != call.origin || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            CallService.dismissStale(this)
            finish()
            return
        }
        id = call.id
        CallService.toPage = listener
        // From a visible screen the service may take the microphone, which a headset's answer could not.
        if (call.active) CallService.foreground(this, call.id)
        if (intent.getBooleanExtra(EXTRA_ANSWER, false)) CallService.answer(call.id)
        showCall(call)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val callId = intent.getStringExtra(Calls.EXTRA_ID)
        // The next call while the last one's ending still shows: its own screen.
        if (callId != null && callId != id) {
            setIntent(intent)
            recreate()
            return
        }
        if (callId != null && intent.getBooleanExtra(EXTRA_ANSWER, false)) CallService.answer(callId)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showCall(call: CallService.Call) {
        val origin = call.origin
        val web = WebView(this)
        webView = web
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            // The other side's voice plays without a tap.
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) UniHubBridge/${MainActivity.BRIDGE_LEVEL} UniHubCallScreen"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // The call keeps its renderer while the screen is off.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        WebViewCompat.addWebMessageListener(web, WebBridge.NAME, setOf(origin)) { _, message, sourceOrigin, isMainFrame, reply ->
            if (!isMainFrame || !ServerAddress.sameOrigin(origin, sourceOrigin.toString())) return@addWebMessageListener
            val data = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: org.json.JSONException) { return@addWebMessageListener }
            if (data.optString("type") != "call") return@addWebMessageListener
            when (data.optString("action")) {
                "route" -> CallService.of(id)?.route(data.optString("route"))
                "open" -> openApp(origin, data.optString("path"))
                else -> PageReport.parse(data)?.let { report -> pageReported(reply, report) }
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.isForMainFrame && !onCallPage(origin, request.url.toString())

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (!onCallPage(origin, url)) finish()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                id?.let { CallService.ended(it, DisconnectCause.ERROR, server = true, failed = true) }
                finish()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            // Only the microphone, only for the server; Android cannot ask for it over the lock screen.
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.resources.toList() != listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE) || !ServerAddress.sameOrigin(origin, request.origin.toString())) {
                    request.deny()
                } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    CallService.of(id)?.microphoneRefused = true
                    request.deny()
                }
            }
        }

        web.loadUrl("$origin/call" + (call.serverId?.let { "?id=" + URLEncoder.encode(it, "UTF-8") } ?: ""))
    }

    private fun pageReported(reply: JavaScriptReplyProxy, report: PageReport) {
        val callId = id ?: return
        val first = page == null
        page = reply
        val call = CallService.of(callId)
        if (call == null) {
            if (report.state == "none") finish()
            return
        }
        // Ready: what the person already did natively, and the routes.
        if (first) {
            if (call.outgoing && call.serverId == null) {
                post(JSONObject().put("type", "call").put("command", "start").put("userId", call.peer).put("name", call.name))
            } else if (call.answered && !call.atServer) {
                post(JSONObject().put("type", "call").put("command", "answer").put("id", call.serverId))
            }
            post(JSONObject().put("type", "call").put("routes", call.routes()))
            if (call.telecomMuted) post(JSONObject().put("type", "call").put("command", "mute").put("muted", true))
        }
        CallService.reported(callId, report)
        nearEar(call)
    }

    private fun post(message: JSONObject) {
        try {
            page?.postMessage(message.toString())
        } catch (_: Exception) {
            // The page is gone.
        }
    }

    // The page hears the end first and shows how it ended; it closes the screen once it shows no call.
    private fun callEnded() {
        proximity?.let { if (it.isHeld) it.release() }
        webView?.postDelayed({ finish() }, CLOSE_AFTER_END_MS)
    }

    /** The screen goes dark at the ear while the earpiece carries the call. */
    private fun nearEar(call: CallService.Call) {
        val wanted = CallService.current === call && call.atServer && call.endpoint?.type == 1
        val lock = proximity ?: getSystemService(PowerManager::class.java)
            .takeIf { it.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) }
            ?.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "UniHub:call")?.also { proximity = it } ?: return
        if (wanted && !lock.isHeld) lock.acquire(4 * 60 * 60_000L)
        if (!wanted && lock.isHeld) lock.release()
    }

    /** "Open chat" or "Open UniHub": Android unlocks first, then the app opens there and locks as always; the call goes on behind it. */
    private fun openApp(origin: String, path: String) {
        if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048) return
        val open = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_NOTIFICATION)
            .putExtra(MainActivity.EXTRA_ORIGIN, origin)
            .putExtra(MainActivity.EXTRA_PATH, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isKeyguardLocked) return startActivity(open)
        keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { startActivity(open) }
        })
    }

    override fun onDestroy() {
        // A second call's screen may have taken it already.
        if (CallService.toPage === listener) CallService.toPage = null
        proximity?.let { if (it.isHeld) it.release() }
        webView?.destroy()
        webView = null
        // Back, or the screen went: the call does not go on without its sound, and the server hears so now.
        id?.let { if (isFinishing) CallService.ended(it, DisconnectCause.LOCAL, server = true) }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ANSWER = "answer"
        // A page that never says it closed (it died): the screen goes anyway.
        private const val CLOSE_AFTER_END_MS = 15_000L

        fun intent(context: Context, id: String, answer: Boolean): Intent =
            Intent(context, CallActivity::class.java)
                .putExtra(Calls.EXTRA_ID, id)
                .putExtra(EXTRA_ANSWER, answer)
                // One intent per call and button, so Android does not merge them.
                .setData(Uri.parse("unihub-call://$id/${if (answer) "answer" else "show"}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        fun onCallPage(origin: String, url: String?): Boolean =
            ServerAddress.sameOrigin(origin, url) && Uri.parse(url).path == "/call"
    }
}
