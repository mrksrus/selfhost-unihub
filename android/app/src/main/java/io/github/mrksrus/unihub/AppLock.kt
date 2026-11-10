package io.github.mrksrus.unihub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app lock of the Android app (0.29.0). The page decides what is locked
 * and draws the lock screen (src/lib/platform.ts `deviceLock`); the app keeps
 * the time while the page cannot (in the background, with the screen off, in
 * a process Android started for notifications), covers the page until it
 * has shown its lock screen, unlocks with the phone's own lock
 * (BiometricAuth) and hides the content of notifications of locked modules.
 *
 * A process-wide object, so it survives the activity being recreated (B-33);
 * a new process starts locked. The page's configuration is kept per server
 * in the prefs `app_lock`, so a cold start covers the page before it loads.
 */
object AppLock {
    private const val PREFS = "app_lock"
    private val AREAS = setOf(AppLockClock.Config.APP, "mail", "contacts", "calendar", "recordings")
    private const val MAX_RELOCK_MS = 24 * 60 * 60_000L

    private val clock = AppLockClock()
    private var origin: String? = null
    private var listening = false

    /** Screenshots and screen recording refused (FLAG_SECURE): the app_lock.screenshots policy, also with the lock off. */
    var blockScreenshots = false
        private set

    val on @Synchronized get() = clock.config.on
    val locked @Synchronized get() = clock.locked

    private fun now() = SystemClock.elapsedRealtime()

    /** Uses [server]'s configuration; another server than before starts locked, as a new process does. */
    @Synchronized
    fun attach(context: Context, server: String?) {
        listen(context.applicationContext)
        if (server == origin) return
        origin = server
        val stored = server?.let { stored(context, it) }
        clock.reset(stored?.first ?: AppLockClock.Config.OFF)
        blockScreenshots = stored?.second ?: false
    }

    // Android only sends the screen-off broadcast to receivers registered at
    // run time. It lives as long as the process, which the notification
    // service keeps while the app is in the background.
    private fun listen(context: Context) {
        if (listening) return
        listening = true
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF) synchronized(this@AppLock) { clock.screenOff(now()) }
            }
        }
        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        // A protected broadcast: only the system can send it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else context.registerReceiver(receiver, filter)
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun stored(context: Context, server: String): Pair<AppLockClock.Config, Boolean>? {
        val text = prefs(context).getString("config:$server", null) ?: return null
        return try {
            parse(JSONObject(text))
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The page's `configure`: `scope` (areas; empty is off), `relockAfterMs`,
     * `onDeviceLock`, `blockScreenshots`, and `on` (false turns it off
     * whatever the scope). Null when a value is not one the app knows.
     */
    fun parse(json: JSONObject): Pair<AppLockClock.Config, Boolean>? {
        val scope = LinkedHashSet<String>()
        val areas = json.optJSONArray("scope")
        if (areas != null) {
            for (index in 0 until areas.length()) {
                val area = areas.optString(index)
                if (area !in AREAS) return null
                scope.add(area)
            }
        } else if (json.optBoolean("on", false)) {
            // An `on` without a scope locks the whole app rather than nothing.
            scope.add(AppLockClock.Config.APP)
        }
        if (json.has("on") && !json.optBoolean("on")) scope.clear()
        if (AppLockClock.Config.APP in scope) scope.retainAll(setOf(AppLockClock.Config.APP))
        val relock = if (json.has("relockAfterMs")) json.optLong("relockAfterMs", -1) else 60_000L
        if (relock !in 0..MAX_RELOCK_MS) return null
        return AppLockClock.Config(scope, relock, json.optBoolean("onDeviceLock", true)) to json.optBoolean("blockScreenshots", false)
    }

    /** Stores and applies the page's configuration for [server]. False when it is not valid. */
    @Synchronized
    fun configure(context: Context, server: String, json: JSONObject): Boolean {
        val (config, screenshots) = parse(json) ?: return false
        attach(context, server)
        prefs(context).edit().putString("config:$server", JSONObject()
            .put("scope", JSONArray(config.scope.toList()))
            .put("relockAfterMs", config.relockAfterMs)
            .put("onDeviceLock", config.onDeviceLock)
            .put("blockScreenshots", screenshots)
            .toString()).commit()
        clock.configure(config)
        blockScreenshots = screenshots
        return true
    }

    // ── The activity's lifecycle ───────────────────────────────────────

    /** Shown again (started, resumed, a new intent). True when this locked the app. */
    @Synchronized
    fun returned(): Boolean = clock.returned(now())

    @Synchronized
    fun stopped(changingConfigurations: Boolean) = clock.stopped(now(), changingConfigurations)

    /** Marks the screen the app is about to open as a hand-off (file picker, permission question, the unlock prompt). */
    @Synchronized
    fun handOff() = clock.handOff(now())

    @Synchronized
    fun handOffEnded() = clock.handOffEnded()

    @Synchronized
    fun unlocked() = clock.unlocked(now())

    @Synchronized
    fun lockNow() = clock.lockNow()

    /** The page's `state` answer. Times are the phone's wall clock, for the page; the app measures with the monotonic one. */
    @Synchronized
    fun state(): JSONObject {
        val now = now()
        val wall = System.currentTimeMillis()
        return JSONObject()
            .put("locked", clock.locked)
            .put("freshProcess", clock.freshProcess)
            .put("hiddenForMs", clock.lastAwayMs ?: JSONObject.NULL)
            .put("deviceLockedSinceHidden", clock.lastScreenOff)
            .put("authenticatedAt", clock.authenticatedAt?.let { wall - (now - it) } ?: JSONObject.NULL)
    }

    // ── Notifications ──────────────────────────────────────────────────

    /** Whether a notification of [module] from [server] shows only its generic text now. */
    @Synchronized
    fun hides(context: Context, server: String, module: String?): Boolean {
        attach(context, server)
        return clock.hides(module, now())
    }

    /** The module of a notification: the payload's (servers from 0.29), or its kind's. */
    fun moduleOf(payload: JSONObject): String? {
        payload.optString("module").takeIf { it.isNotEmpty() }?.let { return it }
        return when (payload.optString("kind")) {
            "mail", "snooze", "scheduled-send" -> "mail"
            "calendar", "todo", "reminder" -> "calendar"
            "recording" -> "recordings"
            else -> null
        }
    }
}
