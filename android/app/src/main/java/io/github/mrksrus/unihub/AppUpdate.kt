package io.github.mrksrus.unihub

import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

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
 */
object AppUpdate {
    private const val TAG = "UniHubUpdate"
    /** The server's APK (api/src/services/app-version.ts ANDROID_APK_URL). */
    private const val PATH = "/downloads/unihub.apk"
    private const val MIME = "application/vnd.android.package-archive"
    private const val PREFS = "app_update"
    private const val KEY_DOWNLOADING = "downloading"
    private const val KEY_READY = "ready"
    private const val CHANNEL = "app_update"
    private const val NOTIFICATION_TAG = "app_update"

    /** Whether the main screen is in front, so the installer may be opened at once. */
    @Volatile var inFront = false

    fun isUpdate(url: String) = Uri.parse(url).path == PATH

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun downloading(context: Context, id: Long) {
        prefs(context).edit().putLong(KEY_DOWNLOADING, id).remove(KEY_READY).apply()
    }

    /** The installer for a finished download of the update, or null. */
    private fun installer(context: Context, id: Long): Intent? = try {
        val manager = context.getSystemService(DownloadManager::class.java)
        val done = manager.query(DownloadManager.Query().setFilterById(id)).use { row ->
            row.moveToFirst() && row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL
        }
        manager.getUriForDownloadedFile(id)?.takeIf { done }?.let { uri ->
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    } catch (error: Exception) {
        Log.w(TAG, "The downloaded update could not be found: ${error.javaClass.simpleName}")
        null
    }

    private fun open(context: Context, install: Intent): Boolean = try {
        context.startActivity(install)
        true
    } catch (error: Exception) {
        Log.w(TAG, "The installer could not be opened: ${error.javaClass.simpleName}")
        false
    }

    /** A download of the app finished: the update is offered for installing. */
    fun completed(context: Context, id: Long) {
        val prefs = prefs(context)
        if (id < 0 || prefs.getLong(KEY_DOWNLOADING, -1) != id) return
        prefs.edit().remove(KEY_DOWNLOADING).apply()
        val install = installer(context, id) ?: return
        if (inFront && open(context, install)) return
        prefs.edit().putLong(KEY_READY, id).apply()
        notifyReady(context)
    }

    /** The app came to the front with a finished update not yet offered: the installer opens. */
    fun offerReady(context: Context) {
        val prefs = prefs(context)
        val id = prefs.getLong(KEY_READY, -1)
        if (id < 0) return
        prefs.edit().remove(KEY_READY).apply()
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_TAG, 0)
        installer(context, id)?.let { open(context, it) }
    }

    // Tapping it opens the app, which opens the installer (offerReady).
    private fun notifyReady(context: Context) {
        val app = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channel_app_update), NotificationManager.IMPORTANCE_DEFAULT))
        val notification = android.app.Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.accent))
            .setContentTitle(context.getString(R.string.update_ready_title))
            .setContentText(context.getString(R.string.update_ready_text))
            .setContentIntent(PendingIntent.getActivity(context, 0, app, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(NOTIFICATION_TAG, 0, notification)
        } catch (_: SecurityException) {
            // Notifications are not allowed: the installer opens when the app is next opened.
        }
    }

    /** Android's "download complete" broadcast, sent only by the download manager. */
    class Downloaded : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            completed(context, intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1))
        }
    }
}
