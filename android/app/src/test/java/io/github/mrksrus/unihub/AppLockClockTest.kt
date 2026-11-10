package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockClockTest {
    private val minute = 60_000L
    private fun config(scope: Set<String> = setOf("app"), relockAfterMs: Long = minute, onDeviceLock: Boolean = true) =
        AppLockClock.Config(scope, relockAfterMs, onDeviceLock)

    /** A clock that the person has just unlocked, shown at [at]. */
    private fun unlocked(config: AppLockClock.Config = config(), at: Long = 1_000L) = AppLockClock(config).apply {
        returned(at)
        unlocked(at)
    }

    @Test
    fun aNewProcessStartsLockedOnlyWithTheLockOn() {
        assertTrue(AppLockClock(config()).locked)
        assertTrue(AppLockClock(config()).freshProcess)
        assertFalse(AppLockClock(AppLockClock.Config.OFF).locked)
    }

    @Test
    fun withTheLockOffNothingIsEverDue() {
        val clock = AppLockClock(AppLockClock.Config.OFF)
        clock.returned(0)
        clock.stopped(0, false)
        clock.screenOff(10)
        assertFalse(clock.returned(10 * minute))
        assertFalse(clock.locked)
        assertFalse(clock.hides("mail", 10 * minute))
    }

    @Test
    fun anUnlockEndsTheFreshProcess() {
        val clock = unlocked(at = 5_000L)
        assertFalse(clock.locked)
        assertFalse(clock.freshProcess)
        assertEquals(5_000L, clock.authenticatedAt)
    }

    @Test
    fun oneMinuteAwayAsksOnlyAfterTheMinute() {
        val clock = unlocked()
        clock.stopped(10_000, false)
        assertFalse("back within 30 s", clock.returned(40_000))
        assertFalse(clock.locked)
        clock.stopped(50_000, false)
        assertTrue("back after 70 s", clock.returned(120_000))
        assertTrue(clock.locked)
        assertEquals(70_000L, clock.lastAwayMs)
    }

    @Test
    fun everyTimeAsksAfterAnyAbsence() {
        val clock = unlocked(config(relockAfterMs = 0))
        clock.stopped(2_000, false)
        assertTrue(clock.returned(2_001))
    }

    @Test
    fun aRecreatedActivityIsNoAbsence() {
        // A theme overlay or font size change stops and starts the activity again (B-33).
        val clock = unlocked(config(relockAfterMs = 0))
        clock.stopped(2_000, changingConfigurations = true)
        assertFalse(clock.returned(2_500))
        assertFalse(clock.locked)
    }

    @Test
    fun theScreenTurningOffLocksWhenAskedTo() {
        val clock = unlocked(config(relockAfterMs = 15 * minute, onDeviceLock = true))
        clock.stopped(2_000, false)
        clock.screenOff(2_100)
        assertTrue(clock.returned(7_000))
        assertTrue(clock.lastScreenOff)
    }

    @Test
    fun withoutOnDeviceLockTheScreenTurningOffOnlyStartsTheTimer() {
        val clock = unlocked(config(relockAfterMs = minute, onDeviceLock = false))
        clock.screenOff(2_000)
        clock.stopped(2_100, false)
        assertFalse("off for 30 s", clock.returned(32_000))
        clock.screenOff(40_000)
        clock.stopped(40_100, false)
        assertTrue("off for 90 s", clock.returned(130_000))
    }

    @Test
    fun theScreenTurningOffWhileShownCountsOnResume() {
        // Some phones only pause the activity for a screen that turns off and on.
        val clock = unlocked(config(relockAfterMs = 15 * minute))
        clock.screenOff(2_000)
        assertTrue(clock.returned(9_000))
    }

    @Test
    fun aHandOffIsNoAbsence() {
        // The file picker with "Every time": back after five minutes, not asked.
        val clock = unlocked(config(relockAfterMs = 0))
        clock.handOff(2_000)
        clock.stopped(2_300, false)
        assertFalse(clock.returned(5 * minute))
        assertFalse(clock.locked)
    }

    @Test
    fun aHandOffExpiresAfterFifteenMinutes() {
        val clock = unlocked(config(relockAfterMs = minute))
        clock.handOff(0)
        clock.stopped(100, false)
        assertFalse("16 minutes: one minute counted", clock.returned(16 * minute))
        clock.handOff(20 * minute)
        clock.stopped(20 * minute + 100, false)
        assertTrue("17 minutes: two minutes counted", clock.returned(37 * minute))
    }

    @Test
    fun aHandOffEndsWhenTheScreenTurnsOff() {
        val locking = unlocked(config(relockAfterMs = 15 * minute, onDeviceLock = true))
        locking.handOff(1_000)
        locking.stopped(1_100, false)
        locking.screenOff(minute)
        assertTrue(locking.returned(2 * minute))

        // Without onDeviceLock the time counts from the screen turning off.
        val counting = unlocked(config(relockAfterMs = 5 * minute, onDeviceLock = false))
        counting.handOff(1_000)
        counting.stopped(1_100, false)
        counting.screenOff(minute)
        assertFalse("two minutes off", counting.returned(3 * minute))
        counting.handOff(4 * minute)
        counting.stopped(4 * minute + 100, false)
        counting.screenOff(5 * minute)
        assertTrue("six minutes off", counting.returned(11 * minute))
    }

    @Test
    fun aMarkThatStoppedNothingDoesNotCoverALaterAbsence() {
        // Android 11+'s prompt is drawn over the app: its mark must not cover leaving later.
        val clock = unlocked(config(relockAfterMs = 0))
        clock.handOff(2_000)
        clock.handOffEnded()
        clock.stopped(3_000, false)
        assertTrue(clock.returned(4_000))

        val stale = unlocked(config(relockAfterMs = 0))
        stale.handOff(2_000)
        stale.stopped(2_000 + AppLockClock.HAND_OFF_START_MS + 1, false)
        assertTrue(stale.returned(2_000 + AppLockClock.HAND_OFF_START_MS + 2))
    }

    @Test
    fun aDialogOverTheAppIsNoAbsence() {
        // A permission question pauses the activity and resumes it; nothing stopped.
        val clock = unlocked(config(relockAfterMs = 0))
        clock.handOff(2_000)
        assertFalse(clock.returned(3_000))
        clock.stopped(10 * minute, false)
        assertTrue("the mark was used up", clock.returned(10 * minute + 1))
    }

    @Test
    fun lockedStaysUntilAnUnlock() {
        val clock = unlocked(config(relockAfterMs = 0))
        clock.stopped(2_000, false)
        assertTrue(clock.returned(3_000))
        assertFalse("already locked", clock.returned(3_500))
        clock.stopped(4_000, false)
        assertFalse("already locked", clock.returned(5_000))
        assertTrue(clock.locked)
        clock.unlocked(6_000)
        assertFalse(clock.locked)
    }

    @Test
    fun turningTheLockOnDoesNotLockAndOffUnlocks() {
        val clock = AppLockClock(AppLockClock.Config.OFF)
        clock.returned(0)
        clock.configure(config())
        assertFalse(clock.locked)
        clock.lockNow()
        assertTrue(clock.locked)
        clock.configure(AppLockClock.Config.OFF)
        assertFalse(clock.locked)
        clock.lockNow()
        assertFalse("nothing to lock with the lock off", clock.locked)
    }

    @Test
    fun anotherServerStartsFresh() {
        val clock = unlocked()
        clock.reset(config(setOf("mail")))
        assertTrue(clock.locked)
        assertTrue(clock.freshProcess)
        assertNull(clock.authenticatedAt)
    }

    @Test
    fun notificationsHideWhatTheLockCovers() {
        val modules = unlocked(config(setOf("mail", "contacts"), relockAfterMs = minute))
        assertFalse("shown and unlocked", modules.hides("mail", 2_000))
        modules.stopped(2_000, false)
        assertFalse("away 30 s", modules.hides("mail", 32_000))
        assertTrue("away 90 s", modules.hides("mail", 92_000))
        assertFalse("calendar is not locked", modules.hides("calendar", 92_000))
        assertFalse("account notices belong to no module", modules.hides(null, 92_000))

        val app = unlocked(config(setOf("app")))
        app.lockNow()
        assertTrue(app.hides(null, 2_000))
        assertTrue(app.hides("calendar", 2_000))

        // A process the notification service started: no unlock yet.
        assertTrue(AppLockClock(config(setOf("mail"))).hides("mail", 0))
    }

    @Test
    fun theScreenTurningOffHidesNotificationsAtOnce() {
        val clock = unlocked(config(setOf("mail"), relockAfterMs = 15 * minute, onDeviceLock = true))
        clock.stopped(2_000, false)
        assertFalse(clock.hides("mail", 3_000))
        clock.screenOff(3_000)
        assertTrue(clock.hides("mail", 3_001))
    }

    @Test
    fun timeAwayIsMeasuredOnTheMonotonicClockOnly() {
        // The clock takes elapsed times only: a changed wall clock cannot shorten the absence.
        val clock = unlocked()
        clock.stopped(10_000, false)
        assertEquals(50_000L, clock.awayNow(60_000))
        assertNull(unlocked().awayNow(60_000))
    }
}
