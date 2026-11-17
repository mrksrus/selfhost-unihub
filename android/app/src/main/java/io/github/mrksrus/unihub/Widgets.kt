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
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Log
import android.util.TypedValue
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
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
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
 * last answer stays, with a note of when it was fetched. Times are shown in
 * the zone the server wrote the tasks' dates in (the person's own, as on
 * UniHub's pages; the phone's when they set none), so both widgets agree.
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
    // From this width a widget has larger type and two-line titles: about four cells of a phone's home screen.
    private const val ROOMY_DP = 300
    // The server's own way of writing a task's time.
    private val TIME = DateTimeFormatter.ofPattern("HH:mm")

    // ── The store ──────────────────────────────────────────────────────

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // The session is kept only as a hash: enough to tell another sign-in.
    private fun sessionKey(cookies: String): String =
        MessageDigest.getInstance("SHA-256").digest(AppSession.sessionOf(cookies)!!.toByteArray()).joinToString("") { "%02x".format(it) }

    private fun store(context: Context, origin: String?, session: String?, state: String?, answer: String?) {
        prefs(context).edit().clear().putString("origin", origin).putString("session", session).putString("state", state).putString("answer", answer).commit()
    }

    /** The kept answer; null while the widgets show a line instead. */
    private fun answer(context: Context): JSONObject? {
        val prefs = prefs(context)
        if (prefs.getString("state", null) != READY) return null
        return try { JSONObject(prefs.getString("answer", null) ?: return null) } catch (_: org.json.JSONException) { null }
    }

    private fun items(answer: JSONObject?, kind: String): List<JSONObject> {
        val list = answer?.optJSONArray(kind) ?: return emptyList()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it) }
    }

    private fun zone(answer: JSONObject?): ZoneId = try { ZoneId.of(answer?.optString("time_zone").orEmpty()) } catch (_: Exception) { ZoneId.systemDefault() }

    private fun offline(context: Context) = prefs(context).getBoolean("offline", false)

    private fun line(context: Context, kind: String): Pair<String, Boolean> = when (val state = prefs(context).getString("state", null)) {
        null -> context.getString(if (offline(context)) R.string.widget_offline else R.string.widget_loading) to false
        READY -> context.getString(if (kind == "agenda") R.string.widget_agenda_empty else R.string.widget_tasks_empty) to false
        SIGNED_OUT -> context.getString(R.string.widget_signed_out) to true
        FEATURE -> context.getString(R.string.widget_server_update) to true
        "MODULE_DISABLED" -> context.getString(R.string.widget_module_off) to true
        "TWO_FACTOR_REQUIRED" -> context.getString(R.string.widget_two_factor) to true
        "APP_LOCK_REQUIRED" -> context.getString(R.string.widget_app_lock) to true
        else -> context.getString(R.string.widget_refused) to true
    }

    /** What is worth saying under the rows: the answer's age without a connection, hidden titles, tasks beyond the list. */
    private fun note(context: Context, kind: String, answer: JSONObject?): String? {
        if (answer == null) return null
        if (offline(context)) {
            val at = try { Instant.parse(answer.getString("generated_at")).atZone(zone(answer)) } catch (_: Exception) { return context.getString(R.string.widget_offline) }
            val pattern = if (at.toLocalDate() == LocalDate.now(at.zone)) "HH:mm" else "EEE d MMM, HH:mm"
            return context.getString(R.string.widget_stale, at.format(DateTimeFormatter.ofPattern(pattern, Locale.UK)))
        }
        if (answer.optString("detail") == "none") return context.getString(R.string.widget_titles_hidden)
        val more = answer.optInt("more_tasks")
        return if (kind == "tasks" && more > 0) context.getString(R.string.widget_more_tasks, more) else null
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
            prefs.edit().putBoolean("offline", true).commit()
        }
        render(context)
    }

    /** Marks a task done on the server, then fetches again; no queue when it fails. */
    private fun tick(context: Context, id: String) {
        val origin = ServerAddress.saved(context)
        val cookies = origin?.let { AppSession.cookie(it) }?.takeIf { "auth-token=" in it }
        // Only for the session whose answer the widget shows; another sign-in waits for the refresh.
        val shown = prefs(context).let { it.getString("origin", null) == origin && cookies != null && it.getString("session", null) == sessionKey(cookies) }
        // 200 when done; 0 when it was not sent or the server said no (gone, changed, no longer allowed); -1 without a connection.
        val status = if (origin == null || cookies == null || !shown) 0 else try {
            val current = Current { AppSession.cookie(origin)?.let(AppSession::sessionOf) == AppSession.sessionOf(cookies) }
            AppSession.request(context, origin, "PUT", "/api/calendar/events/${Uri.encode(id)}/todo-status", cookies, current, JSONObject().put("todo_status", "done")).status
        } catch (_: IOException) {
            -1
        } catch (_: Exception) {
            0
        }
        val failed = if (status == -1) R.string.widget_tick_failed else R.string.widget_tick_refused
        if (status != 200) Handler(Looper.getMainLooper()).post { Toast.makeText(context, failed, Toast.LENGTH_LONG).show() }
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

    // UniHub at a path; a tapped notification's way in (MainActivity checks the server).
    private fun openIntent(context: Context, path: String?): Intent =
        Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_NOTIFICATION)
            .putExtra(MainActivity.EXTRA_ORIGIN, ServerAddress.saved(context))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .apply { if (path != null) putExtra(MainActivity.EXTRA_PATH, path) }

    // The widget's page; or, for a list's rows, no path: each row fills in its own, which a path set here would override.
    private fun open(context: Context, kind: String, rows: Boolean = false): PendingIntent =
        PendingIntent.getActivity(context, (if (kind == "agenda") 1 else 2) + (if (rows) 10 else 0),
            openIntent(context, if (rows) null else if (kind == "agenda") "/calendar" else "/todo"),
            (if (rows) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE) or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun roomy(context: Context, widgetId: Int): Boolean {
        val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        return AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId)
            .getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) >= ROOMY_DP
    }

    // The size comes from the widget's options on every Android: the rows are built by the list service,
    // which has only the options to go by, so the header follows them too.
    @Suppress("DEPRECATION")
    private fun views(context: Context, kind: String, widgetId: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget)
        val roomy = roomy(context, widgetId)
        val answer = answer(context)
        views.setTextViewText(R.id.widget_title, context.getString(if (kind == "agenda") R.string.widget_agenda_name else R.string.widget_tasks_name))
        views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, if (roomy) 18f else 16f)
        views.setTextViewText(R.id.widget_count, if (kind == "tasks" && answer != null) context.getString(R.string.widget_open_count, items(answer, kind).size + answer.optInt("more_tasks")) else "")
        views.setOnClickPendingIntent(R.id.widget_header, open(context, kind))
        val (text, openable) = line(context, kind)
        views.setTextViewText(R.id.widget_line, text)
        views.setViewVisibility(R.id.widget_open, if (openable) View.VISIBLE else View.GONE)
        views.setOnClickPendingIntent(R.id.widget_empty, open(context, kind))
        val note = note(context, kind, answer)
        views.setTextViewText(R.id.widget_note, note)
        views.setViewVisibility(R.id.widget_note, if (note == null) View.GONE else View.VISIBLE)
        val list = Intent(context, ListService::class.java).putExtra("kind", kind).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        list.data = Uri.parse(list.toUri(Intent.URI_INTENT_SCHEME))
        views.setRemoteAdapter(R.id.widget_list, list)
        views.setEmptyView(R.id.widget_list, R.id.widget_empty)
        // Each row fills in its own part: an event its path; a task its path, its circle the task to tick. A list
        // has one template, so the ToDo widget's goes to its provider, which opens UniHub or ticks.
        views.setPendingIntentTemplate(R.id.widget_list, if (kind == "agenda") open(context, kind, rows = true)
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

        // The size decides the type and how many lines a title has.
        @Suppress("DEPRECATION")
        override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
            manager.updateAppWidget(id, views(context, kind, id))
            manager.notifyAppWidgetViewDataChanged(id, R.id.widget_list)
        }

        override fun onReceive(context: Context, intent: Intent) {
            super.onReceive(context, intent)
            if (intent.action != ACTION_TICK) return
            val id = intent.getStringExtra(EXTRA_TICK)?.takeIf { it.length <= 64 }
                ?: return context.startActivity(openIntent(context, intent.getStringExtra(MainActivity.EXTRA_PATH)))
            schedule(context, JobInfo.Builder(JOB_TICK + (id.hashCode() and 0xFFFF), ComponentName(context, Job::class.java)).setExtras(PersistableBundle().apply { putString(EXTRA_TICK, id) }))
        }
    }

    class Agenda : Provider("agenda")
    class Tasks : Provider("tasks")

    class ListService : RemoteViewsService() {
        override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
            Rows(applicationContext, intent.getStringExtra("kind") ?: "agenda", intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0))
    }

    private class Rows(private val context: Context, private val kind: String, private val widgetId: Int) : RemoteViewsService.RemoteViewsFactory {
        private var rows: List<JSONObject> = emptyList()
        private var zone: ZoneId = ZoneId.systemDefault()
        private var roomy = false
        override fun onCreate() {}
        override fun onDataSetChanged() {
            val answer = answer(context)
            zone = zone(answer)
            // Grouped by local day: all-day events sit at UTC midnight, so the server's order can split a day.
            rows = items(answer, kind).let { if (kind == "agenda") it.sortedWith(compareBy({ start(it)?.toLocalDate() }, { !it.optBoolean("all_day") }, { start(it)?.toInstant() })) else it }
            roomy = roomy(context, widgetId)
        }
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
            views.setTextViewTextSize(R.id.row_title, TypedValue.COMPLEX_UNIT_SP, if (roomy) 16f else 14f)
            views.setInt(R.id.row_title, "setMaxLines", if (roomy) 2 else 1)
            val agenda = kind == "agenda"
            for (id in intArrayOf(R.id.row_times, R.id.row_dot)) views.setViewVisibility(id, if (agenda) View.VISIBLE else View.GONE)
            for (id in intArrayOf(R.id.row_tick, R.id.row_when, R.id.row_overdue)) views.setViewVisibility(id, View.GONE)
            // The line between days, and between tasks as on the ToDo page.
            var rule = position > 0
            if (agenda) {
                val start = start(row)
                val day = start?.toLocalDate()
                val first = day != rows.getOrNull(position - 1)?.let(::start)?.toLocalDate()
                rule = rule && first
                views.setViewVisibility(R.id.row_day, if (first) View.VISIBLE else View.GONE)
                views.setTextViewText(R.id.row_day, day?.let(::dayText).orEmpty())
                val allDay = row.optBoolean("all_day")
                val end = if (allDay) null else try { Instant.parse(row.getString("end_time")).atZone(zone) } catch (_: Exception) { null }
                views.setTextViewText(R.id.row_time, if (allDay) context.getString(R.string.widget_all_day) else start?.format(TIME).orEmpty())
                views.setTextViewText(R.id.row_end, end?.takeIf { it != start }?.format(TIME).orEmpty())
                views.setViewVisibility(R.id.row_end, if (end == null || end == start) View.GONE else View.VISIBLE)
                views.setInt(R.id.row_dot, "setColorFilter", try { Color.parseColor(row.optString("color")) } catch (_: IllegalArgumentException) { Color.GRAY })
                views.setOnClickFillInIntent(R.id.row, Intent().putExtra(MainActivity.EXTRA_PATH, "/calendar?event=" + Uri.encode(row.optString("id"))))
            } else {
                views.setViewVisibility(R.id.row_day, View.GONE)
                val date = row.optString("date_text").takeIf { !row.isNull("date_text") }.orEmpty()
                val overdue = row.optBoolean("overdue")
                val line = if (overdue) R.id.row_overdue else R.id.row_when
                views.setTextViewText(line, if (overdue) context.getString(R.string.widget_overdue, date) else date)
                views.setViewVisibility(line, if (date.isEmpty()) View.GONE else View.VISIBLE)
                // The circle is faint where the person cannot tick: a list they only read, or titles hidden.
                val tick = row.optBoolean("can_tick")
                views.setViewVisibility(R.id.row_tick, View.VISIBLE)
                views.setInt(R.id.row_circle, "setImageAlpha", if (tick) 255 else 90)
                views.setContentDescription(R.id.row_tick, if (tick) context.getString(R.string.widget_tick_label, title) else title)
                val open = Intent().putExtra(MainActivity.EXTRA_PATH, "/todo?task=" + Uri.encode(row.optString("id")))
                views.setOnClickFillInIntent(R.id.row, open)
                // Always set: a row's views are used again, and a circle left alone would keep the task it ticked before.
                views.setOnClickFillInIntent(R.id.row_tick, if (tick) Intent().putExtra(EXTRA_TICK, row.optString("id")) else open)
            }
            views.setViewVisibility(R.id.row_rule, if (rule) View.VISIBLE else View.GONE)
            return views
        }

        // An all-day date is stored at UTC midnight; another zone would move it a day.
        private fun start(row: JSONObject): ZonedDateTime? =
            try { Instant.parse(row.getString("start_time")).atZone(if (row.optBoolean("all_day")) ZoneOffset.UTC else zone) } catch (_: Exception) { null }

        private fun dayText(day: LocalDate): String = when (day) {
            LocalDate.now(zone) -> context.getString(R.string.widget_today)
            LocalDate.now(zone).plusDays(1) -> context.getString(R.string.widget_tomorrow)
            else -> day.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK))
        }
    }
}
