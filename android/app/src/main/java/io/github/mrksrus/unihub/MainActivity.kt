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
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
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
import org.json.JSONObject

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
    // The page's file input while Android's picker is open, bound to the session.
    private val filePick = PickedFiles.Pick<Array<Uri>>(FileActions.session)
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
    // The page's "turn on" while Android asks for the notification permission,
    // and the page's answer that waits for Android's background question.
    private var notificationsAnswer: ((JSONObject) -> Unit)? = null
    private var notificationsServer: String? = null
    private var backgroundAnswer: (() -> Unit)? = null
    // One question at a time: contacts or notifications.
    private var questionOpen = false
    private var notificationsChecking = false
    private var notificationsCheckedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        drawEdgeToEdge()
        FileActions.pruneLater(this)
        val saved = ServerAddress.saved(this)
        if (saved != null) PageTheme.saved(this)?.let { (dark, background) -> applyTheme(dark, background) }
        val opened = notificationPath(intent, saved)?.takeIf { savedInstanceState == null }
        if (saved != null) showWeb(saved, savedInstanceState, opened) else showConnect()
        connectRequest(intent)?.takeIf { it != saved && savedInstanceState == null }?.let(::confirmConnect)
        if (savedInstanceState == null && intent?.action == ACTION_SHOW_CONTACTS) contactsFromSettings(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        connectRequest(intent)?.takeIf { it != origin }?.let(::confirmConnect)
        if (intent.action == ACTION_SHOW_CONTACTS) contactsFromSettings(intent)
        val server = origin
        notificationPath(intent, server)?.let { path -> if (server != null) webView?.loadUrl(server + path) }
    }

    /** The page a tapped notification leads to, if it came from this server. */
    private fun notificationPath(intent: Intent?, server: String?): String? {
        if (intent?.action != ACTION_OPEN_NOTIFICATION || server == null) return null
        if (intent.getStringExtra(EXTRA_ORIGIN) != server) return null
        return intent.getStringExtra(EXTRA_PATH)?.takeIf { it.startsWith("/") && !it.startsWith("//") }
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
                        ServerAddress.Check.Incompatible -> {
                            error.setText(R.string.connect_incompatible)
                            error.visibility = View.VISIBLE
                        }
                        ServerAddress.Check.AppTooOld -> {
                            error.text = getString(R.string.connect_app_too_old, "$candidate/downloads/unihub.apk")
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
    // Notifications stay set up per server and come back with it.
    private fun useServer(server: String) {
        // Also from a connect link, where the next server's sign-in may still
        // be valid: no sign-in page would end the file session then.
        if (ServerAddress.saved(this) != server) {
            NotificationService.stop(this)
            endFileSession()
        }
        ServerAddress.save(this, server)
        if (ContactsSync.account(this)?.let { ContactsSync.origin(this, it) } != server) ContactsSync.turnOff(this)
        NotificationService.startIfWanted(this)
    }

    private fun changeServer() {
        val current = origin
        ServerAddress.clear(this)
        endFileSession()
        NotificationService.stop(this)
        showConnect(prefill = current)
    }

    // Copies for other apps and picked files go, and a picker still open hands the page nothing.
    private fun endFileSession() {
        FileActions.endSession(this)
        filePick.cancel()
    }

    // ── The server's pages ─────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb(server: String, savedInstanceState: Bundle?, path: String? = null) {
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
            // Pinch zoom as in a browser, without the on-screen zoom buttons.
            builtInZoomControls = true
            displayZoomControls = false
            // The page reads this to know it runs in the app, and which messages
            // the bridge (WebBridge) understands (src/lib/platform.ts).
            userAgentString = "$userAgentString UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) UniHubBridge/$BRIDGE_LEVEL"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)

        PageTheme.saved(this)?.let { (_, background) -> web.setBackgroundColor(background) }
        val pageBridge = WebBridge(this, server, onChangeServer = ::changeServer, onTheme = { dark, background ->
            PageTheme.save(this, dark, background)
            applyTheme(dark, background)
        }, onNotifications = { action, answer -> notifications(server, action, answer) })
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
                ContactsSync.pageShown(this@MainActivity, url)
                hideError()
                pageBridge.cancelFiles()
                filePick.cancel()
            }

            // Also after signing in, which changes the page without loading one.
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                ContactsSync.pageShown(this@MainActivity, url)
                // Signed out (here, elsewhere or expired): the files handed to other apps go.
                if (isSignInPage(url)) endFileSession()
                offerContacts(server)
                offerNotifications(server)
                resumeNotifications()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError(server)
            }

            // Unhandled, a renderer that crashed or was reclaimed (a large
            // mail, low memory while in the background) ends the app's process
            // and the notification service with it. The dead WebView is
            // replaced and the page starts again from the server.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view === webView) showWeb(server, null)
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                filePick.cancel()
                return try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE)
                    filePick.open(callback::onReceiveValue)
                    true
                } catch (_: Exception) {
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

        if (savedInstanceState?.let { web.restoreState(it) } == null) web.loadUrl(server + (path ?: ""))
    }

    private fun destroyWeb() {
        screenGeneration++
        contactsRecheck.removeCallbacksAndMessages(null)
        contactsOfferPending = false
        filePick.cancel()
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
            ContactsSync.pageShown(this, null)
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
        if (questionOpen || ContactsSync.account(this) != null || ContactsSync.offered(this, server)) return
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
        questionOpen = true
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
            .setOnDismissListener { questionClosed() }
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

    // ── Notifications (AppNotifications, NotificationService) ──────────

    // Signing in again, or a connection Android ended, brings the connection
    // back; at most once a minute from page changes.
    private var notificationsResumedAt = 0L
    private fun resumeNotifications() {
        val now = SystemClock.elapsedRealtime()
        if (notificationsResumedAt != 0L && now - notificationsResumedAt < 60_000) return
        notificationsResumedAt = now
        NotificationService.startIfWanted(this)
    }

    private fun questionClosed() {
        questionOpen = false
        origin?.let { offerContacts(it); offerNotifications(it) }
    }

    // Asked once per server after signing in, when the server can send them,
    // like the contacts question. Settings → Notifications turns them on and
    // off at any time; this also works where the page cannot reach the app
    // (an old WebView without its message bridge).
    private fun offerNotifications(server: String) {
        if (questionOpen || notificationsChecking || AppNotifications.offered(this, server)) return
        if (AppSession.cookie(server)?.contains("auth-token=") != true) return
        val now = SystemClock.elapsedRealtime()
        if (notificationsCheckedAt != 0L && now - notificationsCheckedAt < CONTACTS_CHECK_INTERVAL_MS) return
        notificationsCheckedAt = now
        notificationsChecking = true
        val generation = screenGeneration
        Thread {
            val ready = AppNotifications.canOffer(this, server)
            runOnUiThread {
                notificationsChecking = false
                if (isFinishing || isDestroyed || generation != screenGeneration || ServerAddress.saved(this) != server) return@runOnUiThread
                if (ready && !questionOpen && !AppNotifications.offered(this, server)) askNotifications(server)
            }
        }.start()
    }

    private fun askNotifications(server: String) {
        AppNotifications.markOffered(this, server)
        questionOpen = true
        AlertDialog.Builder(this)
            .setTitle(R.string.notifications_title)
            .setMessage(getString(R.string.notifications_body, ServerAddress.host(server)))
            .setPositiveButton(R.string.notifications_ok) { _, _ ->
                startNotifications(server) { result ->
                    runOnUiThread {
                        if (result.optBoolean("ok")) toast(R.string.notifications_on)
                        else Toast.makeText(this, result.optString("error"), Toast.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton(R.string.contacts_not_now, null)
            .setOnDismissListener { questionClosed() }
            .show()
    }

    private fun answer(state: JSONObject? = null, error: String? = null) = JSONObject().apply {
        put("ok", error == null)
        state?.let { put("state", it) }
        error?.let { put("error", it) }
    }

    /** Settings → Notifications in the page: status, enable, disable, background. */
    private fun notifications(server: String, action: String, reply: (JSONObject) -> Unit) {
        fun later(task: () -> JSONObject) = Thread {
            val result = try { task() } catch (error: AppNotifications.Problem) { answer(error = error.message) }
            reply(result)
        }.start()
        when (action) {
            "status" -> later { answer(AppNotifications.currentState(this, server)) }
            "disable" -> later {
                AppNotifications.turnOff(this, server)
                answer(AppNotifications.currentState(this, server))
            }
            "background" -> askBackground { later { answer(AppNotifications.currentState(this, server)) } }
            "enable" -> startNotifications(server, reply)
            else -> reply(answer(error = getString(R.string.notifications_unknown)))
        }
    }

    // Android's permission first (Android 13+), then registering.
    private fun startNotifications(server: String, reply: (JSONObject) -> Unit) {
        if (AppNotifications.needsPermission(this)) {
            notificationsAnswer?.invoke(answer(error = getString(R.string.notifications_superseded)))
            notificationsAnswer = reply
            notificationsServer = server
            AppNotifications.markAsked(this)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        } else {
            enableNotifications(server, reply)
        }
    }

    private fun enableNotifications(server: String, reply: (JSONObject) -> Unit) {
        if (!getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()) {
            openNotificationSettings()
            reply(answer(error = getString(R.string.notifications_blocked)))
            return
        }
        Thread {
            try {
                AppNotifications.turnOn(this, server)
            } catch (error: AppNotifications.Problem) {
                reply(answer(error = error.message))
                return@Thread
            }
            // The page hears back once Android's background question is answered.
            runOnUiThread {
                askBackground {
                    Thread { reply(answer(AppNotifications.currentState(this, server))) }.start()
                }
            }
        }.start()
    }

    // Android's question whether UniHub may run in the background, which keeps
    // its connection open while the phone sleeps. `then` runs once it is
    // answered (or at once, when there is nothing to ask).
    @SuppressLint("BatteryLife")
    private fun askBackground(then: () -> Unit) {
        if (isFinishing || AppNotifications.backgroundAllowed(this)) {
            then()
            return
        }
        backgroundAnswer?.invoke()
        backgroundAnswer = then
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")), REQUEST_BACKGROUND)
        } catch (_: Exception) {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) { }
            backgroundAnswer = null
            then()
        }
    }

    private fun openNotificationSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        } catch (_: Exception) { }
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

    // The app is drawn behind the status and navigation bars on every Android
    // version (Android 15 requires it of an app targeting it), and pads its
    // content by the bars, the display cutout and the keyboard itself. The
    // WebView is therefore exactly the visible area above the keyboard, as in
    // a browser that resizes for it: the page's own keyboard handling
    // (visualViewport) then finds nothing covered and adds nothing. The insets
    // are consumed here, so the WebView does not pad a second time.
    @Suppress("DEPRECATION")
    private fun drawEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        } else {
            // Android 10: with adjustResize, the system window insets include the keyboard.
            window.decorView.systemUiVisibility = window.decorView.systemUiVisibility or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        }
    }

    @Suppress("DEPRECATION")
    private fun applyInsets(view: View) {
        view.setOnApplyWindowInsetsListener { target, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val area = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                target.setPadding(area.left, area.top, area.right, area.bottom)
                WindowInsets.CONSUMED
            } else {
                val cutout = insets.displayCutout
                target.setPadding(
                    maxOf(insets.systemWindowInsetLeft, cutout?.safeInsetLeft ?: 0),
                    maxOf(insets.systemWindowInsetTop, cutout?.safeInsetTop ?: 0),
                    maxOf(insets.systemWindowInsetRight, cutout?.safeInsetRight ?: 0),
                    maxOf(insets.systemWindowInsetBottom, cutout?.safeInsetBottom ?: 0),
                )
                insets.consumeSystemWindowInsets().consumeDisplayCutout()
            }
        }
        view.requestApplyInsets()
    }

    private fun isSignInPage(url: String?) =
        url != null && Uri.parse(url).path.let { it == "/auth" || it?.startsWith("/auth/") == true }

    // ── Results, back, lifecycle ───────────────────────────────────────

    @Deprecated("Activity result API needs AndroidX; the framework call is enough here.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_FILE) {
            // Nothing is copied for a pick whose session ended while the picker was open.
            val pick = filePick.finish() ?: return
            val clip = data?.clipData
            val picked = PickedFiles.collect(resultCode == RESULT_OK, data?.data,
                if (clip == null) emptyList() else List(clip.itemCount) { clip.getItemAt(it).uri })
            if (picked == null) {
                pick.deliver(null)
                return
            }
            // WebView 133 (Android 16) reads a picker's document URI as an
            // empty file; it reads the app's own copy correctly everywhere.
            // Copies finished after signing out (checked here, on the thread
            // that ends sessions) are deleted, and the page gets nothing.
            FileActions.copyPicked(this, picked, pick.session) { outcome ->
                runOnUiThread {
                    if (outcome == null || !FileActions.session.isCurrent(pick.session) || isFinishing || isDestroyed) {
                        outcome?.let { FileActions.discard(it.copies) }
                        pick.deliver(null)
                        return@runOnUiThread
                    }
                    pick.deliver(outcome.copies.map { it.uri }.ifEmpty { null }?.toTypedArray())
                    if (outcome.refused.isNotEmpty()) showRefusedFiles(outcome.refused)
                }
            }
            return
        }
        if (requestCode == REQUEST_BACKGROUND) {
            backgroundAnswer?.invoke()
            backgroundAnswer = null
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    // The page gets only the files that were copied; the others are named here.
    private fun showRefusedFiles(refused: List<Pair<String, PickedFiles.Refusal>>) {
        val lines = refused.joinToString("\n") { (name, reason) ->
            getString(R.string.files_not_added_line, WebBridge.safeFileName(name), getString(when (reason) {
                PickedFiles.Refusal.TOO_LARGE -> R.string.files_not_added_too_large
                PickedFiles.Refusal.NO_SPACE -> R.string.files_not_added_no_space
                PickedFiles.Refusal.UNREADABLE -> R.string.files_not_added_unreadable
            }))
        }
        AlertDialog.Builder(this)
            .setTitle(resources.getQuantityString(R.plurals.files_not_added_title, refused.size, refused.size))
            .setMessage(lines)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQUEST_NOTIFICATIONS) {
            val reply = notificationsAnswer ?: return
            val server = notificationsServer
            notificationsAnswer = null
            notificationsServer = null
            when {
                server == null || server != origin -> reply(answer(error = getString(R.string.notifications_superseded)))
                grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED -> enableNotifications(server, reply)
                else -> {
                    // Android no longer asks: only its settings can allow them now.
                    if (!shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) openNotificationSettings()
                    reply(answer(error = getString(R.string.notifications_blocked)))
                }
            }
            return
        }
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
    override fun onResume() {
        super.onResume()
        webView?.onResume()
        // Copies for other apps expire after six hours even while the app stays open.
        FileActions.pruneLater(this)
        ContactsSync.renewSession(this)
        if (origin != null) NotificationService.startIfWanted(this)
    }

    override fun onPause() {
        super.onPause()
        // Pauses the page's media, animations and plugins while it is not shown;
        // notifications come from NotificationService, not from the page.
        webView?.onPause()
        CookieManager.getInstance().flush()
        ContactsSync.requestSync(this)
    }

    override fun onDestroy() {
        destroyWeb()
        finishContacts(null)
        notificationsAnswer?.invoke(answer(error = getString(R.string.notifications_superseded)))
        notificationsAnswer = null
        backgroundAnswer?.invoke()
        backgroundAnswer = null
        super.onDestroy()
    }

    companion object {
        const val ACTION_SHOW_CONTACTS = "io.github.mrksrus.unihub.SHOW_CONTACTS"
        const val ACTION_OPEN_NOTIFICATION = "io.github.mrksrus.unihub.OPEN_NOTIFICATION"
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_PATH = "path"
        private const val REQUEST_FILE = 1
        private const val REQUEST_MICROPHONE = 2
        private const val REQUEST_CONTACTS = 3
        private const val REQUEST_NOTIFICATIONS = 4
        private const val REQUEST_BACKGROUND = 5
        private const val CONTACTS_CHECK_INTERVAL_MS = 15_000L
        // What the page may ask of WebBridge, announced in the user agent:
        // 1 up to 0.24 (files from the page, downloads, theme, notifications),
        // 2 from 0.25 (fileAction: open with, save, share with a download ticket).
        const val BRIDGE_LEVEL = 2
    }
}
