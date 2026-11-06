package io.github.mrksrus.unihub

import java.net.URI

/**
 * The rules of the page's file actions (FileActions) and downloads
 * (WebBridge.download) that need no Android classes, so the JVM tests can run
 * them: which address may be fetched, which type another app is told, and when
 * a shared copy is old enough to delete.
 */
object SharedFiles {
    /** The server's download tickets (api/src/routes/files.ts); nothing else is fetched. */
    const val TICKET_PATH = "/api/files/tickets/"

    /** The server's app update (api/src/services/app-version.ts ANDROID_APK_URL), public in nginx. */
    const val APP_UPDATE_PATH = "/downloads/unihub.apk"

    /**
     * A copy handed to another app is kept this long: the app may read it
     * some time after the chooser closed (a mail app when it sends). Signing
     * out deletes every copy at once.
     */
    const val MAX_AGE_MS = 6 * 60 * 60_000L

    private val TOKEN = Regex("[A-Za-z0-9_-]{43}")
    private val MIME = Regex("[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}")

    /** Whether `url` is a ticket of the server at `origin` (scheme, host and port equal). */
    fun isTicket(origin: String, url: String): Boolean {
        val path = serverPath(origin, url) ?: return false
        return path.startsWith(TICKET_PATH) && TOKEN.matches(path.removePrefix(TICKET_PATH))
    }

    /** Whether `url` is exactly the app update of the server at `origin`. */
    fun isAppUpdate(origin: String, url: String): Boolean = serverPath(origin, url) == APP_UPDATE_PATH

    /**
     * The raw (still encoded) path of `url` when it is an address of the
     * server at `origin` with nothing that could make it another one: no user
     * info, query or fragment. Comparing the raw path refuses encoded aliases
     * such as `%2F` or `..`.
     */
    private fun serverPath(origin: String, url: String): String? {
        val target = try { URI(url) } catch (_: Exception) { return null }
        val base = try { URI(origin) } catch (_: Exception) { return null }
        if (target.scheme?.lowercase() != base.scheme?.lowercase() || target.host?.lowercase() != base.host?.lowercase()) return null
        if (port(target) != port(base) || target.rawUserInfo != null || target.rawQuery != null || target.rawFragment != null) return null
        return target.rawPath
    }

    private fun port(uri: URI) = if (uri.port != -1) uri.port else if (uri.scheme?.lowercase() == "https") 443 else 80

    /**
     * The type another app is told: the server's answer, else the page's,
     * else the extension's; generic labels give way to a more specific one.
     */
    fun mimeType(fromServer: String?, fromPage: String?, fromExtension: String?): String {
        val candidates = listOf(fromServer, fromPage, fromExtension).mapNotNull(::normalize)
        return candidates.firstOrNull { it != GENERIC } ?: GENERIC
    }

    private const val GENERIC = "application/octet-stream"

    private fun normalize(value: String?): String? =
        value?.substringBefore(';')?.trim()?.lowercase()?.takeIf { MIME.matches(it) }

    /** The extension Android's type table is asked about. */
    fun extension(name: String): String? =
        name.substringAfterLast('.', "").lowercase().takeIf { it.isNotEmpty() && it.length <= 10 && it.all(Char::isLetterOrDigit) }

    fun stale(modifiedMs: Long, nowMs: Long): Boolean = nowMs - modifiedMs > MAX_AGE_MS || modifiedMs > nowMs + 60_000
}
