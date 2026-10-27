package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

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
}
