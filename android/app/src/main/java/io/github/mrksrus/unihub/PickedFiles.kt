package io.github.mrksrus.unihub

import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicLong

/**
 * The files a picker returned to a page's file input, and the rules for the
 * app's copies of them (FileActions.copyPicked). A picker that allows several
 * files (the input has `multiple`) returns them in the intent's ClipData,
 * which FileChooserParams.parseResult ignores: it reads only the intent's
 * data, so nothing was attached. Kept free of Android classes so the JVM tests
 * can run it.
 */
object PickedFiles {
    /** All picked items without repeats, or null (cancel) when the picker returned none. */
    fun <T : Any> collect(resultOk: Boolean, single: T?, clip: List<T?>): List<T>? {
        if (!resultOk) return null
        return (listOfNotNull(single) + clip.filterNotNull()).distinct().ifEmpty { null }
    }

    /**
     * The most one pick is copied: the largest upload the server accepts, a
     * backup import (api/src/config.ts, BACKUP_UPLOAD_MAX_SIZE). No file input
     * takes more, for one file or for all of them together.
     */
    const val MAX_FILE_BYTES = 3900L * 1024 * 1024
    const val MAX_TOTAL_BYTES = MAX_FILE_BYTES

    /** Copying stops before the phone's free space falls below this. */
    const val RESERVE_BYTES = 256L * 1024 * 1024
    private const val SPACE_CHECK_BYTES = 8L * 1024 * 1024

    enum class Refusal { TOO_LARGE, NO_SPACE, UNREADABLE }

    /** A file that is not passed to the page; its partial copy is already deleted. */
    class Refused(val reason: Refusal) : Exception(reason.name)

    /** The session ended while copying. */
    class Cancelled : Exception("Signed out")

    /**
     * The session the copies belong to. Signing out or leaving the server
     * starts the next one: a copy still running for the previous one stops,
     * deletes what it wrote and hands the page nothing.
     */
    class Generation {
        private val value = AtomicLong()
        fun current(): Long = value.get()
        fun next() {
            value.incrementAndGet()
        }
        fun isCurrent(token: Long) = value.get() == token
    }

    /**
     * The page's file input from the moment Android's picker opens until the
     * page has its copies, with the session it was opened in. The input gets
     * exactly one answer. Ending the session or losing the page cancels it
     * (the page gets nothing at once, a copy under way stops and deletes what
     * it wrote), and a picker that answers for a session that has ended is
     * not copied: the page gets nothing then either. Main thread only, except
     * `Waiting.wanted`, which the copy reads.
     */
    class Pick<R>(private val session: Generation) {
        class Waiting<R>(val session: Long, private val deliver: (R?) -> Unit) {
            internal var answered = false
            @Volatile private var settled = false

            /** The page still waits for these files: not cancelled, not handed over. */
            val wanted: Boolean get() = !settled

            internal fun settle(value: R?) {
                if (settled) return
                settled = true
                deliver(value)
            }
        }

        private var waiting: Waiting<R>? = null

        /** A picker was opened; one still waiting gets nothing. */
        fun open(deliver: (R?) -> Unit) {
            cancel()
            waiting = Waiting(session.current(), deliver)
        }

        /** The page gets nothing: the session ended, or the page went away. */
        fun cancel() {
            val pending = waiting ?: return
            waiting = null
            pending.settle(null)
        }

        /**
         * The picker answered: what waits for its files, or null when nothing
         * does or the session it was opened in has ended (and was handed null).
         * It keeps waiting, and can be cancelled, until `complete`.
         */
        fun finish(): Waiting<R>? {
            val pending = waiting?.takeIf { !it.answered } ?: return null
            pending.answered = true
            if (session.isCurrent(pending.session)) return pending
            cancel()
            return null
        }

        /**
         * Hands the files over; false when the pick was cancelled meanwhile
         * (or its session ended), and then the caller deletes them.
         */
        fun complete(pending: Waiting<R>, value: R?): Boolean {
            if (pending !== waiting) return false
            if (!session.isCurrent(pending.session)) {
                cancel()
                return false
            }
            waiting = null
            pending.settle(value)
            return true
        }
    }

    /**
     * Streams one file, refused past `limit` bytes or when the free space
     * (`freeBytes`, read every few MB) would fall below RESERVE_BYTES, and
     * stopped when `alive` turns false. Returns the bytes copied.
     */
    fun copy(input: InputStream, output: OutputStream, limit: Long, freeBytes: () -> Long, alive: () -> Boolean): Long {
        if (freeBytes() < RESERVE_BYTES + SPACE_CHECK_BYTES) throw Refused(Refusal.NO_SPACE)
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        var checked = 0L
        while (true) {
            if (!alive()) throw Cancelled()
            val read = input.read(buffer)
            if (read < 0) return total
            total += read
            if (total > limit) throw Refused(Refusal.TOO_LARGE)
            if (total - checked >= SPACE_CHECK_BYTES) {
                checked = total
                if (freeBytes() < RESERVE_BYTES + SPACE_CHECK_BYTES) throw Refused(Refusal.NO_SPACE)
            }
            output.write(buffer, 0, read)
        }
    }

    class Outcome<C>(val copies: List<C>, val refused: List<Pair<String, Refusal>>)

    /**
     * Copies the picked files one after another within the selection's
     * budget. `copyOne` gets the bytes still allowed and returns the copy with
     * its size, or throws Refused (having deleted its partial copy) or
     * Cancelled. Any other failure refuses that file as unreadable. When the
     * session ends, every copy made so far goes to `discard` and the result is
     * null: the page gets nothing.
     */
    fun <T, C> copyAll(
        sources: List<T>,
        name: (T) -> String,
        alive: () -> Boolean,
        copyOne: (T, Long) -> Pair<C, Long>,
        discard: (C) -> Unit,
    ): Outcome<C>? {
        val copies = mutableListOf<C>()
        val refused = mutableListOf<Pair<String, Refusal>>()
        var total = 0L
        try {
            for (source in sources) {
                if (!alive()) throw Cancelled()
                try {
                    val (copy, size) = copyOne(source, minOf(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total))
                    copies += copy
                    total += size
                } catch (refusal: Refused) {
                    refused += name(source) to refusal.reason
                } catch (cancelled: Cancelled) {
                    throw cancelled
                } catch (_: Exception) {
                    refused += name(source) to Refusal.UNREADABLE
                }
            }
            if (!alive()) throw Cancelled()
            return Outcome(copies, refused)
        } catch (_: Cancelled) {
            copies.forEach(discard)
            return null
        }
    }
}
