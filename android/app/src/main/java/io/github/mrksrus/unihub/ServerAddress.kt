package io.github.mrksrus.unihub

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** The UniHub server this app opens, kept as an origin: scheme, host and port. */
object ServerAddress {
    private const val PREFS = "server"
    private const val KEY_ORIGIN = "origin"

    // Plain HTTP only for development: the emulator's host and `adb reverse`.
    // The same hosts are allowed in res/xml/network_security_config.xml.
    private val DEV_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

    fun saved(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ORIGIN, null)

    fun save(context: Context, origin: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ORIGIN, origin).apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_ORIGIN).apply()
    }

    /**
     * Turns what the user typed (or a connect link carried) into an origin, or
     * null when it is not a usable server address. A missing scheme means HTTPS.
     */
    fun parse(input: String?): String? {
        val text = input?.trim().orEmpty()
        if (text.isEmpty()) return null
        val uri = Uri.parse(if ("://" in text) text else "https://$text")
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.userInfo != null) return null
        if (scheme != "https" && !(scheme == "http" && host in DEV_HOSTS)) return null
        return originOf(uri)
    }

    fun sameOrigin(origin: String, url: String?): Boolean =
        url?.let { originOf(Uri.parse(it)) } == origin

    private fun originOf(uri: Uri): String? {
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val shownHost = if (':' in host && !host.startsWith("[")) "[$host]" else host
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://$shownHost$port"
    }

    fun host(origin: String): String = Uri.parse(origin).host ?: origin

    // The handshake version this app speaks (api/src/services/app-version.ts).
    private const val PROTOCOL = 1

    sealed interface Check {
        data object Ok : Check
        data object NotUniHub : Check
        data object Unreachable : Check
        /** The server speaks another handshake version than this app. */
        data object Incompatible : Check
        /** The server no longer serves an app as old as this one (its minApp). */
        data object AppTooOld : Check
    }

    /** Compares "major.minor.patch" versions; a part that is not a number counts as 0. */
    fun compareVersions(a: String, b: String): Int {
        val left = a.split('.').map { it.toIntOrNull() ?: 0 }
        val right = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (index in 0 until maxOf(left.size, right.size)) {
            val difference = left.getOrElse(index) { 0 }.compareTo(right.getOrElse(index) { 0 })
            if (difference != 0) return difference
        }
        return 0
    }

    /** Asks the server's public version endpoint whether it is UniHub. Blocks; call off the main thread. */
    fun check(origin: String): Check {
        return try {
            val connection = URL("$origin/api/version").openConnection() as HttpURLConnection
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            try {
                if (connection.responseCode != 200) return Check.NotUniHub
                val body = connection.inputStream.use { stream ->
                    String(readAtMost(stream, 64 * 1024), Charsets.UTF_8)
                }
                val info = JSONObject(body)
                when {
                    info.optString("app") != "unihub" -> Check.NotUniHub
                    info.optInt("protocol", PROTOCOL) != PROTOCOL -> Check.Incompatible
                    compareVersions(BuildConfig.VERSION_NAME, info.optString("minApp", "0")) < 0 -> Check.AppTooOld
                    else -> Check.Ok
                }
            } finally {
                connection.disconnect()
            }
        } catch (_: org.json.JSONException) {
            Check.NotUniHub
        } catch (_: Exception) {
            Check.Unreachable
        }
    }

    private fun readAtMost(stream: java.io.InputStream, limit: Int): ByteArray {
        val buffer = ByteArray(limit)
        var total = 0
        while (total < limit) {
            val read = stream.read(buffer, total, limit - total)
            if (read < 0) break
            total += read
        }
        return buffer.copyOf(total)
    }
}
