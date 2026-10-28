package io.github.mrksrus.unihub

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * "Open with…", "Save to Downloads" and "Share" for a file of the server
 * (F8, F9). The page asks for a download ticket and passes its URL; the app
 * fetches the file with it and no cookie, so the session never leaves the
 * WebView. Open and Share hand Android's chooser a copy in the app's cache
 * through a FileProvider (read-only, for the chosen app only); Save writes to
 * Downloads through MediaStore. Copies are deleted after SharedFiles.MAX_AGE_MS
 * and all at once when the page signs out (MainActivity).
 */
class FileActions(private val activity: Activity, private val origin: String) {
    private val worker = Executors.newSingleThreadExecutor()

    /** Runs one action; `done` gets null when Android took it over, or the text to show. */
    fun run(action: String, url: String, name: String, mime: String, done: (String?) -> Unit) {
        if (action !in ACTIONS || !ServerAddress.sameOrigin(origin, url) || !SharedFiles.isTicket(origin, url)) {
            done(activity.getString(R.string.files_refused))
            return
        }
        val fileName = WebBridge.safeFileName(name)
        try {
            worker.execute {
                val error = try {
                    prune(activity)
                    if (action == "save") save(url, fileName, mime) else share(action, url, fileName, mime)
                    null
                } catch (problem: Problem) {
                    problem.message
                } catch (_: Exception) {
                    activity.getString(R.string.files_failed)
                }
                done(error)
            }
        } catch (_: RejectedExecutionException) {
            done(activity.getString(R.string.files_failed))
        }
    }

    fun close() {
        worker.shutdown()
    }

    private class Problem(message: String) : Exception(message)

    private class Download(val connection: HttpURLConnection, val type: String) {
        val body: InputStream get() = connection.inputStream
    }

    // The ticket answers once; a failed transfer is tried again with a new
    // ticket from the page.
    private fun <T> fetch(url: String, name: String, mime: String, use: (Download) -> T): T {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.setRequestProperty("User-Agent", "UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        try {
            val status = connection.responseCode
            if (status != 200) {
                val text = try { connection.errorStream?.use { it.readBytes().decodeToString() } } catch (_: IOException) { null }
                val error = text?.let { try { JSONObject(it).optString("error") } catch (_: org.json.JSONException) { null } }
                throw Problem(error?.takeIf { it.isNotBlank() && it.length < 200 } ?: activity.getString(R.string.files_failed))
            }
            val byExtension = SharedFiles.extension(name)?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
            return use(Download(connection, SharedFiles.mimeType(connection.contentType, mime, byExtension)))
        } finally {
            connection.disconnect()
        }
    }

    private fun copy(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > MAX_BYTES) throw Problem(activity.getString(R.string.files_too_large))
            output.write(buffer, 0, read)
        }
    }

    private fun share(action: String, url: String, name: String, mime: String) {
        val folder = File(sharedDir(activity), UUID.randomUUID().toString())
        if (!folder.mkdirs()) throw IOException("No cache folder")
        val file = File(folder, name)
        val type = try {
            fetch(url, name, mime) { download ->
                download.body.use { input -> file.outputStream().use { copy(input, it) } }
                download.type
            }
        } catch (error: Exception) {
            folder.deleteRecursively()
            throw error
        }
        val uri = FileProvider.getUriForFile(activity, authority(activity), file)
        val target = if (action == "open") {
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
        } else {
            Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
                .also { it.clipData = ClipData.newRawUri(name, uri) }
        }
        target.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val title = activity.getString(if (action == "open") R.string.files_open_with else R.string.files_share)
        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
            try {
                activity.startActivity(Intent.createChooser(target, title))
            } catch (_: Exception) {
                Toast.makeText(activity, R.string.files_no_app, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun save(url: String, name: String, mime: String) {
        val resolver = activity.contentResolver
        fetch(url, name, mime) { download ->
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, download.type)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("No Downloads entry")
            try {
                download.body.use { input -> (resolver.openOutputStream(uri) ?: throw IOException("No stream")).use { copy(input, it) } }
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } catch (error: Exception) {
                resolver.delete(uri, null, null)
                throw error
            }
        }
        activity.runOnUiThread {
            Toast.makeText(activity, activity.getString(R.string.download_saved, name), Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        private val ACTIONS = setOf("open", "save", "share")
        // Larger than any mail the server accepts; a bound on the cache and on Downloads.
        private const val MAX_BYTES = 1L shl 30

        fun authority(context: Context) = "${context.packageName}.files"

        private fun sharedDir(context: Context) = File(context.cacheDir, "shared")

        /** Deletes copies handed to other apps longer ago than SharedFiles.MAX_AGE_MS. */
        fun prune(context: Context) {
            val now = System.currentTimeMillis()
            sharedDir(context).listFiles()?.filter { SharedFiles.stale(it.lastModified(), now) }?.forEach { it.deleteRecursively() }
        }

        /** Deletes every copy: the person signed out or left the server. */
        fun clear(context: Context) {
            sharedDir(context).deleteRecursively()
        }
    }
}
