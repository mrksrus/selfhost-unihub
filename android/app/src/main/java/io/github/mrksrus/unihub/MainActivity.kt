package io.github.mrksrus.unihub

import android.Manifest
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
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
import android.widget.Toast

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
    // Each connect check and screen change gets a new number; an older check's
    // answer is ignored.
    private var screenGeneration = 0
    private var contactsChecking = false
    // An offer that came in while a check was running is looked at again.
    private var contactsOfferPending = false
    private var contactsCheckedAt = 0L
    private val contactsRecheck = Handler(Looper.getMainLooper())
    private var contactsServer: String? = null
    // Set when Android's settings opened the app to add the account.
    private var contactsResponse: AccountAuthenticatorResponse? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = ServerAddress.saved(this)
        if (saved != null) PageTheme.saved(this)?.let { (dark, background) -> applyTheme(dark, background) }
        if (saved != null) showWeb(saved, savedInstanceState) else showConnect()
        connectRequest(intent)?.takeIf { it != saved && savedInstanceState == null }?.let(::confirmConnect)
        if (savedInstanceState == null && intent?.action == ACTION_SHOW_CONTACTS) contactsFromSettings(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        connectRequest(intent)?.takeIf { it != origin }?.let(::confirmConnect)
        if (intent.action == ACTION_SHOW_CONTACTS) contactsFromSettings(intent)
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
                useServer(requested)
                showWeb(requested, null)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ── First run: which server ────────────────────────────────────────

    private fun showConnect(prefill: String? = null) {
        destroyWeb()
        applyTheme(PageTheme.deviceIsDark(this), getColor(R.color.background))
        setContentView(R.layout.activity_connect)
        applyInsets(findViewById(R.id.connect_root))
        val input = findViewById<EditText>(R.id.server_input)
        val error = findViewById<TextView>(R.id.server_error)
        val button = findViewById<Button>(R.id.connect_button)
        prefill?.let { input.setText(ServerAddress.host(it)) }

        fun submit() {
            if (!button.isEnabled) return
            val candidate = ServerAddress.parse(input.text.toString())
            if (candidate == null) {
                error.setText(R.string.connect_invalid)
                error.visibility = View.VISIBLE
                return
            }
            error.visibility = View.GONE
            button.isEnabled = false
            button.setText(R.string.connect_checking)
            val attempt = ++screenGeneration
            Thread {
                val result = ServerAddress.check(candidate)
                runOnUiThread {
                    if (isFinishing || isDestroyed || attempt != screenGeneration) return@runOnUiThread
                    button.isEnabled = true
                    button.setText(R.string.connect_button)
                    when (result) {
                        ServerAddress.Check.Ok -> {
                            useServer(candidate)
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

    // Contacts on the phone belong to one server; another server's are removed.
    private fun useServer(server: String) {
        ServerAddress.save(this, server)
        if (ContactsSync.account(this)?.let { ContactsSync.origin(this, it) } != server) ContactsSync.turnOff(this)
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
        ContactsSync.webViewCreating(this)
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

        PageTheme.saved(this)?.let { (_, background) -> web.setBackgroundColor(background) }
        val pageBridge = WebBridge(this, server, onChangeServer = ::changeServer, onTheme = { dark, background ->
            PageTheme.save(this, dark, background)
            applyTheme(dark, background)
        })
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
                pageBridge.cancelFiles()
            }

            // Also after signing in, which changes the page without loading one.
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                offerContacts(server)
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
        screenGeneration++
        contactsRecheck.removeCallbacksAndMessages(null)
        contactsOfferPending = false
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
            ContactsSync.webViewDestroyed(this)
        }
        webView = null
        bridge?.close()
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

    // ── Contacts on the phone (ContactsSync) ───────────────────────────

    // Once per server, when the person is signed in and has contacts. Checks
    // at most every few seconds; one skipped for that runs later, so signing
    // in right after a check still brings the question.
    private fun offerContacts(server: String) {
        if (ContactsSync.account(this) != null || ContactsSync.offered(this, server)) return
        if (contactsChecking) {
            contactsOfferPending = true
            return
        }
        val now = SystemClock.elapsedRealtime()
        val wait = if (contactsCheckedAt == 0L) 0L else contactsCheckedAt + CONTACTS_CHECK_INTERVAL_MS - now
        if (wait > 0) {
            contactsRecheck.removeCallbacksAndMessages(null)
            contactsRecheck.postDelayed({ if (origin == server) offerContacts(server) }, wait)
            return
        }
        contactsCheckedAt = now
        checkContacts(server) { offer ->
            if (offer == ContactsSync.Offer.Ready && ContactsSync.account(this) == null && !ContactsSync.offered(this, server)) {
                askContacts(server)
            }
        }
    }

    // "Add account" in Android's settings.
    private fun contactsFromSettings(intent: Intent) {
        finishContacts(null)
        contactsResponse = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, AccountAuthenticatorResponse::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE)
        }
        val server = ServerAddress.saved(this)
        val existing = ContactsSync.account(this)
        when {
            server == null -> {
                toast(R.string.contacts_connect_first)
                finishContacts(null)
            }
            existing != null && ContactsSync.origin(this, existing) == server -> {
                toast(R.string.contacts_already_on)
                finishContacts(existing)
            }
            else -> checkContacts(server) { offer ->
                when (offer) {
                    ContactsSync.Offer.SignedOut -> { toast(R.string.contacts_sign_in_first); finishContacts(null) }
                    ContactsSync.Offer.Unavailable -> { toast(R.string.contacts_unavailable); finishContacts(null) }
                    else -> askContacts(server)
                }
            }
        }
    }

    private fun checkContacts(server: String, then: (ContactsSync.Offer) -> Unit) {
        contactsChecking = true
        val generation = screenGeneration
        Thread {
            val offer = ContactsSync.check(this, server)
            runOnUiThread {
                contactsChecking = false
                if (isFinishing || isDestroyed) {
                    finishContacts(null)
                    return@runOnUiThread
                }
                if (generation != screenGeneration || ServerAddress.saved(this) != server) finishContacts(null) else then(offer)
                // Also after a check for a server the app has left.
                if (contactsOfferPending) {
                    contactsOfferPending = false
                    origin?.let(::offerContacts)
                }
            }
        }.start()
    }

    private fun askContacts(server: String) {
        ContactsSync.markOffered(this, server)
        AlertDialog.Builder(this)
            .setTitle(R.string.contacts_title)
            .setMessage(R.string.contacts_body)
            .setPositiveButton(R.string.contacts_ok) { _, _ ->
                if (ContactsSync.hasPermission(this)) {
                    showContacts(server)
                } else {
                    contactsServer = server
                    requestPermissions(ContactsSync.PERMISSIONS, REQUEST_CONTACTS)
                }
            }
            .setNegativeButton(R.string.contacts_not_now) { _, _ -> finishContacts(null) }
            .setOnCancelListener { finishContacts(null) }
            .show()
    }

    private fun showContacts(server: String) {
        if (ServerAddress.saved(this) != server) {
            finishContacts(null)
            return
        }
        val account = ContactsSync.turnOn(this, server)
        toast(R.string.contacts_on)
        finishContacts(account)
    }

    private fun finishContacts(account: Account?) {
        val response = contactsResponse ?: return
        contactsResponse = null
        if (account != null) {
            response.onResult(Bundle().apply {
                putString(AccountManager.KEY_ACCOUNT_NAME, account.name)
                putString(AccountManager.KEY_ACCOUNT_TYPE, account.type)
            })
        } else {
            response.onError(AccountManager.ERROR_CODE_CANCELED, "Not added")
        }
    }

    private fun toast(text: Int) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    // UniHub has its own light/dark setting, so the bars follow the page (its
    // ThemeProvider reports it) rather than the phone. Until the first page has
    // loaded, the last theme it reported is used.
    private fun applyTheme(dark: Boolean, background: Int) {
        window.setBackgroundDrawable(ColorDrawable(background))
        webView?.setBackgroundColor(background)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            // This runs before setContentView. window.insetsController throws
            // until the window has its views; reading decorView creates them.
            window.decorView.windowInsetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        } else {
            applyLegacyBarIcons(dark)
        }
    }

    // Android 10 and 11 (11 ignores the controller while the theme sets the flags).
    @Suppress("DEPRECATION")
    private fun applyLegacyBarIcons(dark: Boolean) {
        val light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val decor = window.decorView
        decor.systemUiVisibility = if (dark) decor.systemUiVisibility and light.inv() else decor.systemUiVisibility or light
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
        if (requestCode == REQUEST_CONTACTS) {
            val server = contactsServer ?: return
            contactsServer = null
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                showContacts(server)
            } else {
                toast(R.string.contacts_denied)
                finishContacts(null)
            }
            return
        }
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

    // Leaving the app is when contacts were most likely edited, or the
    // person signed out: the phone's copy follows.
    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
        ContactsSync.requestSync(this)
    }

    override fun onDestroy() {
        destroyWeb()
        finishContacts(null)
        super.onDestroy()
    }

    companion object {
        const val ACTION_SHOW_CONTACTS = "io.github.mrksrus.unihub.SHOW_CONTACTS"
        private const val REQUEST_FILE = 1
        private const val REQUEST_MICROPHONE = 2
        private const val REQUEST_CONTACTS = 3
        private const val CONTACTS_CHECK_INTERVAL_MS = 15_000L
    }
}
