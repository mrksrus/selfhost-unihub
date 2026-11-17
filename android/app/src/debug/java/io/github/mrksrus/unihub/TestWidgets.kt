package io.github.mrksrus.unihub

import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * Debug builds only (tools/e2e/android/widgets.test.mjs): asks the launcher to
 * put a widget on the home screen, as its widget picker would; the test then
 * confirms Android's "Add to home screen" dialog.
 *
 *   adb shell am broadcast -n io.github.mrksrus.unihub/.TestWidgets --es pin agenda|tasks
 */
class TestWidgets : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val provider = when (intent.getStringExtra("pin")) {
            "agenda" -> Widgets.Agenda::class.java
            "tasks" -> Widgets.Tasks::class.java
            else -> return
        }
        AppWidgetManager.getInstance(context).requestPinAppWidget(ComponentName(context, provider), null, null)
    }
}
