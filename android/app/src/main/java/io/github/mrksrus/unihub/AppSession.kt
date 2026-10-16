package io.github.mrksrus.unihub

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The app's session on its server, as native code uses it: contacts sync
 * (ContactsSync) and notifications (AppNotifications) ask the server with the
 * WebView's own session cookie, so they need no password of their own and
 * sign in and out with the app.
 */
object AppSession {
    private const val TAG = "UniHubSession"
    // Kept where 0.22.0 kept it (ContactsSync), so a renewal saved before an update is not lost.
    private const val PREFS = "contacts"
    private const val KEY_RENEWAL = "renewal"
    private const val MAX_BODY = 16 * 1024 * 1024

    // The WebView's cookies for the server, including the session.
    fun cookie(origin: String): String? =
        CookieManager.getInstance().getCookie(origin)?.takeIf { it.isNotBlank() }

    // The session cookie (api/src/config.ts, AUTH_COOKIE_NAME) among them;
    // the CSRF cookie may change without the session changing.
    fun cookieValues(cookies: String?): Map<String, String> =
        cookies.orEmpty().split(';').map { it.trim() }.filter { '=' in it }
            .associate { it.substringBefore('=') to it.substringAfter('=') }

    fun sessionOf(cookies: String?): String? =
        cookies?.split(';')?.map { it.trim() }?.firstOrNull { it.startsWith("auth-token=") } ?: cookies

    /** Thrown when the session, server or account an answer was for is no longer the app's. */
    class Stale : Exception()

    fun interface Current {
        fun valid(): Boolean
        fun check() { if (!valid()) throw Stale() }
    }

    // ── The session's expiry ───────────────────────────────────────────
    // The server extends a session at most once a day and sends its cookie
    // again. The WebView must get that expiry, or the app would sign out 21
    // days after its own last renewal while background requests keep renewing
    // the session. Writing the cookie must not undo a sign-in. UniHub opens a
    // new session only from its /auth page (sign-in, sign-up, two-factor
    // codes), so a renewal is kept and written only while no page of this
    // process is on /auth and none has been for SIGN_IN_GRACE_MS, which
    // outlasts a sign-in request still under way. It is written only if the
    // cookie is still that session. The lock orders the write with page changes.

    private const val SIGN_IN_GRACE_MS = 5 * 60_000L
    private val webLock = Any()
    private var onAuthPage = false
    private var leftAuthPageAt = 0L

    /** MainActivity: the WebView shows this address now (null: the WebView is gone). */
    fun pageShown(context: Context, url: String?) = synchronized(webLock) {
        val auth = url != null && Uri.parse(url).path.let { it == "/auth" || it?.startsWith("/auth/") == true }
        if (onAuthPage && !auth) leftAuthPageAt = android.os.SystemClock.elapsedRealtime()
        onAuthPage = auth
        applyRenewal(context)
    }

    /** Writes a kept renewal if that is safe now. */
    fun renewSession(context: Context) = synchronized(webLock) { applyRenewal(context) }

    private fun keepRenewal(context: Context, origin: String, session: String, cookies: List<String>) = synchronized(webLock) {
        val renewal = JSONObject().put("origin", origin).put("session", sessionOf(session)).put("sent", session).put("cookies", JSONArray(cookies))
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_RENEWAL, renewal.toString()).commit()
        applyRenewal(context)
    }

    // Holds webLock.
    private fun applyRenewal(context: Context) {
        if (onAuthPage) return
        if (leftAuthPageAt != 0L && android.os.SystemClock.elapsedRealtime() - leftAuthPageAt < SIGN_IN_GRACE_MS) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_RENEWAL, null) ?: return
        prefs.edit().remove(KEY_RENEWAL).commit()
        try {
            val renewal = JSONObject(saved)
            val origin = renewal.getString("origin")
            if (sessionOf(cookie(origin)) != renewal.getString("session")) {
                Log.i(TAG, "Session renewal dropped: the app has another session")
                return
            }
            // Each cookie only extends the value the request sent: one the page
            // got since (servers up to 0.21.4 rotate the CSRF cookie on
            // every page load) stays.
            val sent = cookieValues(renewal.getString("sent"))
            val now = cookieValues(cookie(origin))
            val cookies = renewal.getJSONArray("cookies")
            val manager = CookieManager.getInstance()
            for (index in 0 until cookies.length()) {
                val header = cookies.getString(index)
                val name = header.substringBefore('=').trim()
                if (name in sent && now[name] == sent[name]) manager.setCookie(origin, header)
            }
            manager.flush()
            Log.i(TAG, "Session renewal given to the app")
        } catch (_: org.json.JSONException) {
            // Nothing usable was kept.
        }
    }

    // ── Requests ───────────────────────────────────────────────────────

    class Response(val status: Int, val body: String) {
        fun json(): JSONObject? = try { JSONObject(body) } catch (_: org.json.JSONException) { null }
        fun expectOk() { if (status != 200) throw IOException("HTTP $status") }
    }

    fun get(context: Context, origin: String, path: String, session: String, current: Current): Response =
        request(context, origin, "GET", path, session, current, null)

    /**
     * A JSON request with the app's session. A request that changes something
     * carries the CSRF token from the session's cookies, as the page does.
     */
    fun request(context: Context, origin: String, method: String, path: String, session: String, current: Current, body: JSONObject?): Response {
        val connection = open(context, origin, path, session, timeoutMs = 60_000)
        connection.requestMethod = method
        if (method != "GET") cookieValues(session)["csrf-token"]?.let { connection.setRequestProperty("X-CSRF-Token", it) }
        try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            keepRenewals(context, origin, session, connection, current)
            val stream = (if (status >= 400) connection.errorStream else connection.inputStream)
                ?: return Response(status, "")
            val text = stream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    if (output.size() > MAX_BODY) throw IOException("Answer too large")
                }
                output.toString(Charsets.UTF_8.name())
            }
            return Response(status, text)
        } finally {
            connection.disconnect()
        }
    }

    /** A connection with the app's session, not yet sent. */
    fun open(context: Context, origin: String, path: String, session: String, timeoutMs: Int): HttpURLConnection {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = timeoutMs
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cookie", session)
        connection.setRequestProperty("X-Background-Sync", "1")
        connection.setRequestProperty("User-Agent", "UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        return connection
    }

    /** Keeps a session renewal the server sent with this answer (see above). */
    fun keepRenewals(context: Context, origin: String, session: String, connection: HttpURLConnection, current: Current) {
        connection.headerFields["Set-Cookie"]?.takeIf { it.isNotEmpty() && current.valid() }?.let { cookies ->
            keepRenewal(context, origin, session, cookies)
        }
    }
}
