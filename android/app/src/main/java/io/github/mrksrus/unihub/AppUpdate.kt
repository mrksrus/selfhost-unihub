package io.github.mrksrus.unihub

import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

/**
 * The app update the page downloads (B-24). Opened from the download
 * manager's own "complete" notification, Android's installer counts the
 * download manager as the source of the APK and refuses it ("isn't allowed
 * to install unknown apps from this source"), so the update could only be
 * installed from the Files app. The update is therefore downloaded without
 * that notification, and UniHub opens the installer itself when the download
 * completes: at once while the app is on screen, otherwise when the app is
 * next opened, which its own notification does. Android then asks once to
 * allow UniHub to install apps (REQUEST_INSTALL_PACKAGES).
 *
 * With that permission an unrelated app at the update's address would be
 * installed as well, so the download is copied into the app's cache and the
 * installer gets only that copy, once UpdateCheck has found it to be this app
 * by the same signers; anything else is deleted and nothing is installed.
 */
object AppUpdate {
    private const val TAG = "UniHubUpdate"
    /** The server's APK (api/src/services/app-version.ts ANDROID_APK_URL). */
    private const val PATH = "/downloads/unihub.apk"
    private const val MIME = "application/vnd.android.package-archive"
    private const val PREFS = "app_update"
    private const val KEY_DOWNLOADING = "downloading"
    /** The folder under update/ of the checked copy not yet offered. */
    private const val KEY_READY = "ready"
    private const val FILE = "unihub.apk"
    // Far above the app's size: a bound on the copy in the cache.
    private const val MAX_BYTES = 200L shl 20
    private const val CHANNEL = "app_update"
    private const val NOTIFICATION_TAG = "app_update"

    /** Whether the main screen is in front, so the installer may be opened at once. */
    @Volatile var inFront = false

    fun isUpdate(url: String) = Uri.parse(url).path == PATH

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun downloading(context: Context, id: Long) {
        prefs(context).edit().putLong(KEY_DOWNLOADING, id).remove(KEY_READY).apply()
        val app = context.applicationContext
        worker.execute { updateDir(app).deleteRecursively() }
    }

    private val worker = Executors.newSingleThreadExecutor()

    /** Where the checked copies are; FilesProvider serves them as "update". */
    private fun updateDir(context: Context) = File(context.cacheDir, "update")

