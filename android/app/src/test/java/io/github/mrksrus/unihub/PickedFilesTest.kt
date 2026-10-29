package io.github.mrksrus.unihub

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

// Strings stand in for the picker's content URIs.
class PickedFilesTest {
    @Test
    fun severalFilesFromThePickersClipDataAreAllAttached() {
        val picked = PickedFiles.collect(true, null, listOf("content://picker/1", "content://picker/2"))
        assertEquals(listOf("content://picker/1", "content://picker/2"), picked)
    }

    @Test
    fun oneFileInClipDataAloneIsAttached() {
        assertEquals(listOf("content://picker/1"), PickedFiles.collect(true, null, listOf("content://picker/1")))
    }

    @Test
    fun aSingleFileInTheIntentDataStillWorks() {
        assertEquals(listOf("content://picker/1"), PickedFiles.collect(true, "content://picker/1", emptyList()))
    }

    @Test
    fun theSameFileInDataAndClipDataIsAttachedOnce() {
        val picked = PickedFiles.collect(true, "content://picker/1", listOf("content://picker/1", null, "content://picker/2"))
        assertEquals(listOf("content://picker/1", "content://picker/2"), picked)
    }

    @Test
    fun cancelOrAnEmptyResultIsACancel() {
        assertNull(PickedFiles.collect(false, "content://picker/1", listOf("content://picker/2")))
        assertNull(PickedFiles.collect(true, null, emptyList<String>()))
    }

    // ── The app's copies of picked files ──────────────────────────────

    private val plenty = { Long.MAX_VALUE }

    @Test
    fun aFileWithinItsLimitIsCopiedWhole() {
        val bytes = ByteArray(200_000) { (it % 251).toByte() }
        val out = ByteArrayOutputStream()
        assertEquals(200_000L, PickedFiles.copy(ByteArrayInputStream(bytes), out, 200_000, plenty) { true })
        assertArrayEquals(bytes, out.toByteArray())
    }

    @Test
    fun aFileOverItsLimitIsRefusedWhileStreaming() {
        val refused = assertThrows(PickedFiles.Refused::class.java) {
            PickedFiles.copy(ByteArrayInputStream(ByteArray(200_001)), ByteArrayOutputStream(), 200_000, plenty) { true }
        }
        assertEquals(PickedFiles.Refusal.TOO_LARGE, refused.reason)
    }

    @Test
    fun copyingStopsBeforeThePhoneRunsOutOfSpace() {
        var free = PickedFiles.RESERVE_BYTES + 12L * 1024 * 1024
        val out = object : java.io.OutputStream() {
            override fun write(b: Int) { free-- }
            override fun write(b: ByteArray, off: Int, len: Int) { free -= len }
        }
        val endless = object : InputStream() {
            override fun read() = 0
            override fun read(b: ByteArray, off: Int, len: Int) = len
        }
        val refused = assertThrows(PickedFiles.Refused::class.java) { PickedFiles.copy(endless, out, Long.MAX_VALUE, { free }) { true } }
        assertEquals(PickedFiles.Refusal.NO_SPACE, refused.reason)
        assertTrue("stopped with the reserve left", free >= PickedFiles.RESERVE_BYTES)
        val full = assertThrows(PickedFiles.Refused::class.java) {
            PickedFiles.copy(ByteArrayInputStream(ByteArray(1)), ByteArrayOutputStream(), 10, { PickedFiles.RESERVE_BYTES }) { true }
        }
        assertEquals(PickedFiles.Refusal.NO_SPACE, full.reason)
    }

