package io.github.mrksrus.unihub

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.util.Log
import io.github.mrksrus.unihub.AppSession.Current
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * Notifications from the user's UniHub server, with the server as the app's
 * own push server: no Google or other push service is involved.
 *
 * Turned on from the page (Settings → Notifications, through WebBridge), per
 * server and signed-in user. The app then registers this phone with the
 * server (a key pair of RFC 8291; the private key never leaves the phone) and
 * NotificationService keeps one connection open, over which the server sends
 * each notification encrypted for this phone. The app shows it and
 * acknowledges it; an unacknowledged one is sent again. It uses the WebView's
 * session (AppSession), so it signs out with the app: shown notifications are
 * removed and nothing more arrives until the person signs in again.
 */
object AppNotifications {
    private const val TAG = "UniHubNotifications"
    private const val PREFS = "notifications"
    private const val SEEN = "seen"
    private const val MAX_SEEN = 300
    const val FEATURE = "android-notifications"

    // Channels: the person can silence each kind in Android's settings.
    const val CHANNEL_CONNECTION = "connection"
    private const val CHANNEL_MAIL = "mail"
    private const val CHANNEL_CALENDAR = "calendar"
    private const val CHANNEL_RECORDINGS = "recordings"
    private const val CHANNEL_ACCOUNT = "account"

    /** The device this phone registered on a server, for one user. */
    class Device(val user: String, val id: String, val endpoint: String, val keys: PushCrypto.Keys)

    class Problem(message: String) : Exception(message)

