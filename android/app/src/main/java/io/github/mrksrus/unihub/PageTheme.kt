package io.github.mrksrus.unihub

import android.content.Context
import android.content.res.Configuration

/** The light/dark theme and background colour the server's page last reported. */
object PageTheme {
    private const val PREFS = "theme"
    private const val KEY_DARK = "dark"
    private const val KEY_BACKGROUND = "background"

    fun saved(context: Context): Pair<Boolean, Int>? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.contains(KEY_BACKGROUND)) return null
        return prefs.getBoolean(KEY_DARK, true) to prefs.getInt(KEY_BACKGROUND, 0)
    }

    fun save(context: Context, dark: Boolean, background: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_DARK, dark).putInt(KEY_BACKGROUND, background).apply()
    }

    fun deviceIsDark(context: Context): Boolean =
        (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
}
