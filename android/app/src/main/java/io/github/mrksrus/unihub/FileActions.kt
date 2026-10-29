package io.github.mrksrus.unihub

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.MediaStore
import android.util.Log
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
        val token = session.current()
        if (action !in ACTIONS || !ServerAddress.sameOrigin(origin, url) || !SharedFiles.isTicket(origin, url)) {
            done(activity.getString(R.string.files_refused))
            return
        }
        val fileName = WebBridge.safeFileName(name)
        try {
            pruneLater(activity)
            worker.execute {
                val error = try {
                    if (action == "save") save(url, fileName, mime) else share(action, url, fileName, mime, token)
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

    private fun share(action: String, url: String, name: String, mime: String, token: Long) {
        if (!session.isCurrent(token)) throw Problem(activity.getString(R.string.files_failed))
        val folder = File(sharedDir(activity), UUID.randomUUID().toString())
        if (!folder.mkdirs()) throw IOException("No cache folder")
        val file = File(folder, name)
        val type = try {
            fetch(url, name, mime) { download ->
                download.body.use { input -> file.outputStream().use { copy(input, it) } }
                download.type
            }.also {
                // Signed out while fetching: the copy must not outlive the session.
                if (!session.isCurrent(token)) throw Problem(activity.getString(R.string.files_failed))
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
        // The type Android's sheet gets, never the file's name: the emulator
        // checks read it (tools/e2e/android/file-actions.test.mjs and, with
        // the release build, scripts/android-server-check.mts).
        Log.i(TAG, "chooser $action $type")
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
        private const val TAG = "UniHubFiles"
        private val ACTIONS = setOf("open", "save", "share")
        // Larger than any mail the server accepts; a bound on the cache and on Downloads.
        private const val MAX_BYTES = 1L shl 30

        fun authority(context: Context) = "${context.packageName}.files"

        private fun sharedDir(context: Context) = File(context.cacheDir, "shared")
        private fun pickedDir(context: Context) = File(context.cacheDir, "picked")

        // The session the copies belong to (PickedFiles.Generation), and one
        // worker for copying picked files and for every cleanup, so a cleanup
        // never runs while a copy is being written and nothing is written
        // after it.
        val session = PickedFiles.Generation()
        private val copier = Executors.newSingleThreadExecutor()

        class PickedCopy(val uri: Uri, internal val folder: File)

        /**
         * Copies files picked for the page's file input into the app's cache,
         * as content:// addresses with the picked files' names (WebView 133 on
         * Android 16 reads a picker's own address as an empty file). The page
         * may read them for a while (a recording uploads in pieces), so they
         * are kept like the shared copies. Bounded per file, per pick and by
         * the phone's free space (PickedFiles); a file over a bound or
         * unreadable is listed in the outcome's `refused`. `done` runs on the
         * worker, with null when `alive` turned false meanwhile (the session
         * ended or the page stopped waiting; nothing kept).
         */
        fun copyPicked(context: Context, sources: List<Uri>, alive: () -> Boolean, done: (PickedFiles.Outcome<PickedCopy>?) -> Unit) {
            val app = context.applicationContext
            copier.execute {
                done(PickedFiles.copyAll(sources, { displayName(app, it) }, alive,
                    { source, limit -> copyOnePicked(app, source, limit, alive) }, { it.folder.deleteRecursively() }))
            }
        }

        /** Deletes copies the page did not get (the session ended before they were handed over). */
        fun discard(copies: List<PickedCopy>) {
            if (copies.isNotEmpty()) copier.execute { copies.forEach { it.folder.deleteRecursively() } }
        }

        private fun displayName(context: Context, source: Uri): String = try {
            context.contentResolver.query(source, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
            }
        } catch (_: Exception) {
            null
        } ?: source.lastPathSegment ?: "file"

        private fun declaredSize(context: Context, source: Uri): Long? = try {
            context.contentResolver.query(source, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0).takeIf { it >= 0 } else null
            }
        } catch (_: Exception) {
            null
        }

        private fun copyOnePicked(context: Context, source: Uri, limit: Long, alive: () -> Boolean): Pair<PickedCopy, Long> {
            val free = { context.cacheDir.usableSpace }
            // A size the provider states is refused before reading anything.
            declaredSize(context, source)?.let { size ->
                if (size > limit) throw PickedFiles.Refused(PickedFiles.Refusal.TOO_LARGE)
                if (free() - size < PickedFiles.RESERVE_BYTES) throw PickedFiles.Refused(PickedFiles.Refusal.NO_SPACE)
            }
            if (!alive()) throw PickedFiles.Cancelled()
            val folder = File(pickedDir(context), UUID.randomUUID().toString())
            if (!folder.mkdirs()) throw IOException("No cache folder")
            val file = File(folder, WebBridge.safeFileName(displayName(context, source)))
            try {
                val size = (context.contentResolver.openInputStream(source) ?: throw IOException("Unreadable")).use { input ->
                    file.outputStream().use { PickedFiles.copy(input, it, limit, free, alive) }
                }
                return PickedCopy(FileProvider.getUriForFile(context, authority(context), file), folder) to size
            } catch (error: Exception) {
                folder.deleteRecursively()
                throw error
            }
        }

        /** Deletes copies made longer ago than SharedFiles.MAX_AGE_MS, on the worker. */
        fun pruneLater(context: Context) {
            val app = context.applicationContext
            copier.execute { prune(app) }
        }

        private fun prune(context: Context) {
            val now = System.currentTimeMillis()
            for (dir in listOf(sharedDir(context), pickedDir(context))) {
                dir.listFiles()?.filter { SharedFiles.stale(it.lastModified(), now) }?.forEach { it.deleteRecursively() }
            }
        }

        /**
         * The person signed out or left the server: copies still being made
         * stop and hand nothing over, other apps lose their access to every
         * copy at once, and every copy is deleted after them.
         */
        fun endSession(context: Context) {
            session.next()
            val app = context.applicationContext
            // By path prefix: every address under the folder, whichever app was given it.
            for (folder in listOf("shared", "picked")) {
                app.revokeUriPermission(Uri.parse("content://${authority(app)}/$folder"), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            copier.execute { clear(app) }
        }

        /** The cached copy a content:// address of this app names, or null outside the copies' folders. */
        fun cachedFile(context: Context, uri: Uri): File? {
            val segments = uri.pathSegments
            if (segments.size != 3 || segments[0] !in setOf("shared", "picked", "update")) return null
            val root = File(context.cacheDir, segments[0]).canonicalFile
            val file = File(root, "${segments[1]}/${segments[2]}").canonicalFile
            return file.takeIf { it.parentFile?.parentFile == root }
        }

        /** Deletes every copy, on the calling thread (endSession runs it on the worker). */
        private fun clear(context: Context) {
            sharedDir(context).deleteRecursively()
            pickedDir(context).deleteRecursively()
        }
    }
}
