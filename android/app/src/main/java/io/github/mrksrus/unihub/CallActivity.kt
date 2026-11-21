package io.github.mrksrus.unihub

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
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
 * The call screen: the server's /call page in a WebView of its own, over the
 * lock screen, for as long as the call lasts. The page runs the call's sound
 * and connection and tells the app when the person answers or hangs up
 * (`{type: "call", action: "answer" | "hangUp" | "speaker" | "earpiece"}`);
 * the app tells it the call's state (`{type: "call", state}`). The screen
 * closes when the page leaves /call or the call ends. The main page's
 * WebView is paused in the background, so it cannot hold a call.
 */
class CallActivity : Activity() {
    private var webView: WebView? = null
    private var id: String? = null
    private var page: JavaScriptReplyProxy? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Chat is never captured, and a call is part of Chat.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val call = intent.getStringExtra(Calls.EXTRA_ID)?.let { id -> CallService.current?.takeIf { it.id == id } }
        if (call == null || ServerAddress.saved(this) != call.origin || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            finish()
            return
        }
        id = call.id
        CallService.onState = { callId, state -> if (callId == id) stateChanged(state) }
        if (intent.getBooleanExtra(EXTRA_ANSWER, false)) CallService.answer(this, call.id)
        showCall(call.origin, call.id)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val callId = intent.getStringExtra(Calls.EXTRA_ID)
        if (callId != null && callId == id && intent.getBooleanExtra(EXTRA_ANSWER, false)) CallService.answer(this, callId)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showCall(origin: String, callId: String) {
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
            userAgentString = "$userAgentString UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) UniHubBridge/${MainActivity.BRIDGE_LEVEL}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // The call keeps its renderer while the screen is off.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        WebViewCompat.addWebMessageListener(web, WebBridge.NAME, setOf(origin)) { _, message, sourceOrigin, isMainFrame, reply ->
            if (!isMainFrame || !ServerAddress.sameOrigin(origin, sourceOrigin.toString())) return@addWebMessageListener
            val data = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: org.json.JSONException) { return@addWebMessageListener }
            if (data.optString("type") != "call") return@addWebMessageListener
            page = reply
            when (data.optString("action")) {
                "answer" -> CallService.answer(this, callId)
                "hangUp" -> CallService.ended(callId, if (CallService.state(callId) == "ringing") DisconnectCause.REJECTED else DisconnectCause.LOCAL)
                "speaker" -> CallService.current?.takeIf { it.id == callId }?.route(speaker = true)
                "earpiece" -> CallService.current?.takeIf { it.id == callId }?.route(speaker = false)
            }
            tell(CallService.state(callId))
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.isForMainFrame && !onCallPage(origin, request.url.toString())

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (!onCallPage(origin, url)) finish()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                CallService.ended(callId, DisconnectCause.ERROR)
                finish()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            // Only the microphone, only for the server; Android cannot ask for it over the lock screen.
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.resources.toList() == listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
                    ServerAddress.sameOrigin(origin, request.origin.toString()) &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    request.deny()
                }
            }
        }

        web.loadUrl("$origin/call?id=" + URLEncoder.encode(callId, "UTF-8"))
    }

    private fun tell(state: String) {
        try {
            page?.postMessage(JSONObject().put("type", "call").put("state", state).toString())
        } catch (_: Exception) {
            // The page is gone.
        }
    }

    // The page hears the end first, so it can tell the server; then the screen closes.
    private fun stateChanged(state: String) {
        tell(state)
        if (state == "ended") webView?.postDelayed({ finish() }, END_DELAY_MS)
    }

    override fun onDestroy() {
        if (id != null) CallService.onState = null
        webView?.destroy()
        webView = null
        // The screen went away (back, or the page left /call): the call does not go on without its sound.
        id?.let { if (isFinishing) CallService.ended(it, DisconnectCause.LOCAL) }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ANSWER = "answer"
        private const val END_DELAY_MS = 1_000L

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