    private fun signers(info: PackageInfo): Set<String> {
        val signing = info.signingInfo ?: return emptySet()
        val certificates = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        return certificates.orEmpty().map { certificate ->
            MessageDigest.getInstance("SHA-256").digest(certificate.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private fun apk(info: PackageInfo?) = info?.let { UpdateCheck.Apk(it.packageName, it.longVersionCode, signers(it)) }

    /** Whether the copy at [file] may go to the installer: null if so. */
    private fun check(context: Context, file: File): UpdateCheck.Refusal? {
        val packages = context.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val (installed, update) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val of = PackageManager.PackageInfoFlags.of(flags.toLong())
            packages.getPackageInfo(context.packageName, of) to packages.getPackageArchiveInfo(file.path, of)
        } else {
            @Suppress("DEPRECATION")
            packages.getPackageInfo(context.packageName, flags) to packages.getPackageArchiveInfo(file.path, flags)
        }
        return UpdateCheck.refusal(apk(installed)!!, apk(update))
    }

    /** Copies the finished download [id] into the cache; null if it did not finish or cannot be read. */
    private fun copy(context: Context, manager: DownloadManager, id: Long): File? {
        val done = manager.query(DownloadManager.Query().setFilterById(id)).use { row ->
            row.moveToFirst() && row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL
        }
        if (!done) return null
        val folder = File(updateDir(context), UUID.randomUUID().toString())
        if (!folder.mkdirs()) return null
        val file = File(folder, FILE)
        try {
            ParcelFileDescriptor.AutoCloseInputStream(manager.openDownloadedFile(id)).use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > MAX_BYTES) throw IllegalStateException("too large")
                        output.write(buffer, 0, read)
                    }
                }
            }
        } catch (error: Exception) {
            folder.deleteRecursively()
            throw error
        }
        return file
    }

    private fun installer(context: Context, file: File): Intent =
        Intent(Intent.ACTION_VIEW).setDataAndType(FileProvider.getUriForFile(context, FileActions.authority(context), file), MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun open(context: Context, file: File): Boolean = try {
        // FilesProvider refuses copies older than SharedFiles.MAX_AGE_MS; this one is offered now.
        file.setLastModified(System.currentTimeMillis())
        context.startActivity(installer(context, file))
        true
    } catch (error: Exception) {
        Log.w(TAG, "The installer could not be opened: ${error.javaClass.simpleName}")
        false
    }

    /** A download of the app finished: checked, the update is offered for installing. Runs on the worker. */
    private fun completed(context: Context, id: Long) {
        val prefs = prefs(context)
        if (id < 0 || prefs.getLong(KEY_DOWNLOADING, -1) != id) return
        prefs.edit().remove(KEY_DOWNLOADING).apply()
        val manager = context.getSystemService(DownloadManager::class.java)
        var file: File? = null
        val refusal = try {
            file = copy(context, manager, id) ?: return
            check(context, file)
        } catch (error: Exception) {
            Log.w(TAG, "The downloaded update could not be checked: ${error.javaClass.simpleName}")
            UpdateCheck.Refusal.UNREADABLE
        }
        if (refusal != null) {
            Log.w(TAG, "The downloaded update was refused: $refusal")
            file?.parentFile?.deleteRecursively()
            // Also deletes the downloaded file in Downloads, so it is not opened from Files either.
            try { manager.remove(id) } catch (_: Exception) { }
            refused(context, refusal)
            return
        }
        val checked = file ?: return
        if (inFront && open(context, checked)) return
        prefs.edit().putString(KEY_READY, checked.parentFile!!.name).apply()
        notifyReady(context)
    }

    /** The app came to the front with a checked update not yet offered: the installer opens. */
    fun offerReady(context: Context) {
        val prefs = prefs(context)
        val folder = prefs.getString(KEY_READY, null) ?: return
        prefs.edit().remove(KEY_READY).apply()
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_TAG, 0)
        val file = File(File(updateDir(context), folder), FILE)
        if (file.isFile) open(context, file)
    }

    /** Says plainly that nothing was installed: on screen, or in a notification. */
    private fun refused(context: Context, refusal: UpdateCheck.Refusal) {
        val text = context.getString(when (refusal) {
            UpdateCheck.Refusal.NOT_UNIHUB -> R.string.update_refused_not_unihub
            UpdateCheck.Refusal.OLDER -> R.string.update_refused_older
            UpdateCheck.Refusal.UNREADABLE -> R.string.update_refused_unreadable
        })
        if (inFront) {
            Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_LONG).show() }
            return
        }
        notify(context, context.getString(R.string.update_refused_title), text)
    }

    // Tapping it opens the app, which opens the installer (offerReady).
    private fun notifyReady(context: Context) =
        notify(context, context.getString(R.string.update_ready_title), context.getString(R.string.update_ready_text))

    private fun notify(context: Context, title: String, text: String) {
        val app = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channel_app_update), NotificationManager.IMPORTANCE_DEFAULT))
        val notification = android.app.Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.accent))
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(PendingIntent.getActivity(context, 0, app, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(NOTIFICATION_TAG, 0, notification)
        } catch (_: SecurityException) {
            // Notifications are not allowed: a checked update opens when the app is next opened.
        }
    }

    /** Android's "download complete" broadcast, sent only by the download manager. */
    class Downloaded : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
            val app = context.applicationContext
            // Copying and checking the APK takes longer than a receiver may block.
            val pending = goAsync()
            worker.execute {
                try {
                    completed(app, id)
                } finally {
                    pending.finish()
                }
            }
        }
    }
}
