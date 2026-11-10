package io.github.mrksrus.unihub

/**
 * When the app lock asks again: the rules of AppLock, without Android classes
 * so the JVM tests can run them (AppLockClockTest).
 *
 * Every time is SystemClock.elapsedRealtime(): monotonic and counting deep
 * sleep, so changing the phone's clock cannot skip the lock. A reboot or a
 * process Android ended starts a new clock, which is locked while the lock is
 * on (`freshProcess`).
 *
 * The app counts as away from when the activity stops (not for a
 * configuration change, which recreates it) or the screen turns off, until it
 * is shown again. Screens the app opens itself (the file picker, a permission
 * question, the system credential screen) are hand-offs: they do not count,
 * unless the screen turns off meanwhile or they last longer than
 * [HAND_OFF_MS]; from then on the time away counts.
 */
class AppLockClock(config: Config = Config.OFF) {
    /** What the page configured (WebBridge `appLock` `configure`). */
    data class Config(
        /** Areas locked: empty is off, `app` the whole app, otherwise module ids. */
        val scope: Set<String>,
        /** Time away before it asks again; 0 asks every time UniHub opens. */
        val relockAfterMs: Long,
        /** Also ask after the phone's screen turned off. */
        val onDeviceLock: Boolean,
    ) {
        val on get() = scope.isNotEmpty()

        /** Whether this config locks [module]; null is content of no module (account notices), which only the whole app covers. */
        fun covers(module: String?) = APP in scope || (module != null && module in scope)

        companion object {
            const val APP = "app"
            val OFF = Config(emptySet(), 60_000L, true)
        }
    }

    var config: Config = config
        private set

    /** The page is locked as far as the app knows: since a start or a return that was due, until an unlock. */
    var locked = config.on
        private set

    /** No unlock happened in this process yet. */
    var freshProcess = true
        private set

    /** The activity is shown (between its start and stop). */
    var shown = false
        private set

    /** The last unlock in this process (elapsed time), or null. */
    var authenticatedAt: Long? = null
        private set

    /** The last time away, measured when the app came back, and whether the screen turned off during it. */
    var lastAwayMs: Long? = null
        private set
    var lastScreenOff = false
        private set

    private var stoppedAt: Long? = null
    private var screenOffAt: Long? = null
    private var handOffAt: Long? = null

    /** The page's configuration. Turning the lock on does not lock (the page just confirmed it); turning it off unlocks. */
    fun configure(next: Config) {
        config = next
        if (!next.on) locked = false
    }

    /** Another server: its configuration, with a fresh start. */
    fun reset(next: Config) {
        config = next
        locked = next.on
        freshProcess = true
        authenticatedAt = null
        stoppedAt = null
        screenOffAt = null
        handOffAt = null
    }

    fun stopped(now: Long, changingConfigurations: Boolean) {
        shown = false
        if (changingConfigurations) return
        // A mark only explains a stop that follows it at once; an older one
        // (a screen that never stopped the activity) does not cover this absence.
        handOffAt?.let { if (now - it > HAND_OFF_START_MS) handOffAt = null }
        if (stoppedAt == null) stoppedAt = now
    }

    fun screenOff(now: Long) {
        if (screenOffAt == null) screenOffAt = now
    }

    /** The app opens one of its hand-off screens now. */
    fun handOff(now: Long) {
        handOffAt = now
    }

    /** The hand-off screen answered (the unlock prompt's result) while the app may not have stopped at all. */
    fun handOffEnded() {
        if (stoppedAt == null && screenOffAt == null) handOffAt = null
    }

    /**
     * The activity is started, resumed or given an intent. Measures the time
     * away once per absence and locks when it was due. Returns true when this
     * call locked.
     */
    fun returned(now: Long): Boolean {
        shown = true
        if (stoppedAt == null && screenOffAt == null) {
            // Back from a hand-off that did not stop the activity (a dialog over it).
            handOffAt = null
            return false
        }
        val away = away(now)
        lastAwayMs = away.ms
        lastScreenOff = away.screenOff
        stoppedAt = null
        screenOffAt = null
        handOffAt = null
        if (!locked && away.due) {
            locked = true
            return true
        }
        return false
    }

    /** An unlock through the phone (fingerprint, face, its PIN) or the page's own PIN. */
    fun unlocked(now: Long) {
        locked = false
        freshProcess = false
        authenticatedAt = now
    }

    /** The page locked itself ("Lock now", a sign-out). */
    fun lockNow() {
        if (config.on) locked = true
    }

    /**
     * Whether a notification of [module] must hide its content now: it is
     * covered by the lock and the app is locked, or would lock if the person
     * opened it now.
     */
    fun hides(module: String?, now: Long): Boolean {
        if (!config.covers(module)) return false
        if (locked) return true
        return !shown && away(now).due
    }

    /** How long the app has been away now (null while shown and nothing is pending). */
    fun awayNow(now: Long): Long? = if (stoppedAt == null && screenOffAt == null) null else away(now).ms

    private class Away(val ms: Long, val screenOff: Boolean, val due: Boolean)

    private fun away(now: Long): Away {
        val screenOff = screenOffAt
        var from = listOfNotNull(stoppedAt, screenOff).minOrNull() ?: return Away(0, false, false)
        handOffAt?.let { start ->
            // Covered until the hand-off expires or the screen turns off.
            val end = minOf(start + HAND_OFF_MS, screenOff ?: Long.MAX_VALUE)
            if (now <= end && screenOff == null) return Away(0, false, false)
            from = maxOf(from, end)
        }
        val ms = (now - from).coerceAtLeast(0)
        val due = config.on && ((screenOff != null && config.onDeviceLock) || config.relockAfterMs == 0L || ms > config.relockAfterMs)
        return Away(ms, screenOff != null, due)
    }

    companion object {
        /** The longest a hand-off screen keeps the app counted as present. */
        const val HAND_OFF_MS = 15 * 60_000L
        /** A hand-off screen stops the activity within this time of being opened, or it is not why the activity stopped. */
        const val HAND_OFF_START_MS = 30_000L
    }
}
