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
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

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
) {
    fun attach(webView: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(webView, NAME, setOf(origin)) { view, message, sourceOrigin, isMainFrame, _ ->
            if (!isMainFrame || !ServerAddress.sameOrigin(origin, sourceOrigin.toString())) return@addWebMessageListener
            handle(view, message)
        }
        return true
    }

    private fun handle(view: WebView, message: WebMessageCompat) {
        val data = try {
            JSONObject(message.data ?: return)
        } catch (_: org.json.JSONException) {
            return
        }
        when (data.optString("type")) {
            "saveFile" -> saveFile(data.optString("name"), data.optString("mime"), data.optString("data"))
            "download" -> download(data.optString("url"), data.optString("name"), view.settings.userAgentString)
            "openExternal" -> openExternal(activity, data.optString("url"))
            "changeServer" -> onChangeServer()
            "theme" -> parseColor(data.optString("background"))?.let { onTheme(data.optBoolean("dark", true), it) }
        }
    }

    /** Saves a file the page made (an attachment it loaded, an export) to Downloads. */
    private fun saveFile(name: String, mime: String, base64: String) {
        val fileName = safeFileName(name)
        Thread {
            val ok = try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val resolver = activity.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("No Downloads")
                try {
                    resolver.openOutputStream(uri)!!.use { it.write(bytes) }
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                } catch (error: Exception) {
                    resolver.delete(uri, null, null)
                    throw error
                }
                true
            } catch (_: Exception) {
                false
            }
            activity.runOnUiThread {
                val text = if (ok) activity.getString(R.string.download_saved, fileName) else activity.getString(R.string.download_failed)
                Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
            }
        }.start()
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
        private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel")

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
