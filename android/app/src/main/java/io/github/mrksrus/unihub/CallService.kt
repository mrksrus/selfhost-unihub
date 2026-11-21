package io.github.mrksrus.unihub

import android.Manifest
import android.annotation.TargetApi
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.OutcomeReceiver
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.CallEndpointException
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * The app's call provider for Telecom (Calls) and, while a call is answered,
 * the foreground service that keeps the call's sound running with the screen
 * off. Telecom shows nothing for a self-managed call: the ring is this
 * service's notification, full screen over the lock screen, with the
 * ringtone. One call at a time; everything runs on the main thread.
 */
class CallService : ConnectionService() {

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest): Connection {
        // What Calls handed to addNewIncomingCall comes nested.
        val extras = request.extras?.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
        val id = extras?.getString(Calls.EXTRA_ID)
        val origin = extras?.getString(Calls.EXTRA_ORIGIN)
        expected = null
        if (id == null || origin == null || current != null) return Connection.createFailedConnection(DisconnectCause(DisconnectCause.BUSY))
        return Call(applicationContext, id, extras.getString(Calls.EXTRA_NAME).orEmpty(), origin).also { current = it }
    }

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        // Another call that cannot be held (a mobile call), or Telecom refused it.
        Log.i(TAG, "Telecom did not take the call")
        expected = null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(Calls.EXTRA_ID)
        when (intent?.action) {
            ACTION_ONGOING -> {
                // Android requires startForeground after startForegroundService, even for a call that just ended.
                val call = current?.takeIf { it.id == id && it.state == Connection.STATE_ACTIVE }
                try {
                    startForeground(CALL_ID, ongoing(this, call?.name.orEmpty(), id.orEmpty()), types(this))
                } catch (error: RuntimeException) {
                    Log.w(TAG, "No foreground service for the call: ${error.javaClass.simpleName}")
                }
                if (call == null) stop(this) else service = this
            }
            ACTION_DECLINE -> id?.let { ended(it, DisconnectCause.REJECTED) }
            ACTION_HANG_UP -> id?.let { ended(it, DisconnectCause.LOCAL) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (service === this) service = null
        super.onDestroy()
    }

    /** One call, as Telecom sees it. */
    class Call(val context: Context, val id: String, val name: String, val origin: String) : Connection() {
        private var endpoints: List<CallEndpoint> = emptyList()

        init {
            connectionProperties = PROPERTY_SELF_MANAGED
            connectionCapabilities = CAPABILITY_MUTE
            audioModeIsVoip = true
            setAddress(Uri.fromParts("unihub", id, null), TelecomManager.PRESENTATION_ALLOWED)
            setCallerDisplayName(name, TelecomManager.PRESENTATION_ALLOWED)
            setRinging()
            main.postDelayed({ if (current === this && state == STATE_RINGING) ended(id, DisconnectCause.MISSED) }, RING_MS)
        }

        override fun onShowIncomingCallUi() = ring(context, this)

        // A headset, a car or a watch answered.
        override fun onAnswer() {
            answer(context, id)
            try {
                context.startActivity(CallActivity.intent(context, id, answer = false).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (error: RuntimeException) {
                Log.w(TAG, "Could not show the call: ${error.javaClass.simpleName}")
            }
        }

        override fun onReject() = ended(id, DisconnectCause.REJECTED)
        override fun onDisconnect() = ended(id, DisconnectCause.LOCAL)
        override fun onAbort() = ended(id, DisconnectCause.LOCAL)

        // Android 14 and later only call it.
        @TargetApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
        override fun onAvailableCallEndpointsChanged(available: List<CallEndpoint>) {
            endpoints = available
            Log.i(TAG, "Routes: ${available.map { it.endpointType }}")
        }

        /** Speaker or earpiece (a headset when there is one), through Telecom. */
        fun route(speaker: Boolean) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val wanted = if (speaker) listOf(CallEndpoint.TYPE_SPEAKER)
                    else listOf(CallEndpoint.TYPE_WIRED_HEADSET, CallEndpoint.TYPE_BLUETOOTH, CallEndpoint.TYPE_EARPIECE)
                val endpoint = wanted.firstNotNullOfOrNull { type -> endpoints.firstOrNull { it.endpointType == type } } ?: return
                requestCallEndpointChange(endpoint, context.mainExecutor, object : OutcomeReceiver<Void, CallEndpointException> {
                    override fun onResult(result: Void?) {}
                    override fun onError(error: CallEndpointException) { Log.w(TAG, "Route refused: ${error.code}") }
                })
            } else {
                @Suppress("DEPRECATION")
                setAudioRoute(if (speaker) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_WIRED_OR_EARPIECE)
            }
        }
    }

    companion object {
        private const val TAG = "UniHubCalls"
        private const val CHANNEL_RING = "call-ring"
        private const val CHANNEL_CALL = "call"
        private const val RING_ID = 2
        private const val CALL_ID = 3
        private const val RING_MS = 45_000L
        private const val ACTION_ONGOING = "io.github.mrksrus.unihub.CALL_ONGOING"
        private const val ACTION_DECLINE = "io.github.mrksrus.unihub.CALL_DECLINE"
        private const val ACTION_HANG_UP = "io.github.mrksrus.unihub.CALL_HANG_UP"

        private val main = Handler(Looper.getMainLooper())
        var current: Call? = null
            private set
        private var expected: String? = null
        private var service: CallService? = null
        private val recent = ArrayDeque<String>()

        /** The call screen, told "ringing", "active" or "ended". */
        var onState: ((id: String, state: String) -> Unit)? = null

        fun expect(id: String) { expected = id }

        /** A call this phone rings for, holds, or ended a while ago: a repeated message is ignored. */
        fun known(id: String) = current?.id == id || expected == id || id in recent

        fun state(id: String) = when (current?.takeIf { it.id == id }?.state) {
            Connection.STATE_RINGING -> "ringing"
            Connection.STATE_ACTIVE -> "active"
            else -> "ended"
        }

        /** Answers the ringing call and keeps it running in a foreground service. */
        fun answer(context: Context, id: String) {
            val call = current?.takeIf { it.id == id && it.state == Connection.STATE_RINGING } ?: return
            call.setActive()
            context.getSystemService(NotificationManager::class.java).cancel(RING_ID)
            try {
                context.startForegroundService(Intent(context, CallService::class.java).setAction(ACTION_ONGOING).putExtra(Calls.EXTRA_ID, id))
            } catch (error: RuntimeException) {
                // Started from the background (an answer from a headset alone): the call goes on without it.
                Log.w(TAG, "Could not start the call's service: ${error.javaClass.simpleName}")
            }
            onState?.invoke(id, "active")
        }

        /** Ends the call, whoever ended it: Telecom, the notification, the call page or the server. */
        fun ended(id: String, cause: Int) {
            val call = current?.takeIf { it.id == id } ?: return
            current = null
            recent.addLast(id)
            if (recent.size > 20) recent.removeFirst()
            call.setDisconnected(DisconnectCause(cause))
            call.destroy()
            service?.let(::stop)
            call.context.getSystemService(NotificationManager::class.java).run { cancel(RING_ID); cancel(CALL_ID) }
            onState?.invoke(id, "ended")
        }

        private fun stop(service: CallService) {
            service.stopForeground(STOP_FOREGROUND_REMOVE)
            service.stopSelf()
            if (CallService.service === service) CallService.service = null
        }

        private fun types(context: Context): Int {
            val microphone = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
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

        private fun ring(context: Context, call: Call) {
            val manager = channels(context)
            val answer = screen(context, call.id, answer = true, request = 1)
            val decline = action(context, ACTION_DECLINE, call.id, 2)
            fun build(name: String) = Notification.Builder(context, CHANNEL_RING)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(name)
                .setContentText(context.getString(R.string.call_incoming))
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
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
                manager.notify(RING_ID, notification)
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