    // ── What is stored ─────────────────────────────────────────────────

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context, origin: String, user: String) = prefs(context).getBoolean("enabled:$origin:$user", false)

    /**
     * Whether notifications are on for this server and the user last seen
     * signed in here (anyone, before the first check), so the connection is
     * not started for a user who did not turn them on.
     */
    fun wantedOn(context: Context, origin: String): Boolean {
        prefs(context).getString("user:$origin", null)?.let { return enabled(context, origin, it) }
        return prefs(context).all.any { (key, value) -> key.startsWith("enabled:$origin:") && value == true }
    }

    /** Remembers who is signed in on this server (see wantedOn). */
    fun noteUser(context: Context, origin: String, user: String) {
        if (prefs(context).getString("user:$origin", null) != user) prefs(context).edit().putString("user:$origin", user).apply()
    }

    private fun setEnabled(context: Context, origin: String, user: String, on: Boolean) {
        prefs(context).edit().putBoolean("enabled:$origin:$user", on).commit()
    }

    fun device(context: Context, origin: String): Device? {
        val text = prefs(context).getString("device:$origin", null) ?: return null
        return try {
            val json = JSONObject(text)
            Device(json.getString("user"), json.getString("id"), json.getString("endpoint"),
                PushCrypto.restore(json.getString("private"), json.getString("public"), json.getString("auth")))
        } catch (_: Exception) {
            null
        }
    }

    private fun saveDevice(context: Context, origin: String, device: Device?) {
        val edit = prefs(context).edit()
        if (device == null) edit.remove("device:$origin") else edit.putString("device:$origin", JSONObject()
            .put("user", device.user).put("id", device.id).put("endpoint", device.endpoint)
            .put("private", device.keys.privateKeyText()).put("public", device.keys.p256dh()).put("auth", device.keys.authSecret()).toString())
        edit.commit()
    }

    // ── The server ─────────────────────────────────────────────────────

    /** The signed-in user's id, or null when the session ended. Throws when the server cannot answer. */
    fun signedInUser(context: Context, origin: String, session: String, current: Current): String? {
        val me = AppSession.get(context, origin, "/api/auth/me?background=1", session, current)
        if (me.status == 401) return null
        me.expectOk()
        val user = me.json()?.optJSONObject("user")?.optString("id")?.takeIf { it.isNotEmpty() } ?: throw IOException("No user")
        noteUser(context, origin, user)
        return user
    }

    /**
     * The device registered for this user, registering one if there is none
     * (or the one kept belongs to another user). Throws when the server refuses.
     */
    fun ensureDevice(context: Context, origin: String, session: String, user: String, current: Current): Device {
        device(context, origin)?.takeIf { it.user == user }?.let { return it }
        return register(context, origin, session, user, current)
    }

    /** Registers new keys, replacing this phone's earlier device on the server. */
    fun register(context: Context, origin: String, session: String, user: String, current: Current): Device {
        val keys = PushCrypto.generate()
        val body = JSONObject().put("keys", JSONObject().put("p256dh", keys.p256dh()).put("auth", keys.authSecret()))
        device(context, origin)?.let { body.put("replaces", it.id) }
        val answer = AppSession.request(context, origin, "POST", "/api/notifications/android/devices", session, current, body)
        if (answer.status == 401) throw Problem("Sign in to UniHub first.")
        if (answer.status != 200) throw Problem(answer.json()?.optString("error")?.takeIf { it.isNotEmpty() } ?: "The server could not turn on notifications.")
        val json = answer.json() ?: throw IOException("No answer")
        current.check()
        val device = Device(user, json.getString("device"), json.getString("endpoint"), keys)
        saveDevice(context, origin, device)
        return device
    }

    /** Forgets this server's device after the server said it does not know it. */
    fun forgetDevice(context: Context, origin: String, device: Device) {
        if (device(context, origin)?.id == device.id) saveDevice(context, origin, null)
    }

    fun acknowledge(context: Context, origin: String, session: String, device: Device, ids: List<String>, current: Current): Boolean {
        val body = JSONObject().put("device", device.id).put("ids", JSONArray(ids))
        return AppSession.request(context, origin, "POST", "/api/notifications/android/ack", session, current, body).status == 200
    }

    private fun serverOffers(origin: String): Boolean {
        val connection = java.net.URL("$origin/api/version").openConnection() as java.net.HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 15_000
        connection.instanceFollowRedirects = false
        try {
            if (connection.responseCode != 200) throw IOException("HTTP ${connection.responseCode}")
            val text = connection.inputStream.use { String(it.readBytes().take(64 * 1024).toByteArray(), Charsets.UTF_8) }
            val features = JSONObject(text).optJSONArray("features") ?: return false
            return (0 until features.length()).any { features.optString(it) == FEATURE }
        } finally {
            connection.disconnect()
        }
    }

    // ── Turning it on and off (the page asks; blocks, call off the main thread) ──

    /** Registers this phone for the signed-in user and starts the connection. */
    fun turnOn(context: Context, origin: String) {
        try {
            if (!serverOffers(origin)) throw Problem("This UniHub server does not send notifications to the app yet. Update the server first.")
            val session = AppSession.cookie(origin) ?: throw Problem("Sign in to UniHub first.")
            val current = Current { AppSession.sessionOf(AppSession.cookie(origin)) == AppSession.sessionOf(session) }
            val user = signedInUser(context, origin, session, current) ?: throw Problem("Sign in to UniHub first.")
            // New keys each time it is turned on.
            register(context, origin, session, user, current)
            setEnabled(context, origin, user, true)
            markOffered(context, origin)
        } catch (error: Problem) {
            throw error
        } catch (_: AppSession.Stale) {
            throw Problem("You signed in or out meanwhile. Try again.")
        } catch (error: Exception) {
            Log.w(TAG, "Turning on failed: ${error.javaClass.simpleName}")
            throw Problem("Could not reach the server. Check your connection and try again.")
        }
        NotificationService.start(context)
        NotificationService.scheduleWatchdog(context)
    }

    /** Stops notifications for the signed-in user on this phone, and tells the server when it can. */
    fun turnOff(context: Context, origin: String) {
        val device = device(context, origin)
        val session = AppSession.cookie(origin)
        var user = device?.user
        if (session != null) {
            val current = Current { AppSession.sessionOf(AppSession.cookie(origin)) == AppSession.sessionOf(session) }
            try {
                user = signedInUser(context, origin, session, current) ?: user
                if (device != null && device.user == user) {
                    AppSession.request(context, origin, "POST", "/api/notifications/unsubscribe", session, current, JSONObject().put("endpoint", device.endpoint))
                }
            } catch (_: Exception) {
                // The device ends with its session on the server anyway.
            }
        }
        user?.let { setEnabled(context, origin, it, false) }
        if (device != null && (user == null || device.user == user)) saveDevice(context, origin, null)
        NotificationService.stop(context)
        clearShown(context)
    }

    /** The page's view of this phone for the signed-in user. Blocks; call off the main thread. */
    fun currentState(context: Context, origin: String): JSONObject {
        val session = AppSession.cookie(origin)
        val user = try {
            session?.let { signedInUser(context, origin, it, Current { true }) }
        } catch (_: Exception) {
            null
        } ?: prefs(context).getString("user:$origin", null)
        return state(context, origin, user)
    }

    private fun state(context: Context, origin: String, user: String?): JSONObject {
        val device = device(context, origin)?.takeIf { user == null || it.user == user }
        val on = device != null && enabled(context, origin, device.user)
        return JSONObject()
            .put("enabled", on)
            .put("endpoint", if (on) device!!.endpoint else JSONObject.NULL)
            .put("permission", permission(context))
            .put("background", if (backgroundAllowed(context)) "allowed" else "restricted")
            .put("connected", on && NotificationService.connected)
    }

    // ── The phone's permissions ────────────────────────────────────────

    fun needsPermission(context: Context) =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    private fun permission(context: Context): String = when {
        context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() -> "granted"
        needsPermission(context) && !prefs(context).getBoolean("asked", false) -> "default"
        else -> "denied"
    }

    fun markAsked(context: Context) { prefs(context).edit().putBoolean("asked", true).apply() }

    /** Whether the app already asked about notifications for this server (asked once per server). */
    fun offered(context: Context, origin: String) = prefs(context).getBoolean("offered:$origin", false)

    fun markOffered(context: Context, origin: String) { prefs(context).edit().putBoolean("offered:$origin", true).apply() }

    /** Whether to ask: the server sends them and the signed-in user has not turned them on here. Blocks. */
    fun canOffer(context: Context, origin: String): Boolean = try {
        val session = AppSession.cookie(origin)
        val user = session?.let { signedInUser(context, origin, it, Current { true }) }
        user != null && !enabled(context, origin, user) && serverOffers(origin)
    } catch (_: Exception) {
        false
    }

    fun backgroundAllowed(context: Context) =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    // ── Showing them ───────────────────────────────────────────────────

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(listOf(
            NotificationChannel(CHANNEL_MAIL, context.getString(R.string.channel_mail), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_CALENDAR, context.getString(R.string.channel_calendar), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_RECORDINGS, context.getString(R.string.channel_recordings), NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CHANNEL_ACCOUNT, context.getString(R.string.channel_account), NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply {
                description = context.getString(R.string.channel_connection_description)
                setShowBadge(false)
            },
        ))
    }

    private fun channelFor(kind: String) = when (kind) {
        "mail" -> CHANNEL_MAIL
        "calendar", "todo", "reminder" -> CHANNEL_CALENDAR
        "recording" -> CHANNEL_RECORDINGS
        else -> CHANNEL_ACCOUNT
    }

    /**
     * Shows one notification the server sent, unless it is not for this
     * device's user or was shown already. Returns false only for a message
     * that could not be read at all.
     */
    fun show(context: Context, origin: String, device: Device, eventId: String, body: String): Boolean {
        val payload = try {
            JSONObject(String(PushCrypto.decrypt(device.keys, PushCrypto.unb64(body)), Charsets.UTF_8))
        } catch (error: Exception) {
            Log.w(TAG, "A notification could not be read: ${error.javaClass.simpleName}")
            return false
        }
        if (payload.optInt("version") != 1 || payload.optString("userId") != device.user) return true
        val dedupe = payload.optString("dedupeKey").takeIf { it.isNotEmpty() && it.length <= 512 } ?: return true
        if (!firstTime(context, "${device.user}:$dedupe")) return true
        val tag = payload.optString("tag").takeIf { it.isNotEmpty() && it.length <= 128 } ?: dedupe
        val path = targetPath(payload)
        val open = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_NOTIFICATION)
            .putExtra(MainActivity.EXTRA_ORIGIN, origin)
            .putExtra(MainActivity.EXTRA_PATH, path)
            .setData(Uri.parse("unihub-notification://$eventId"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val channel = channelFor(payload.optString("kind"))
        val title = payload.optString("title").take(120).ifEmpty { "UniHub" }
        val text = payload.optString("body").take(400)
        // The lock screen shows that something arrived, not what.
        val public = android.app.Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.notification_hidden))
            .build()
        val notification = android.app.Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.accent))
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(android.app.Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setCategory(if (channel == CHANNEL_MAIL) android.app.Notification.CATEGORY_EMAIL else if (channel == CHANNEL_CALENDAR) android.app.Notification.CATEGORY_EVENT else null)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(tag, 0, notification)
        } catch (_: SecurityException) {
            // Notifications are not allowed (Android 13+ permission withdrawn): nothing to show.
        }
        return true
    }

    // Only paths on the server, as the service worker allows (workers/sw-custom.ts).
    fun targetPath(payload: JSONObject): String {
        val url = payload.optString("url")
        if (!url.startsWith("/") || url.startsWith("//") || url.contains('\\') || url.length > 2048) return "/"
        return url
    }

    private fun firstTime(context: Context, key: String): Boolean = synchronized(this) {
        val prefs = prefs(context)
        val seen = try { JSONArray(prefs.getString(SEEN, "[]")) } catch (_: org.json.JSONException) { JSONArray() }
        for (index in 0 until seen.length()) if (seen.optString(index) == key) return false
        seen.put(key)
        val kept = JSONArray()
        for (index in maxOf(0, seen.length() - MAX_SEEN) until seen.length()) kept.put(seen.get(index))
        prefs.edit().putString(SEEN, kept.toString()).commit()
        true
    }

    /** Removes every shown notification except the connection's (sign-out, turned off). */
    fun clearShown(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (shown in manager.activeNotifications) {
            if (shown.id != NotificationService.ONGOING_ID || shown.tag != null) manager.cancel(shown.tag, shown.id)
        }
    }
}
