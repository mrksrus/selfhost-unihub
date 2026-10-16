package io.github.mrksrus.unihub

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import io.github.mrksrus.unihub.AppSession.Current
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Holds the app's connection to its server for notifications (AppNotifications).
 *
 * A foreground service, so Android keeps it running; Android requires it to
 * show an ongoing notification, which sits in a silent channel the person can
 * hide. It reads GET /api/notifications/android/stream: the server sends a
 * heartbeat every 45 seconds and each notification, encrypted for this
 * phone. A connection that stays silent for READ_TIMEOUT_MS is presumed dead
 * and replaced, as is one that changes network. It reconnects with a growing
 * pause after failures, and at least every ROTATE_MS, which also keeps the
 * session renewed. It stops when the session ends or notifications are
 * turned off; the shown notifications are removed then.
 */
class NotificationService : Service() {
    private val acks = Executors.newSingleThreadExecutor()
    // One connection loop at a time; a stopped one ends by itself.
    private class Run { @Volatile var stopped = false }
    @Volatile private var current: Run? = null
    @Volatile private var lastStart = 0
    @Volatile private var open: HttpURLConnection? = null
    private val wakeup = Object()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        AppNotifications.createChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // "Turn off" on the ongoing notification.
        if (intent?.action == ACTION_TURN_OFF) {
            ServerAddress.saved(this)?.let { origin -> Thread { AppNotifications.turnOff(this, origin) }.start() }
            return START_NOT_STICKY
        }
        lastStart = startId
        // Android requires the ongoing notification within seconds of the start.
        val origin = ServerAddress.saved(this)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(ONGOING_ID, ongoing(origin), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(ONGOING_ID, ongoing(origin))
            }
        } catch (error: RuntimeException) {
            // Not allowed from here (a background start on Android 12+); the
            // watchdog or the next start of the app tries again.
            Log.w(TAG, "Could not start: ${error.javaClass.simpleName}")
            stopSelf()
            return START_NOT_STICKY
        }
        val running = current
        if (running == null || running.stopped) {
            val next = Run()
            current = next
            Thread({ run(next) }, "UniHubNotifications").start()
            if (networkCallback == null) watchNetwork()
        } else {
            wake()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        current?.stopped = true
        connected = false
        networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        networkCallback = null
        open?.disconnect()
        wake()
        acks.shutdown()
        super.onDestroy()
    }

    // On the main thread, like onStartCommand, so a start cannot fall between
    // the check and stopSelf. A start that came first already replaced the
    // stopped run, and then this one does nothing.
    private val main = Handler(Looper.getMainLooper())
    private fun finish(run: Run) {
        run.stopped = true
        main.post { stopIfCurrent(run) }
    }

    private fun stopIfCurrent(run: Run) {
        if (current !== run) return
        open?.disconnect()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(lastStart)
    }

    private fun ongoing(origin: String?): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, AppNotifications.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.connection_title, origin?.let(ServerAddress::host) ?: getString(R.string.app_name)))
            .setContentText(getString(R.string.connection_text))
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, getString(R.string.connection_turn_off),
                PendingIntent.getService(this, 1, Intent(this, NotificationService::class.java).setAction(ACTION_TURN_OFF), PendingIntent.FLAG_IMMUTABLE)).build())
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }

    // A new network means the old connection is gone, even if no error says so yet.
    private fun watchNetwork() {
        val manager = getSystemService(ConnectivityManager::class.java)
        val callback = object : ConnectivityManager.NetworkCallback() {
            private var current: Network? = null
            override fun onAvailable(network: Network) {
                val previous = current
                current = network
                if (previous != null && previous != network) open?.disconnect()
                wake()
            }
            override fun onLost(network: Network) {
                if (network == current) {
                    current = null
                    open?.disconnect()
                }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: RuntimeException) {
            // Without it, the read timeout notices a dead connection.
        }
    }

    private fun wake() = synchronized(wakeup) { wakeup.notifyAll() }

    private fun pause(run: Run, ms: Long) = synchronized(wakeup) { if (!run.stopped) wakeup.wait(ms) }

    // ── The connection ─────────────────────────────────────────────────

    private enum class Outcome { Again, Failed, Stop, SignedOut }

    private fun run(run: Run) {
        var failures = 0
        while (!run.stopped) {
            val started = SystemClock.elapsedRealtime()
            val outcome = try {
                once(run)
            } catch (_: AppSession.Stale) {
                Outcome.Again
            } catch (error: IOException) {
                Log.i(TAG, "Connection ended: ${error.javaClass.simpleName}")
                Outcome.Failed
            } catch (error: Exception) {
                Log.w(TAG, "Connection failed: ${error.javaClass.simpleName}")
                Outcome.Failed
            }
            if (run.stopped) break
            when (outcome) {
                Outcome.Again -> {
                    failures = 0
                    // Registering again right away, but never in a tight loop.
                    if (SystemClock.elapsedRealtime() - started < 10_000) pause(run, 5_000)
                }
                Outcome.Failed -> {
                    // A connection that was up for a while was not a failure to connect.
                    failures = if (SystemClock.elapsedRealtime() - started > 60_000) 1 else failures + 1
                    val wait = minOf(MAX_PAUSE_MS, 1000L shl minOf(failures, 9))
                    pause(run, wait + (Math.random() * wait / 4).toLong())
                }
                Outcome.SignedOut -> {
                    Log.i(TAG, "Signed out: notifications stop until the next sign-in")
                    AppNotifications.clearShown(this)
                    finish(run)
                }
                Outcome.Stop -> finish(run)
            }
        }
    }

    private fun once(run: Run): Outcome {
        val origin = ServerAddress.saved(this) ?: return Outcome.Stop
        AppSession.renewSession(this)
        val session = AppSession.cookie(origin)?.takeIf { "auth-token=" in it } ?: return Outcome.SignedOut
        val current = Current { !run.stopped && ServerAddress.saved(this) == origin && AppSession.sessionOf(AppSession.cookie(origin)) == AppSession.sessionOf(session) }
        val user = AppNotifications.signedInUser(this, origin, session, current) ?: return Outcome.SignedOut
        current.check()
        if (!AppNotifications.enabled(this, origin, user)) return Outcome.Stop
        val device = AppNotifications.ensureDevice(this, origin, session, user, current)
        return listen(run, origin, session, device, current)
    }

    private fun listen(run: Run, origin: String, session: String, device: AppNotifications.Device, current: Current): Outcome {
        val path = "/api/notifications/android/stream?device=" + URLEncoder.encode(device.id, "UTF-8")
        val connection = AppSession.open(this, origin, path, session, READ_TIMEOUT_MS)
        connection.setRequestProperty("Accept", "text/event-stream")
        open = connection
        try {
            val status = connection.responseCode
            AppSession.keepRenewals(this, origin, session, connection, current)
            when (status) {
                200 -> {}
                401 -> return Outcome.SignedOut
                // The server no longer knows this device: register again.
                404 -> { AppNotifications.forgetDevice(this, origin, device); return Outcome.Again }
                else -> throw IOException("HTTP $status")
            }
            connected = true
            Log.i(TAG, "Connected")
            val since = SystemClock.elapsedRealtime()
            val events = EventReader(connection.inputStream)
            while (!run.stopped) {
                val (type, data) = events.next() ?: throw IOException("Stream closed")
                when (type) {
                    EventReader.HEARTBEAT -> {}
                    "notification" -> receive(origin, session, device, JSONObject(data), current)
                    // The server checks the session at every heartbeat.
                    "end" -> return if (JSONObject(data).optString("reason") == "shutdown") Outcome.Failed else Outcome.Again
                }
                if (SystemClock.elapsedRealtime() - since > ROTATE_MS) return Outcome.Again
            }
            return Outcome.Stop
        } finally {
            connected = false
            open = null
            connection.disconnect()
        }
    }

    private fun receive(origin: String, session: String, device: AppNotifications.Device, message: JSONObject, current: Current) {
        val id = message.optString("id").takeIf { it.length in 1..64 } ?: return
        val lock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "UniHub:notification")
        lock.acquire(10_000)
        // Shown, skipped or unreadable: in each case it must not come again.
        AppNotifications.show(this, origin, device, id, message.optString("body"))
        try {
            acks.execute {
                try {
                    if (!AppNotifications.acknowledge(this, origin, session, device, listOf(id), current)) Log.i(TAG, "Acknowledgement refused; the server sends it again")
                } catch (_: Exception) {
                    // The server sends it again, and it is not shown twice.
                } finally {
                    if (lock.isHeld) lock.release()
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            if (lock.isHeld) lock.release()
        }
    }

    /** Server-Sent Events, with a bound on how much one event may hold. */
    private class EventReader(input: InputStream) {
        private val reader = input.bufferedReader(Charsets.UTF_8)

        companion object {
            // A comment line: the server's heartbeat.
            const val HEARTBEAT = ":"
        }

        fun next(): Pair<String, String>? {
            var type = "message"
            val data = StringBuilder()
            while (true) {
                val line = line() ?: return null
                if (line.isEmpty()) {
                    if (data.isNotEmpty()) return type to data.toString()
                    type = "message"
                    continue
                }
                if (line.startsWith(":")) return HEARTBEAT to ""
                val field = line.substringBefore(':')
                val value = line.substringAfter(':', "").removePrefix(" ")
                when (field) {
                    "event" -> type = value
                    "data" -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(value)
                        if (data.length > MAX_EVENT) throw IOException("Event too large")
                    }
                }
            }
        }

        private fun line(): String? {
            val text = StringBuilder()
            while (true) {
                val char = reader.read()
                if (char < 0) return if (text.isEmpty()) null else text.toString()
                if (char == '\n'.code) return text.toString().removeSuffix("\r")
                text.append(char.toChar())
                if (text.length > MAX_EVENT) throw IOException("Line too long")
            }
        }
    }

    // ── Starting it ────────────────────────────────────────────────────

    /** Brings it back after a restart of the phone or an update of the app. */
    class Restart : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
            if (startIfWanted(context)) scheduleWatchdog(context)
        }
    }

    /**
     * Starts the service again if something stopped it (a phone that ends
     * background apps). Android allows that from here only for an app it
     * lets run in the background.
     */
    class Watchdog : JobService() {
        override fun onStartJob(params: JobParameters?): Boolean {
            if (!startIfWanted(this)) getSystemService(JobScheduler::class.java).cancel(WATCHDOG_JOB)
            return false
        }
        override fun onStopJob(params: JobParameters?) = false
    }

    companion object {
        private const val TAG = "UniHubNotifications"
        const val ONGOING_ID = 1
        private const val ACTION_TURN_OFF = "io.github.mrksrus.unihub.TURN_OFF_NOTIFICATIONS"
        private const val WATCHDOG_JOB = 1
        // Two heartbeats (45 seconds each) and a margin.
        private const val READ_TIMEOUT_MS = 120_000
        private const val ROTATE_MS = 12 * 60 * 60_000L
        private const val MAX_PAUSE_MS = 5 * 60_000L
        private const val MAX_EVENT = 64 * 1024

        @Volatile var connected = false
            private set

        fun start(context: Context): Boolean = try {
            context.startForegroundService(Intent(context, NotificationService::class.java))
            true
        } catch (error: RuntimeException) {
            Log.w(TAG, "Could not start: ${error.javaClass.simpleName}")
            false
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, NotificationService::class.java))
            context.getSystemService(JobScheduler::class.java).cancel(WATCHDOG_JOB)
        }

        /** Starts it when notifications are on for this server and the app is signed in. */
        fun startIfWanted(context: Context): Boolean {
            val origin = ServerAddress.saved(context) ?: return false
            if (!AppNotifications.wantedOn(context, origin)) return false
            if (AppSession.cookie(origin)?.contains("auth-token=") != true) return false
            if (!connected) start(context)
            // Signing in again or coming back to this server brings the check back too.
            scheduleWatchdog(context)
            return true
        }

        // Scheduling again would restart its 15 minutes, so only when there is none.
        fun scheduleWatchdog(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (scheduler.getPendingJob(WATCHDOG_JOB) != null) return
            val job = JobInfo.Builder(WATCHDOG_JOB, ComponentName(context, Watchdog::class.java))
                .setPeriodic(TimeUnit.MINUTES.toMillis(15))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build()
            scheduler.schedule(job)
        }
    }
}
