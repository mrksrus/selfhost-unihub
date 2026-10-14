package io.github.mrksrus.unihub

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView

/**
 * The app is a thin shell: it opens the user's UniHub server in a WebView, so
 * every screen comes from the server and always matches its version. Native
 * code only covers what a browser tab cannot do (see WebBridge).
 */
class MainActivity : Activity() {
    private var origin: String? = null
    private var root: FrameLayout? = null
    private var webView: WebView? = null
    private var errorView: View? = null
    private var bridge: WebBridge? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = ServerAddress.saved(this)
        if (saved != null) showWeb(saved, savedInstanceState) else showConnect()
        connectRequest(intent)?.takeIf { it != saved && savedInstanceState == null }?.let(::confirmConnect)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        connectRequest(intent)?.takeIf { it != origin }?.let(::confirmConnect)
    }

    /** The server from an "Open in app" link: unihub://connect?server=https://… */
    private fun connectRequest(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (data.scheme != "unihub" || data.host != "connect") return null
        return ServerAddress.parse(data.getQueryParameter("server"))
    }

    // A link can come from any website, so a new server is always confirmed.
    // Cancel keeps whatever is open behind the dialog.
    private fun confirmConnect(requested: String) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.connect_confirm_title, ServerAddress.host(requested)))
            .setMessage(R.string.connect_confirm_body)
            .setPositiveButton(R.string.connect_confirm_ok) { _, _ ->
                ServerAddress.save(this, requested)
                showWeb(requested, null)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ── First run: which server ────────────────────────────────────────

    private fun showConnect(prefill: String? = null) {
        destroyWeb()
        setContentView(R.layout.activity_connect)
        applyInsets(findViewById(R.id.connect_root))
        val input = findViewById<EditText>(R.id.server_input)
        val error = findViewById<TextView>(R.id.server_error)
        val button = findViewById<Button>(R.id.connect_button)
        prefill?.let { input.setText(ServerAddress.host(it)) }

        fun submit() {
            val candidate = ServerAddress.parse(input.text.toString())
            if (candidate == null) {
                error.setText(R.string.connect_invalid)
                error.visibility = View.VISIBLE
                return
            }
            error.visibility = View.GONE
            button.isEnabled = false
            button.setText(R.string.connect_checking)
            Thread {
                val result = ServerAddress.check(candidate)
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    button.isEnabled = true
                    button.setText(R.string.connect_button)
                    when (result) {
                        ServerAddress.Check.Ok -> {
                            ServerAddress.save(this, candidate)
                            showWeb(candidate, null)
                        }
                        ServerAddress.Check.NotUniHub -> {
                            error.setText(R.string.connect_not_unihub)
                            error.visibility = View.VISIBLE
                        }
                        ServerAddress.Check.Unreachable -> {
                            error.setText(R.string.connect_unreachable)
                            error.visibility = View.VISIBLE
                        }
                    }
                }
            }.start()
        }

        button.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_GO || enter) { submit(); true } else false
        }
    }

    private fun changeServer() {
        val current = origin
        ServerAddress.clear(this)
        showConnect(prefill = current)
    }

    // ── The server's pages ─────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb(server: String, savedInstanceState: Bundle?) {
        destroyWeb()
        origin = server
        val frame = FrameLayout(this)
        val web = WebView(this)
        frame.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(frame)
        applyInsets(frame)
        root = frame
        webView = web

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            // The page reads this to know it runs in the app (src/lib/platform.ts).
            userAgentString = "$userAgentString UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)

        val pageBridge = WebBridge(this, server, onChangeServer = ::changeServer)
        pageBridge.attach(web)
        bridge = pageBridge

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url.toString()
                if (ServerAddress.sameOrigin(server, url)) return false
                WebBridge.openExternal(this@MainActivity, url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                hideError()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError(server)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE)
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsAudio = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
                if (!wantsAudio || !ServerAddress.sameOrigin(server, request.origin.toString())) {
                    request.deny()
                    return
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingPermission?.deny()
                    pendingPermission = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE)
                }
            }
        }

        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            pageBridge.download(url, URLUtil.guessFileName(url, contentDisposition, mimeType), userAgent)
        }

        if (savedInstanceState?.let { web.restoreState(it) } == null) web.loadUrl(server)
    }

    private fun destroyWeb() {
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        bridge = null
        errorView = null
        root = null
        origin = null
    }

    private fun showError(server: String) {
        val frame = root ?: return
        if (errorView != null) return
        val view = layoutInflater.inflate(R.layout.view_error, frame, false)
        view.findViewById<TextView>(R.id.error_title).text = getString(R.string.error_title, ServerAddress.host(server))
        view.findViewById<Button>(R.id.error_retry).setOnClickListener { webView?.reload() }
        view.findViewById<Button>(R.id.error_change).setOnClickListener { changeServer() }
        frame.addView(view)
        errorView = view
    }

    private fun hideError() {
        errorView?.let { root?.removeView(it) }
        errorView = null
    }

    // From Android 15 on, an app targeting it is drawn behind the status and
    // navigation bars. Padding keeps UniHub's pages (and the keyboard) clear of
    // them. Older versions keep the content between the bars by themselves.
    private fun applyInsets(view: View) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return
        view.setOnApplyWindowInsetsListener { target, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            target.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        view.requestApplyInsets()
    }

    // ── Results, back, lifecycle ───────────────────────────────────────

    @Deprecated("Activity result API needs AndroidX; the framework call is enough here.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != REQUEST_MICROPHONE) return
        val request = pendingPermission ?: return
        pendingPermission = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            request.deny()
        }
    }

    // The app targets Android 15 without opting in to predictive back, so the
    // classic callback still runs on every supported version.
    @Deprecated("See the comment above.")
    override fun onBackPressed() {
        val web = webView
        if (web != null && errorView == null && web.canGoBack()) {
            web.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        destroyWeb()
        super.onDestroy()
    }

    private companion object {
        const val REQUEST_FILE = 1
        const val REQUEST_MICROPHONE = 2
    }
}
