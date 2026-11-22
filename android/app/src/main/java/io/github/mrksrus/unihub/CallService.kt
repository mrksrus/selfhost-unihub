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
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telecom.DisconnectCause
import android.util.Log
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
import java.util.concurrent.Executor

/**
 * The call, as Telecom holds it (through Core-Telecom), and, while a call is
 * answered, the foreground service that keeps its sound running with the
 * screen off. Telecom shows nothing for the app's calls: the ring is this
 * service's notification, full screen over the lock screen, with the
 * ringtone. One call at a time; everything runs on the main thread.
 */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(Calls.EXTRA_ID)
        when (intent?.action) {
            ACTION_ONGOING -> {
                // Android requires startForeground after startForegroundService, even for a call that just ended.
                val call = current?.takeIf { it.id == id && it.active }
                val notification = ongoing(this, call?.name ?: getString(R.string.call_ongoing), id.orEmpty())
                try {
                    startForeground(CALL_ID, notification, types(this, call != null))
                } catch (error: RuntimeException) {
                    // Answered with nothing of the app on screen (a headset): no microphone type until the call screen asks again.
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
            ACTION_DECLINE -> id?.let { ended(it, DisconnectCause.REJECTED); dismissStale(this) }
            ACTION_HANG_UP -> id?.let { ended(it, DisconnectCause.LOCAL); dismissStale(this) }
        }
        // Started only for a button: nothing to keep running.
        if (service !== this) stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (service === this) service = null
        super.onDestroy()
    }

    /** One call. `control` is Telecom's side of it, once Telecom has taken it. */
    class Call(val context: Context, val id: String, val name: String, val origin: String) {
        var answered = false
        var active = false
        var control: CallControlScope? = null
        var job: Job? = null
        var endpoints: List<CallEndpointCompat> = emptyList()

        /** Speaker or earpiece (a headset when there is one), through Telecom. */
        fun route(speaker: Boolean) {
            val control = control ?: return
            val wanted = if (speaker) listOf(CallEndpointCompat.TYPE_SPEAKER)
                else listOf(CallEndpointCompat.TYPE_WIRED_HEADSET, CallEndpointCompat.TYPE_BLUETOOTH, CallEndpointCompat.TYPE_EARPIECE)
            val endpoint = wanted.firstNotNullOfOrNull { type -> endpoints.firstOrNull { it.type == type } } ?: return
            control.launch {
                Log.i(TAG, "Route ${endpoint.type}: ${control.requestEndpointChange(endpoint)}")
            }
        }
    }

    companion object {
        private const val TAG = "UniHubCalls"
        private const val CHANNEL_RING = "call-ring"
        private const val CHANNEL_CALL = "call"
        // One notification for the ring and the call: the answer updates it in place.
        private const val CALL_ID = 2
        private const val RING_MS = 45_000L
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

        /** The call screen, told "ringing", "active" or "ended". */
        var onState: ((id: String, state: String) -> Unit)? = null

        /** A call this phone rings for, holds, or ended a while ago: a repeated message is ignored. */
        fun known(id: String) = current?.id == id || id in recent

        fun state(id: String) = when (current?.takeIf { it.id == id }?.active) {
            false -> "ringing"
            true -> "active"
            null -> "ended"
        }

        /** Hands an incoming call to Telecom and rings once Telecom has it. */
        fun ring(context: Context, origin: String, id: String, name: String) {
            if (known(id) || current != null) return
            val call = Call(context, id, name, origin).also { current = it }
            call.job = scope.launch {
                try {
                    val telecom = CallsManager(context)
                    telecom.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
                    // No hold: answering another call ends this one.
                    telecom.addCall(
                        CallAttributesCompat(name, Uri.fromParts("unihub", id, null), CallAttributesCompat.DIRECTION_INCOMING,
                            CallAttributesCompat.CALL_TYPE_AUDIO_CALL, callCapabilities = 0),
                        // Telecom answered: a headset, a car or a watch.
                        onAnswer = { call.answered = true; started(call, show = true) },
                        onDisconnect = { cause -> ended(id, cause.code, tellTelecom = false) },
                        onSetActive = {},
                        onSetInactive = {},
                    ) {
                        call.control = this
                        launch { availableEndpoints.collect { call.endpoints = it; Log.i(TAG, "Routes: ${it.map { e -> e.type }}") } }
                        // An `end` that came while Telecom was taking the call.
                        if (current === call) showRing(context, call) else hangUp(call, DisconnectCause.REMOTE)
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    Log.w(TAG, "The call failed: ${error.javaClass.simpleName}")
                    ended(id, DisconnectCause.ERROR)
                }
            }
            main.postDelayed({ if (current === call && !call.answered) ended(id, DisconnectCause.MISSED) }, RING_MS)
        }

        /** Answers the ringing call from the app (its notification or its call screen). */
        fun answer(id: String) {
            val call = current?.takeIf { it.id == id && !it.answered } ?: return
            val control = call.control ?: return
            call.answered = true
            control.launch {
                if (control.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) is CallControlResult.Success) started(call, show = false)
                else ended(id, DisconnectCause.ERROR)
            }
        }

        /** The call is answered: it runs in a foreground service, whose notification replaces the ring. */
        private fun started(call: Call, show: Boolean) {
            if (current !== call || call.active) return
            call.active = true
            val context = call.context
            foreground(context, call.id)
            if (show) {
                try {
                    context.startActivity(CallActivity.intent(context, call.id, answer = false))
                } catch (error: RuntimeException) {
                    Log.w(TAG, "Could not show the call: ${error.javaClass.simpleName}")
                }
            }
            onState?.invoke(call.id, "active")
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

        /** Ends the call, whoever ended it: Telecom, the notification, the call page or the server. */
        fun ended(id: String, cause: Int, tellTelecom: Boolean = true) {
            val call = current?.takeIf { it.id == id } ?: return
            current = null
            recent.addLast(id)
            if (recent.size > 20) recent.removeFirst()
            if (tellTelecom) hangUp(call, cause) else main.post { call.job?.cancel() }
            service?.let(::stop)
            call.context.getSystemService(NotificationManager::class.java).cancel(CALL_ID)
            onState?.invoke(id, "ended")
        }

        /** A ring or call notification left behind for a call this process no longer holds (it died meanwhile). */
        fun dismissStale(context: Context) {
            if (current == null) context.getSystemService(NotificationManager::class.java).cancel(CALL_ID)
        }

        // Before Telecom has the call, `ring` hangs up once it does. Not in the call's own scope, which a failure cancels.
        private fun hangUp(call: Call, cause: Int) {
            val control = call.control ?: return
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

        private fun ongoing(context: Context, name: String, id: String): Notification {
            channels(context)
            val hangUp = action(context, ACTION_HANG_UP, id, 4)
            return Notification.Builder(context, CHANNEL_CALL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(name)
                .setContentText(context.getString(R.string.call_ongoing))
                .setCategory(Notification.CATEGORY_CALL)
                .setContentIntent(screen(context, id, answer = false, request = 5))
                .setOngoing(true)
                .setUsesChronometer(true)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        style = Notification.CallStyle.forOngoingCall(Person.Builder().setName(name).setImportant(true).build(), hangUp)
                    } else {
                        addAction(Notification.Action.Builder(null, context.getString(R.string.call_hang_up), hangUp).build())
                    }
                }
                .build()
        }
    }
}
