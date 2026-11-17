package io.github.mrksrus.unihub

import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import android.widget.Toast
import io.github.mrksrus.unihub.AppSession.Current
import io.github.mrksrus.unihub.AppSession.Stale
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * The home-screen widgets (GET /api/widgets): Calendar shows the next 14
 * days, ToDo the open tasks with a tick. The server decides what they may
 * show (the person's notification detail, not the app lock). One answer is
 * kept app-private for the server and session it came from. It is fetched
 * every 30 minutes, when the app comes to the front or goes to the back,
 * after a tick and on a calendar notification. Signing out, another
 * sign-in or another server empties both widgets before anything is
 * fetched; a refusal (Calendar off, two-factor or the app lock required)
 * empties them with one line and "Open UniHub". Without a connection the
 * last answer stays.
 */
object Widgets {
    private const val TAG = "UniHubWidgets"
    private const val PREFS = "widgets"
    private const val FEATURE = "calendar-widgets"
    // NotificationService's watchdog is job 1.
    private const val JOB_PERIODIC = 70
    private const val JOB_NOW = 71
    // One tick job per task, so a second tick does not replace the first.
    private const val JOB_TICK = 0x10000
    private const val EXTRA_TICK = "tick"
    private const val ACTION_TICK = "io.github.mrksrus.unihub.WIDGET_TICK"

    // What the widgets show instead of a list: a key of [line].
    private const val READY = "ready"
    private const val SIGNED_OUT = "signed-out"

    // ── The store ──────────────────────────────────────────────────────

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // The session is kept only as a hash: enough to tell another sign-in.
    private fun sessionKey(cookies: String): String =
        MessageDigest.getInstance("SHA-256").digest(AppSession.sessionOf(cookies)!!.toByteArray()).joinToString("") { "%02x".format(it) }

    private fun store(context: Context, origin: String?, session: String?, state: String?, answer: String?) {
        prefs(context).edit().clear().putString("origin", origin).putString("session", session).putString("state", state).putString("answer", answer).commit()
    }

    /** The items of one widget from the kept answer; empty while it shows a line instead. */
    fun items(context: Context, kind: String): List<JSONObject> {
        val prefs = prefs(context)
        if (prefs.getString("state", null) != READY) return emptyList()
        val list = try { JSONObject(prefs.getString("answer", null) ?: return emptyList()).optJSONArray(kind) } catch (_: org.json.JSONException) { null } ?: return emptyList()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it) }
    }

    private fun line(context: Context, kind: String): Pair<String, Boolean> = when (val state = prefs(context).getString("state", null)) {
        null -> context.getString(R.string.widget_loading) to false
        READY -> context.getString(if (kind == "agenda") R.string.widget_agenda_empty else R.string.widget_tasks_empty) to false
        SIGNED_OUT -> context.getString(R.string.widget_signed_out) to true
        FEATURE -> context.getString(R.string.widget_server_update) to true
        "MODULE_DISABLED" -> context.getString(R.string.widget_module_off) to true
        "TWO_FACTOR_REQUIRED" -> context.getString(R.string.widget_two_factor) to true
        "APP_LOCK_REQUIRED" -> context.getString(R.string.widget_app_lock) to true
        else -> context.getString(R.string.widget_refused) to true
    }

    // ── Refresh ────────────────────────────────────────────────────────

    /** Fetches the answer again (on a job's thread). */
    @Synchronized
    fun refresh(context: Context) {
        val origin = ServerAddress.saved(context)
        val cookies = origin?.let { AppSession.renewSession(context); AppSession.cookie(it) }?.takeIf { "auth-token=" in it }
        val session = cookies?.let(::sessionKey)
        val prefs = prefs(context)
        if (origin == null || session == null || prefs.getString("origin", null) != origin || prefs.getString("session", null) != session) {
            // Another server, sign-in or none: what was kept goes before anything is fetched.
            store(context, origin, session, if (session == null) SIGNED_OUT else null, null)
            render(context)
        }
        if (placed(context).isEmpty()) return
        // A force stop cancels the app's jobs; any refresh brings the 30 minutes back.
        schedulePeriodic(context)
        if (origin == null || cookies == null) return
        val current = Current { ServerAddress.saved(context) == origin && AppSession.cookie(origin)?.let(AppSession::sessionOf) == AppSession.sessionOf(cookies) }
        try {
            val state = if (FEATURE !in ContactsSync.features(context, origin, cookies, current)) FEATURE else {
                val answer = AppSession.get(context, origin, "/api/widgets?tz=" + URLEncoder.encode(TimeZone.getDefault().id, "UTF-8"), cookies, current)
                current.check()
                when (answer.status) {
                    200 -> { store(context, origin, session, READY, answer.body); null }
                    401 -> SIGNED_OUT
                    403 -> answer.json()?.optString("code")?.takeIf { it.isNotEmpty() } ?: "403"
                    else -> throw IOException("HTTP ${answer.status}")
                }
            }
            current.check()
            if (state != null) store(context, origin, session, state, null)
        } catch (_: Stale) {
            return
        } catch (error: Exception) {
            Log.i(TAG, "Widgets kept as they were: ${error.javaClass.simpleName}")
        }
        render(context)
    }

    /** Marks a task done on the server, then fetches again; no queue when it fails. */
    private fun tick(context: Context, id: String) {
        val origin = ServerAddress.saved(context)
        val cookies = origin?.let { AppSession.cookie(it) }?.takeIf { "auth-token=" in it }
        val done = origin != null && cookies != null && try {
            val current = Current { AppSession.cookie(origin)?.let(AppSession::sessionOf) == AppSession.sessionOf(cookies) }
            AppSession.request(context, origin, "PUT", "/api/calendar/events/${Uri.encode(id)}/todo-status", cookies, current, JSONObject().put("todo_status", "done")).status == 200
        } catch (_: Exception) {
            false
        }
        if (!done) Handler(Looper.getMainLooper()).post { Toast.makeText(context, R.string.widget_tick_failed, Toast.LENGTH_LONG).show() }
        refresh(context)
    }

    /** Fetches again soon, without waiting for a connection (signing out needs none). */
    fun refreshSoon(context: Context) = schedule(context, JobInfo.Builder(JOB_NOW, ComponentName(context, Job::class.java)))

    private fun schedule(context: Context, job: JobInfo.Builder) {
        try {
            context.getSystemService(JobScheduler::class.java).schedule(job.build())
        } catch (error: RuntimeException) {
            Log.w(TAG, "Not scheduled: ${error.javaClass.simpleName}")
        }
    }

    private fun schedulePeriodic(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if (scheduler.getPendingJob(JOB_PERIODIC) != null) return
        schedule(context, JobInfo.Builder(JOB_PERIODIC, ComponentName(context, Job::class.java))
            .setPeriodic(TimeUnit.MINUTES.toMillis(30)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true))
    }

    class Job : JobService() {
        override fun onStartJob(params: JobParameters): Boolean {
            val tick = params.extras.getString(EXTRA_TICK)
            Thread {
                try { if (tick != null) tick(applicationContext, tick) else refresh(applicationContext) } finally { jobFinished(params, false) }
            }.start()
            return true
        }
        override fun onStopJob(params: JobParameters) = false
    }

    // ── The widgets ────────────────────────────────────────────────────

    private fun placed(context: Context): List<Pair<String, IntArray>> {
        val manager = AppWidgetManager.getInstance(context)
        return listOf("agenda" to Agenda::class.java, "tasks" to Tasks::class.java)
            .map { (kind, provider) -> kind to manager.getAppWidgetIds(ComponentName(context, provider)) }
            .filter { it.second.isNotEmpty() }
    }

    // The list service, deprecated on Android 15, is what Android 10 and 11 have.
    @Suppress("DEPRECATION")
    private fun render(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        for ((kind, ids) in placed(context)) {
            for (id in ids) manager.updateAppWidget(id, views(context, kind, id))
            manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
        }
    }

    // UniHub at the widget's page; a tapped notification's way in (MainActivity checks the server).
    private fun open(context: Context, kind: String, flags: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_NOTIFICATION)
            .putExtra(MainActivity.EXTRA_ORIGIN, ServerAddress.saved(context))
            .putExtra(MainActivity.EXTRA_PATH, if (kind == "agenda") "/calendar" else "/todo")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val code = (if (kind == "agenda") 1 else 2) + (if (flags and PendingIntent.FLAG_MUTABLE != 0) 10 else 0)
        return PendingIntent.getActivity(context, code, intent, flags or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    @Suppress("DEPRECATION")
    private fun views(context: Context, kind: String, widgetId: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget)
        views.setTextViewText(R.id.widget_title, context.getString(if (kind == "agenda") R.string.widget_agenda_name else R.string.widget_tasks_name))
        views.setOnClickPendingIntent(R.id.widget_title, open(context, kind, PendingIntent.FLAG_IMMUTABLE))
        val (text, openable) = line(context, kind)
        views.setTextViewText(R.id.widget_line, text)
        views.setViewVisibility(R.id.widget_open, if (openable) View.VISIBLE else View.GONE)
        views.setOnClickPendingIntent(R.id.widget_empty, open(context, kind, PendingIntent.FLAG_IMMUTABLE))
        val list = Intent(context, ListService::class.java).putExtra("kind", kind).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        list.data = Uri.parse(list.toUri(Intent.URI_INTENT_SCHEME))
        views.setRemoteAdapter(R.id.widget_list, list)
        views.setEmptyView(R.id.widget_list, R.id.widget_empty)
        // Each row fills in its own part: an event opens the calendar, a tick names its task.
        views.setPendingIntentTemplate(R.id.widget_list, if (kind == "agenda") open(context, kind, PendingIntent.FLAG_MUTABLE)
            else PendingIntent.getBroadcast(context, 3, Intent(context, Tasks::class.java).setAction(ACTION_TICK), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        return views
    }

    abstract class Provider(private val kind: String) : AppWidgetProvider() {
        override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
            for (id in ids) manager.updateAppWidget(id, views(context, kind, id))
            schedulePeriodic(context)
            refreshSoon(context)
        }

        override fun onDisabled(context: Context) {
            if (placed(context).isEmpty()) context.getSystemService(JobScheduler::class.java).cancel(JOB_PERIODIC)
        }

        override fun onReceive(context: Context, intent: Intent) {
            super.onReceive(context, intent)
            val id = intent.getStringExtra(EXTRA_TICK)?.takeIf { intent.action == ACTION_TICK && it.length <= 64 } ?: return
            schedule(context, JobInfo.Builder(JOB_TICK + (id.hashCode() and 0xFFFF), ComponentName(context, Job::class.java)).setExtras(PersistableBundle().apply { putString(EXTRA_TICK, id) }))
        }
    }

    class Agenda : Provider("agenda")
    class Tasks : Provider("tasks")

    class ListService : RemoteViewsService() {
        override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Rows(applicationContext, intent.getStringExtra("kind") ?: "agenda")
    }

    private class Rows(private val context: Context, private val kind: String) : RemoteViewsService.RemoteViewsFactory {
        private var rows: List<JSONObject> = emptyList()
        override fun onCreate() {}
        override fun onDataSetChanged() { rows = items(context, kind) }
        override fun onDestroy() {}
        override fun getCount() = rows.size
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(position: Int) = position.toLong()
        override fun hasStableIds() = false

        override fun getViewAt(position: Int): RemoteViews {
            val row = rows.getOrNull(position) ?: return RemoteViews(context.packageName, R.layout.widget_row)
            val views = RemoteViews(context.packageName, R.layout.widget_row)
            val title = row.optString("title").takeIf { !row.isNull("title") && it.isNotEmpty() } ?: context.getString(R.string.widget_task_hidden)
            views.setTextViewText(R.id.row_title, title)
            if (kind == "agenda") {
                views.setTextViewText(R.id.row_when, whenText(row))
                views.setInt(R.id.row_dot, "setBackgroundColor", try { Color.parseColor(row.optString("color")) } catch (_: IllegalArgumentException) { Color.GRAY })
                views.setViewVisibility(R.id.row_tick, View.GONE)
                views.setOnClickFillInIntent(R.id.row, Intent())
            } else {
                val date = row.optString("date_text").takeIf { !row.isNull("date_text") }.orEmpty()
                views.setTextViewText(R.id.row_when, if (row.optBoolean("overdue")) context.getString(R.string.widget_overdue, date) else date)
                views.setViewVisibility(R.id.row_when, if (date.isEmpty()) View.GONE else View.VISIBLE)
                views.setViewVisibility(R.id.row_dot, View.GONE)
                val tick = row.optBoolean("can_tick")
                views.setViewVisibility(R.id.row_tick, if (tick) View.VISIBLE else View.GONE)
                views.setContentDescription(R.id.row_tick, context.getString(R.string.widget_tick_label, title))
                if (tick) views.setOnClickFillInIntent(R.id.row_tick, Intent().putExtra(EXTRA_TICK, row.optString("id")))
            }
            return views
        }

        private fun whenText(row: JSONObject): String = try {
            val allDay = row.optBoolean("all_day")
            val start = Instant.parse(row.getString("start_time")).atZone(if (allDay) ZoneOffset.UTC else ZoneId.systemDefault())
            start.format(DateTimeFormatter.ofPattern(if (allDay) "EEE d MMM" else "EEE d MMM, HH:mm"))
        } catch (_: Exception) {
            ""
        }
    }
}