    @Test
    fun signingOutStopsACopyMidway() {
        val generation = PickedFiles.Generation()
        val token = generation.current()
        var reads = 0
        val slow = object : InputStream() {
            override fun read() = 0
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (++reads == 3) generation.next()
                return len
            }
        }
        assertThrows(PickedFiles.Cancelled::class.java) { PickedFiles.copy(slow, ByteArrayOutputStream(), Long.MAX_VALUE, plenty) { generation.isCurrent(token) } }
        assertEquals(3, reads)
        assertFalse(generation.isCurrent(token))
        assertTrue(generation.isCurrent(generation.current()))
    }

    @Test
    fun aPickKeepsTheFilesWithinItsBudgetAndNamesTheOthers() {
        val sizes = mapOf("a.bin" to 3000L * 1024 * 1024, "b.bin" to 1000L * 1024 * 1024, "c.bin" to 10L, "d.bin" to -1L)
        val limits = mutableListOf<Long>()
        val outcome = PickedFiles.copyAll(sizes.keys.toList(), { it }, { true }, { name, limit ->
            limits += limit
            val size = sizes.getValue(name)
            if (size < 0) throw IOException("unreadable")
            if (size > limit) throw PickedFiles.Refused(PickedFiles.Refusal.TOO_LARGE)
            name to size
        }, { error("nothing is discarded") })!!
        assertEquals(listOf("a.bin", "c.bin"), outcome.copies)
        assertEquals(listOf("b.bin" to PickedFiles.Refusal.TOO_LARGE, "d.bin" to PickedFiles.Refusal.UNREADABLE), outcome.refused)
        assertEquals(PickedFiles.MAX_FILE_BYTES, limits[0])
        assertEquals(PickedFiles.MAX_TOTAL_BYTES - 3000L * 1024 * 1024, limits[1])
    }

    @Test
    fun aPickEndedBySigningOutDeletesItsCopiesAndHandsNothingOver() {
        val generation = PickedFiles.Generation()
        val token = generation.current()
        val discarded = mutableListOf<String>()
        val outcome = PickedFiles.copyAll(listOf("a", "b", "c"), { it }, { generation.isCurrent(token) }, { name, _ ->
            if (name == "b") generation.next()
            name to 1L
        }, { discarded += it })
        assertNull(outcome)
        assertEquals(listOf("a", "b"), discarded)
        // A copy that notices the end itself is cancelled, not listed as unreadable.
        val again = PickedFiles.copyAll(listOf("a", "b"), { it }, { true }, { name, _ ->
            if (name == "b") throw PickedFiles.Cancelled()
            name to 1L
        }, { discarded += "again-$it" })
        assertNull(again)
        assertTrue(discarded.contains("again-a"))
    }

    // ── The file input while Android's picker is open ─────────────────

    @Test
    fun aPickerAnsweringInItsOwnSessionHandsTheFilesOver() {
        val generation = PickedFiles.Generation()
        val pick = PickedFiles.Pick<List<String>>(generation)
        val delivered = mutableListOf<List<String>?>()
        pick.open { delivered += it }
        val waiting = pick.finish()!!
        assertEquals(generation.current(), waiting.session)
        assertTrue(waiting.wanted)
        assertTrue(pick.complete(waiting, listOf("copy")))
        assertEquals(listOf<List<String>?>(listOf("copy")), delivered)
        assertFalse(waiting.wanted)
        // Exactly one answer: nothing after it reaches the input.
        pick.cancel()
        assertFalse(pick.complete(waiting, listOf("again")))
        assertNull(pick.finish())
        assertEquals(1, delivered.size)
    }

    @Test
    fun aPageThatGoesAwayWhileCopyingGetsNothingMoreAndTheCopiesAreDeleted() {
        val generation = PickedFiles.Generation()
        val pick = PickedFiles.Pick<List<String>>(generation)
        val delivered = mutableListOf<List<String>?>()
        pick.open { delivered += it }
        val waiting = pick.finish()!!
        // The page reloads after the copy finished but before it was handed over.
        pick.cancel()
        assertEquals(listOf<List<String>?>(null), delivered)
        assertFalse(waiting.wanted)
        assertFalse(pick.complete(waiting, listOf("a")))
        assertEquals(listOf<List<String>?>(null), delivered)

        // The page reloads while the second file is being copied: the copy
        // stops, the first copy is deleted, and the page hears nothing more.
        val next = mutableListOf<List<String>?>()
        pick.open { next += it }
        val copying = pick.finish()!!
        val kept = mutableListOf<String>()
        val outcome = PickedFiles.copyAll(listOf("a", "b", "c"), { it }, { generation.isCurrent(copying.session) && copying.wanted }, { name, _ ->
            if (name == "b") pick.cancel()
            kept += name
            name to 1L
        }, { kept -= it })
        assertNull(outcome)
        assertEquals(emptyList<String>(), kept)
        assertFalse(pick.complete(copying, null))
        assertEquals(listOf<List<String>?>(null), next)
    }

    @Test
    fun aPickerAnsweringAfterTheSessionEndedCopiesNothingAndHandsNothingOver() {
        val generation = PickedFiles.Generation()
        val pick = PickedFiles.Pick<List<String>>(generation)
        val delivered = mutableListOf<List<String>?>()
        pick.open { delivered += it }
        // Signed out while the picker was open; its answer arrives afterwards.
        generation.next()
        val written = mutableListOf<String>()
        pick.finish()?.let { waiting ->
            PickedFiles.copyAll(listOf("a"), { it }, { generation.isCurrent(waiting.session) }, { name, _ ->
                written += name
                name to 1L
            }, {})
        }
        assertEquals(emptyList<String>(), written)
        assertEquals(listOf<List<String>?>(null), delivered)

        // A session that ends while copying: the copy is not handed over.
        val later = mutableListOf<List<String>?>()
        pick.open { later += it }
        val waiting = pick.finish()!!
        generation.next()
        assertFalse(pick.complete(waiting, listOf("a")))
        assertEquals(listOf<List<String>?>(null), later)
    }

    @Test
    fun endingTheSessionOrANewPickerCancelsTheOneWaiting() {
        val generation = PickedFiles.Generation()
        val pick = PickedFiles.Pick<List<String>>(generation)
        val first = mutableListOf<List<String>?>()
        pick.open { first += it }
        val second = mutableListOf<List<String>?>()
        pick.open { second += it }
        assertEquals(listOf<List<String>?>(null), first)
        // MainActivity.endFileSession: the next session, and the page gets nothing at once.
        generation.next()
        pick.cancel()
        assertEquals(listOf<List<String>?>(null), second)
        assertNull(pick.finish())
        pick.cancel()
        assertEquals(1, second.size)
    }
}
