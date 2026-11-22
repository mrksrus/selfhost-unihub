package io.github.mrksrus.unihub

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telecom.DisconnectCause
import android.util.Log
import android.widget.Toast
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executor

/**
 * The call, as Telecom holds it (through Core-Telecom), and, while a call is
 * answered or placed, the foreground service that keeps its sound running
 * with the screen off. Telecom shows nothing for the app's calls: the ring is
 * this service's notification, full screen over the lock screen, with the
 * ringtone. One call at a time; everything runs on the main thread.
 *
 * The call page (CallActivity) talks to the server while it lives; whatever
 * the app ends by itself (Decline, the notification's Hang up, Back, Telecom,
 * a call that never connects) it also tells the server, so a dead page
 * leaves nobody ringing.
 */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(Calls.EXTRA_ID)
        when (intent?.action) {
            ACTION_ONGOING -> {
                // Android requires startForeground after startForegroundService, even for a call that just ended.
                val call = current?.takeIf { it.id == id && it.active }
                val notification = if (call != null) ongoing(call) else ongoingFallback(this)
                try {
                    startForeground(CALL_ID, notification, types(this, call != null))
                } catch (error: RuntimeException) {
                    // Nothing of the app on screen (a headset's answer): no microphone type until the call screen asks again.
                    Log.w(TAG, "No microphone for the call's service: ${error.javaClass.simpleName}")
                    try {
                        startForeground(CALL_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
                    } catch (again: RuntimeException) {
                        Log.w(TAG, "No foreground service for the call: ${again.javaClass.simpleName}")
                        getSystemService(NotificationManager::class.java).cancel(CALL_ID)
                    }
                }
                if (call == null) stop(this) else service = this
            }
            ACTION_DECLINE -> id?.let { ended(it, DisconnectCause.REJECTED, server = true); dismissStale(this) }
            ACTION_HANG_UP -> id?.let { ended(it, DisconnectCause.LOCAL, server = true); dismissStale(this) }
        }
        // Started only for a button: nothing to keep running.
        if (service !== this) stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (service === this) service = null
        super.onDestroy()
    }

    /**
     * One call. `id` is the app's own: the server's for a call that rang here,
     * a made-up one for a call placed here until the page names the server's.
     */
    class Call(val context: Context, val id: String, val name: String, val origin: String, val peer: String?) {
        val outgoing = peer != null
        var serverId: String? = if (outgoing) null else id
        /** Answered by Telecom or the app; the page then answers at the server. */
        var answered = false
        /** Holds the foreground service: answered or placed. */
        var active = false
        /** The server has the call as answered (the page said "connecting" or later). */
        var atServer = false
        var everActive = false
        var state = if (outgoing) "calling" else "ringing"
        var activeSince = 0L
        var control: CallControlScope? = null
        var job: Job? = null
        var endpoints: List<CallEndpointCompat> = emptyList()
        var endpoint: CallEndpointCompat? = null
        var telecomMuted = false

        fun routes(): JSONArray = JSONArray().apply {
            for (each in endpoints) {
                val kind = Calls.routeKind(each.type) ?: continue
                put(JSONObject().put("id", each.identifier.toString()).put("kind", kind).put("name", each.name.toString())
                    .put("active", each.identifier == endpoint?.identifier))
            }
        }

        fun route(id: String) {
            val control = control ?: return
            val wanted = endpoints.firstOrNull { it.identifier.toString() == id } ?: return
            control.launch { Log.i(TAG, "Route ${wanted.type}: ${control.requestEndpointChange(wanted)}") }
        }
    }

    companion object {
        private const val TAG = "UniHubCalls"
        private const val CHANNEL_RING = "call-ring"
        private const val CHANNEL_CALL = "call"
        // One notification for the ring and the call: the answer updates it in place.
        private const val CALL_ID = 2
        private const val RING_MS = 45_000L
        // An answered call whose page has not connected by then ends; Telecom that has not taken a call by then failed.
        private const val CONNECT_MS = 30_000L
        private const val TELECOM_MS = 10_000L
        private const val ACTION_ONGOING = "io.github.mrksrus.unihub.CALL_ONGOING"
        private const val ACTION_DECLINE = "io.github.mrksrus.unihub.CALL_DECLINE"
        private const val ACTION_HANG_UP = "io.github.mrksrus.unihub.CALL_HANG_UP"

        private val main = Handler(Looper.getMainLooper())
        // A failed call is logged; it must not take the notification connection down with it.
        private val scope = CoroutineScope(SupervisorJob() + Executor { main.post(it) }.asCoroutineDispatcher() +
            CoroutineExceptionHandler { _, error -> Log.w(TAG, "Call failed: ${error.javaClass.simpleName}") })
        var current: Call? = null
            private set
        private var service: CallService? = null
        private val recent = ArrayDeque<String>()

        /** The call screen: a message for its page (`{type: "call", command | routes}`), or null when the call ended here. */
        var toPage: ((call: Call, message: JSONObject?) -> Unit)? = null

        /** A call this phone rings for, holds, or ended a while ago: a repeated message is ignored. */
        fun known(id: String) = current?.id == id || current?.serverId == id || id in recent

        fun of(id: String?) = current?.takeIf { id != null && it.id == id }

        private fun tell(call: Call, message: JSONObject?) {
            try { toPage?.invoke(call, message) } catch (_: RuntimeException) { /* The screen is going. */ }
        }

        private fun command(call: Call, name: String) = JSONObject().put("type", "call").put("command", name).put("id", call.serverId)

        /** Hands an incoming call to Telecom and rings once Telecom has it. */
        fun ring(context: Context, origin: String, id: String, name: String) {
            if (known(id)) return
            // One call at a time: the caller hears at once that this phone cannot take it.
            if (current != null) return endAtServer(context, origin, id, failed = true)
            val call = Call(context, id, name, origin, peer = null).also { current = it }
            call.job = scope.launch {
                try {
                    addCall(context, call, CallAttributesCompat.DIRECTION_INCOMING) {
                        // An `end` that came while Telecom was taking the call.
                        if (current === call) showRing(context, call) else hangUp(call, DisconnectCause.REMOTE)
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    // Telecom refused: a mobile call, no phone account, or calls turned off for the app.
                    Log.w(TAG, "The call failed: ${error.javaClass.simpleName}")
                    ended(id, DisconnectCause.ERROR, server = true, failed = true)
                }
            }
            main.postDelayed({ if (current === call && call.control == null) ended(id, DisconnectCause.ERROR, server = true, failed = true) }, TELECOM_MS)
            // Not answered at the server by then: the server made it a missed call.
            main.postDelayed({ if (current === call && !call.atServer) ended(id, DisconnectCause.MISSED) }, RING_MS)
        }

        /** Places a call from the app's "Call": Telecom first, then the call screen, whose page starts it at the server. */
        fun place(context: Context, origin: String, peer: String, name: String) {
            current?.let { if (it.active) show(it); return }
            val call = Call(context.applicationContext, "out-" + UUID.randomUUID(), name, origin, peer).also { current = it }
            call.job = scope.launch {
                try {
                    addCall(call.context, call, CallAttributesCompat.DIRECTION_OUTGOING) {
                        if (current !== call) return@addCall hangUp(call, DisconnectCause.LOCAL)
                        call.active = true
                        foreground(call.context, call.id)
                        try {
                            context.startActivity(CallActivity.intent(context, call.id, answer = false))
                        } catch (error: RuntimeException) {
                            Log.w(TAG, "Could not show the call: ${error.javaClass.simpleName}")
                            ended(call.id, DisconnectCause.ERROR)
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    Log.w(TAG, "The call could not be placed: ${error.javaClass.simpleName}")
                    ended(call.id, DisconnectCause.ERROR)
                    Toast.makeText(context, R.string.call_not_placed, Toast.LENGTH_LONG).show()
                }
            }
            // The page names the server's call, or it never started one.
            expect(call, CONNECT_MS) { it.serverId != null }
        }

        private suspend fun addCall(context: Context, call: Call, direction: Int, then: CallControlScope.() -> Unit) {
            val telecom = CallsManager(context)
            telecom.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
            val address = Uri.fromParts("unihub", call.peer ?: call.id, null)
            telecom.addCall(
                CallAttributesCompat(call.name, address, direction, CallAttributesCompat.CALL_TYPE_AUDIO_CALL, callCapabilities = 0),
                // Telecom answered: a headset, a car or a watch.
                onAnswer = { call.answered = true; started(call, show = true) },
                onDisconnect = { cause -> ended(call.id, cause.code, tellTelecom = false, server = true) },
                onSetActive = {},
                // Telecom holds the call for another one (a mobile call answered): there is no hold, so it ends.
                onSetInactive = { ended(call.id, DisconnectCause.LOCAL, server = true) },
            ) {
                call.control = this
                launch { availableEndpoints.collect { call.endpoints = it; Log.i(TAG, "Routes: ${it.map { e -> e.type }}"); routesChanged(call) } }
                launch { currentCallEndpoint.collect { call.endpoint = it; routesChanged(call) } }
                // A mute by Telecom (a car, a headset) reaches the page; the page's own mute stays its own.
                launch { isMuted.collect { muted -> call.telecomMuted = muted; tell(call, command(call, "mute").put("muted", muted)) } }
                then()
            }
        }

        private fun routesChanged(call: Call) {
            if (current === call) tell(call, JSONObject().put("type", "call").put("routes", call.routes()))
        }

        /** Answers the ringing call from the app (its notification, its call screen or its page). */
        fun answer(id: String) {
            val call = current?.takeIf { it.id == id && !it.answered } ?: return
            val control = call.control ?: return
            call.answered = true
            control.launch {
                if (control.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) is CallControlResult.Success) started(call, show = false)
                else ended(id, DisconnectCause.ERROR, server = true, failed = true)
            }
        }

        /** The call is answered: it runs in a foreground service, whose notification replaces the ring; the page answers at the server. */
        private fun started(call: Call, show: Boolean) {
            if (current !== call || call.active) return
            call.active = true
            val context = call.context
            foreground(context, call.id)
            if (show) show(call)
            tell(call, command(call, "answer"))
        }

        private fun show(call: Call) {
            try {
                call.context.startActivity(CallActivity.intent(call.context, call.id, answer = false))
            } catch (error: RuntimeException) {
                // Android refuses a screen of an app in the background: the notification says how to get it.
                Log.w(TAG, "Could not show the call: ${error.javaClass.simpleName}")
            }
        }

        /** What the call screen's page reported. */
        fun reported(id: String, report: PageReport) {
            // "none": the page has not found the call yet, or no longer shows one.
            val call = current?.takeIf { it.id == id && report.state != "none" } ?: return
            if (call.outgoing && report.id != null && call.serverId == null) call.serverId = report.id
            val before = call.state
            call.state = report.state
            when (report.state) {
                "connecting", "active", "reconnecting" -> {
                    if (!call.atServer) {
                        call.atServer = true
                        // The page's own Answer: Telecom answers too.
                        if (!call.outgoing && !call.answered) answer(call.id)
                        expect(call, CONNECT_MS) { it.everActive }
                    }
                    if (report.state == "active" && !call.everActive) {
                        call.everActive = true
                        call.activeSince = System.currentTimeMillis()
                        if (call.outgoing) call.control?.let { control -> control.launch { control.setActive() } }
                    }
                }
                // The page told the server; the native call ends with it.
                "ended" -> return ended(id, DisconnectCause.REMOTE)
            }
            // The page unmuted while Telecom had the microphone muted.
            if (!report.muted && call.telecomMuted) call.context.getSystemService(AudioManager::class.java).isMicrophoneMute = false
            if (before != call.state) refresh(call)
        }

        /** The page has the call's state from the start; one that gets nowhere within `ms` ends as failed. */
        private fun expect(call: Call, ms: Long, done: (Call) -> Boolean) {
            main.postDelayed({ if (current === call && !done(call)) ended(call.id, DisconnectCause.ERROR, server = true, failed = true) }, ms)
        }

        /** An `end` from the server or the main page: a call that rings here stops; one answered at the server goes on. */
        fun stopRinging(id: String) {
            val call = current?.takeIf { it.serverId == id && !it.atServer } ?: return
            ended(call.id, DisconnectCause.REMOTE)
        }

        /** Runs the answered call in the foreground service; again from the call screen, which may give it the microphone. */
        fun foreground(context: Context, id: String) {
            try {
                context.startForegroundService(Intent(context, CallService::class.java).setAction(ACTION_ONGOING).putExtra(Calls.EXTRA_ID, id))
            } catch (error: RuntimeException) {
                Log.w(TAG, "Could not start the call's service: ${error.javaClass.simpleName}")
                // Android posts a call-style notification only for a foreground service: at least the ring stops.
                context.getSystemService(NotificationManager::class.java).cancel(CALL_ID)
            }
        }

        /**
         * Ends the call, whoever ended it: Telecom, the notification, the call
         * screen, its page or the server. `server`: the app ended it, so it
         * tells the server too (the page, if it lives, does as well).
         */
        fun ended(id: String, cause: Int, tellTelecom: Boolean = true, server: Boolean = false, failed: Boolean = false) {
            val call = current?.takeIf { it.id == id } ?: return
            current = null
            recent.addLast(call.id)
            call.serverId?.let { if (it != call.id) recent.addLast(it) }
            while (recent.size > 20) recent.removeFirst()
            if (server) {
                call.serverId?.let { endAtServer(call.context, call.origin, it, failed) }
                tell(call, command(call, if (call.state == "ringing") "decline" else "hangUp"))
            }
            if (tellTelecom) hangUp(call, cause) else main.post { call.job?.cancel() }
            service?.let(::stop)
            call.context.getSystemService(NotificationManager::class.java).cancel(CALL_ID)
            tell(call, null)
        }

        /** POST /api/chat/calls/:id/end with the app's session, off the main thread; an ended call is answered as it is. */
        private fun endAtServer(context: Context, origin: String, id: String, failed: Boolean) {
            val app = context.applicationContext
            Thread {
                try {
                    val session = AppSession.cookie(origin) ?: return@Thread
                    val body = JSONObject().apply { if (failed) put("failed", true) }
                    val status = AppSession.request(app, origin, "POST", "/api/chat/calls/$id/end", session, AppSession.Current { true }, body).status
                    Log.i(TAG, "Ended at the server: $status")
                } catch (error: Exception) {
                    // Offline: the server's own time limits end it.
                    Log.w(TAG, "Could not tell the server: ${error.javaClass.simpleName}")
                }
            }.start()
        }

        /** A ring or call notification left behind for a call this process no longer holds (it died meanwhile). */
        fun dismissStale(context: Context) {
            if (current == null) context.getSystemService(NotificationManager::class.java).cancel(CALL_ID)
        }

        // Before Telecom has the call, `ring` hangs up once it does. Not in the call's own scope, which a failure cancels.
        private fun hangUp(call: Call, cause: Int) {
            val control = call.control ?: return run { call.job?.cancel() }
            scope.launch {
                control.disconnect(DisconnectCause(cause))
                call.job?.cancel()
            }
        }

        private fun stop(service: CallService) {
            service.stopForeground(STOP_FOREGROUND_REMOVE)
            service.stopSelf()
            if (CallService.service === service) CallService.service = null
        }

        private fun types(context: Context, call: Boolean): Int {
            val microphone = call && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            return ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or (if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        }

        private fun channels(context: Context): NotificationManager {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannels(listOf(
                NotificationChannel(CHANNEL_RING, context.getString(R.string.channel_call_ring), NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    enableVibration(true)
                },
                NotificationChannel(CHANNEL_CALL, context.getString(R.string.channel_call), NotificationManager.IMPORTANCE_LOW),
            ))
            return manager
        }

        private fun screen(context: Context, id: String, answer: Boolean, request: Int) =
            PendingIntent.getActivity(context, request, CallActivity.intent(context, id, answer),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        private fun action(context: Context, action: String, id: String, request: Int) =
            PendingIntent.getService(context, request, Intent(context, CallService::class.java).setAction(action).putExtra(Calls.EXTRA_ID, id),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        private fun showRing(context: Context, call: Call) {
            val manager = channels(context)
            val answer = screen(context, call.id, answer = true, request = 1)
            val decline = action(context, ACTION_DECLINE, call.id, 2)
            fun build(name: String) = Notification.Builder(context, CHANNEL_RING)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(name)
                .setContentText(context.getString(R.string.call_incoming))
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                // Even if this process dies while it rings.
                .setTimeoutAfter(RING_MS)
                .setFullScreenIntent(screen(context, call.id, answer = false, request = 3), true)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        style = Notification.CallStyle.forIncomingCall(Person.Builder().setName(name).setImportant(true).build(), decline, answer)
                    } else {
                        addAction(Notification.Action.Builder(null, context.getString(R.string.call_decline), decline).build())
                        addAction(Notification.Action.Builder(null, context.getString(R.string.call_answer), answer).build())
                    }
                }
            val notification = build(call.name)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(build(context.getString(R.string.call_incoming)).build())
                .build()
            // The ringtone repeats until the call is answered or ends.
            notification.flags = notification.flags or Notification.FLAG_INSISTENT
            try {
                manager.notify(CALL_ID, notification)
            } catch (_: SecurityException) {
                // Notifications are not allowed: nothing rings.
            }
        }

        private fun refresh(call: Call) {
            if (service == null || current !== call) return
            try {
                call.context.getSystemService(NotificationManager::class.java).notify(CALL_ID, ongoing(call))
            } catch (_: SecurityException) { }
        }

        private fun ongoingFallback(context: Context): Notification {
            channels(context)
            return Notification.Builder(context, CHANNEL_CALL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.call_ongoing)).setCategory(Notification.CATEGORY_CALL).build()
        }

        private fun ongoing(call: Call): Notification {
            val context = call.context
            channels(context)
            val words = CallWords.of(call.outgoing, call.atServer, call.state)
            val hangUp = action(context, ACTION_HANG_UP, call.id, 4)
            val open = screen(context, call.id, answer = false, request = 5)
            return Notification.Builder(context, CHANNEL_CALL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(call.name)
                .setContentText(context.getString(when (words) {
                    CallWords.OPEN_TO_TALK -> R.string.call_open_to_talk_text
                    CallWords.CALLING -> R.string.call_calling
                    CallWords.CONNECTING -> R.string.call_connecting
                    CallWords.RECONNECTING -> R.string.call_reconnecting
                    CallWords.ONGOING -> R.string.call_ongoing
                }))
                .setCategory(Notification.CATEGORY_CALL)
                .setContentIntent(open)
                .setOngoing(true)
                .apply {
                    if (call.everActive) setUsesChronometer(true).setWhen(call.activeSince) else setShowWhen(false)
                    if (words == CallWords.OPEN_TO_TALK) addAction(Notification.Action.Builder(null, context.getString(R.string.call_open_to_talk), open).build())
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        style = Notification.CallStyle.forOngoingCall(Person.Builder().setName(call.name).setImportant(true).build(), hangUp)
                    } else {
                        addAction(Notification.Action.Builder(null, context.getString(R.string.call_hang_up), hangUp).build())
                    }
                }
                .build()
        }

    }
}
