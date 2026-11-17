package io.github.mrksrus.unihub

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout

/**
 * Debug builds only (tools/e2e/android/widgets.test.mjs): one widget alone on
 * the screen at a size in dp, hosted as a home screen hosts it, for the
 * pictures of its look and the measure of its tap targets. A launcher places
 * a widget at one size and resizes it only by hand.
 *
 *   adb shell appwidget grantbind --package io.github.mrksrus.unihub --user 0
 *   adb shell am start -n io.github.mrksrus.unihub/.TestWidgetHost --es kind agenda|tasks --ei width 250 --ei height 190
 */
class TestWidgetHost : Activity() {
    private val host by lazy { AppWidgetHost(this, 1) }

    @Suppress("DEPRECATION")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val manager = AppWidgetManager.getInstance(this)
        // The widget of the picture before goes, so the app refreshes for this one only.
        host.deleteHost()
        val id = host.allocateAppWidgetId()
        val provider = if (intent.getStringExtra("kind") == "tasks") Widgets.Tasks::class.java else Widgets.Agenda::class.java
        check(manager.bindAppWidgetIdIfAllowed(id, ComponentName(this, provider))) { "run adb shell appwidget grantbind first" }
        val width = intent.getIntExtra("width", 250)
        val height = intent.getIntExtra("height", 190)
        val view = host.createView(this, id, manager.getAppWidgetInfo(id))
        // What a launcher tells the widget about its size (the size before Android 12 comes only from here).
        view.updateAppWidgetSize(null, width, height, width, height)
        val dp = resources.displayMetrics.density
        // Never stopped: the activity of the picture before stops after this one starts and would end this one's updates too.
        host.startListening()
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(72, 84, 104))
            addView(view, FrameLayout.LayoutParams((width * dp).toInt(), (height * dp).toInt(), Gravity.CENTER))
        })
    }

    // Asked for again while in front (singleTop): the next picture's widget takes this one's place.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        recreate()
    }
}
