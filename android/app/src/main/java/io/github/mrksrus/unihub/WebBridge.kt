package io.github.mrksrus.unihub

import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * What the page can ask of the phone. The page side is src/lib/platform.ts:
 * it finds `window.UniHubAndroid` and posts JSON messages to it.
 *
 * The object only exists in the server's own top-level page (the allowed
 * origin below), never in other sites or in frames such as displayed email.
 */
class WebBridge(
    private val activity: Activity,
    private val origin: String,
    private val onChangeServer: () -> Unit,
    private val onTheme: (dark: Boolean, background: Int) -> Unit,
    // Settings → Notifications (AppNotifications). The answer is the reply's JSON.
    private val onNotifications: (action: String, answer: (JSONObject) -> Unit) -> Unit,
) {
    fun attach(webView: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(webView, NAME, setOf(origin)) { view, message, sourceOrigin, isMainFrame, reply ->
            if (!isMainFrame || !ServerAddress.sameOrigin(origin, sourceOrigin.toString())) return@addWebMessageListener
            handle(view, message, reply)
        }
        return true
    }

    /** Deletes unfinished files: the page that was sending them is gone (a reload, another page). */
    fun cancelFiles() {
        onFiles { open.keys.toList().forEach(::abortFile) }
    }

    /** Stops file transfers; a file that was not finished is deleted. */
    fun close() {
        cancelFiles()
        files.shutdown()
    }

    private fun handle(view: WebView, message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val data = try {
            JSONObject(message.data ?: return)
        } catch (_: org.json.JSONException) {
            return
        }
        when (data.optString("type")) {
            "saveFileStart" -> fileStep(reply, data) { id -> startFile(id, data.optString("name"), data.optString("mime")) }
            "saveFileChunk" -> fileStep(reply, data) { id -> writeFile(id, data.optString("data")) }
            "saveFileEnd" -> fileStep(reply, data) { id -> finishFile(id) }
            "saveFileAbort" -> data.optString("id").takeIf { validId(it) }?.let { id -> onFiles { abortFile(id) } }
            "download" -> download(data.optString("url"), data.optString("name"), view.settings.userAgentString)
            "openExternal" -> openExternal(activity, data.optString("url"))
            "changeServer" -> onChangeServer()
            "theme" -> parseColor(data.optString("background"))?.let { onTheme(data.optBoolean("dark", true), it) }
            "notifications" -> data.optString("id").takeIf { validId(it) }?.let { id ->
                onNotifications(data.optString("action")) { answer ->
                    activity.runOnUiThread {
                        try {
                            reply.postMessage(answer.put("id", id).toString())
                        } catch (_: Exception) {
                            // The page is gone.
                        }
                    }
                }
            }
        }
    }

    // ── Saving a file the page made (an attachment it loaded, an export) ──
    // The page sends it in pieces (src/lib/platform.ts) and waits for each
    // reply, so memory stays bounded. Files are written on one thread, in order;
    // `open` is only touched there.

    private class OpenFile(val name: String, val uri: Uri, val stream: OutputStream) {
        var lastUsed = System.currentTimeMillis()
    }

    private val files = Executors.newSingleThreadExecutor()
    private val open = HashMap<String, OpenFile>()

    private fun fileStep(reply: JavaScriptReplyProxy, data: JSONObject, step: (String) -> Boolean) {
        val id = data.optString("id").takeIf { validId(it) } ?: return
        onFiles {
            expireIdleFiles()
            val ok = try { step(id) } catch (_: Exception) { false }
            open[id]?.lastUsed = System.currentTimeMillis()
            if (!ok) abortFile(id)
            activity.runOnUiThread {
                try {
                    reply.postMessage(JSONObject().put("id", id).put("ok", ok).toString())
                } catch (_: Exception) {
                    // The page is gone.
                }
            }
        }
    }

    private fun onFiles(task: () -> Unit) {
        try {
            files.execute(task)
        } catch (_: RejectedExecutionException) {
            // Closed: the page is gone.
        }
    }

    private fun startFile(id: String, name: String, mime: String): Boolean {
        if (id in open || open.size >= MAX_OPEN_FILES) return false
        val fileName = safeFileName(name)
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        val stream = try {
            resolver.openOutputStream(uri) ?: error("No stream")
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
        open[id] = OpenFile(fileName, uri, stream)
        return true
    }

    private fun writeFile(id: String, base64: String): Boolean {
        val file = open[id] ?: return false
        file.stream.write(Base64.decode(base64, Base64.DEFAULT))
        return true
    }

    private fun finishFile(id: String): Boolean {
        val file = open.remove(id) ?: return false
        try {
            file.stream.close()
            val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
            activity.contentResolver.update(file.uri, values, null, null)
        } catch (error: Exception) {
            activity.contentResolver.delete(file.uri, null, null)
            throw error
        }
        activity.runOnUiThread {
            Toast.makeText(activity, activity.getString(R.string.download_saved, file.name), Toast.LENGTH_SHORT).show()
        }
        return true
    }

    // A page waits at most a minute for each reply, so a file untouched for
    // longer was given up.
    private fun expireIdleFiles() {
        val cutoff = System.currentTimeMillis() - IDLE_FILE_MS
        open.filterValues { it.lastUsed < cutoff }.keys.forEach(::abortFile)
    }

    // Failures are reported by the page, which may try another way.
    private fun abortFile(id: String) {
        val file = open.remove(id) ?: return
        try { file.stream.close() } catch (_: Exception) { }
        try { activity.contentResolver.delete(file.uri, null, null) } catch (_: Exception) { }
    }

    /**
     * Downloads a file the server streams (backups, attachments) with the
     * system download manager, which shows progress and survives the app
     * closing. Only the server's own addresses, with this app's session.
     */
    fun download(url: String, name: String, userAgent: String) {
        if (!ServerAddress.sameOrigin(origin, url)) return
        val fileName = safeFileName(name)
        val request = DownloadManager.Request(Uri.parse(url))
            .setTitle(fileName)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            .addRequestHeader("User-Agent", userAgent)
        CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
        try {
            activity.getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(activity, activity.getString(R.string.download_started, fileName), Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
            Toast.makeText(activity, R.string.download_failed, Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        const val NAME = "UniHubAndroid"
        private const val MAX_OPEN_FILES = 4
        private const val IDLE_FILE_MS = 2 * 60_000L
        private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel")

        private fun validId(id: String) = id.length in 1..64

        private fun parseColor(value: String): Int? =
            if (Regex("#[0-9a-fA-F]{6}").matches(value)) Color.parseColor(value) else null

        fun safeFileName(name: String): String =
            name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().trimStart('.').take(200).ifEmpty { "download" }

        /** Opens a link outside UniHub (a website, a mail or phone app). */
        fun openExternal(activity: Activity, url: String) {
            val uri = Uri.parse(url)
            if (uri.scheme?.lowercase() !in EXTERNAL_SCHEMES) return
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(activity, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
