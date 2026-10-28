package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedFilesTest {
    private val origin = "https://hub.example.com"
    private val token = "A".repeat(42) + "_"

    @Test
    fun onlyTheServersOwnTicketsAreFetched() {
        assertTrue(SharedFiles.isTicket(origin, "$origin/api/files/tickets/$token"))
        assertTrue(SharedFiles.isTicket(origin, "https://HUB.example.com:443/api/files/tickets/$token"))
        assertTrue(SharedFiles.isTicket("http://127.0.0.1:8092", "http://127.0.0.1:8092/api/files/tickets/$token"))
        // Another server, scheme or port.
        assertFalse(SharedFiles.isTicket(origin, "https://evil.example.org/api/files/tickets/$token"))
        assertFalse(SharedFiles.isTicket(origin, "http://hub.example.com/api/files/tickets/$token"))
        assertFalse(SharedFiles.isTicket(origin, "https://hub.example.com:8443/api/files/tickets/$token"))
        assertFalse(SharedFiles.isTicket(origin, "https://user@hub.example.com/api/files/tickets/$token"))
        // Any other address of the server, which would need the session.
        assertFalse(SharedFiles.isTicket(origin, "$origin/api/mail/attachments/1"))
        assertFalse(SharedFiles.isTicket(origin, "$origin/api/files/tickets/../../mail/attachments/$token"))
        assertFalse(SharedFiles.isTicket(origin, "$origin/api/files/tickets/short"))
        assertFalse(SharedFiles.isTicket(origin, "$origin/api/files/tickets/$token?x=1"))
        assertFalse(SharedFiles.isTicket(origin, "not a url"))
    }

    @Test
    fun theMostSpecificWellFormedTypeIsUsed() {
        assertEquals("application/pdf", SharedFiles.mimeType("application/pdf", "image/png", null))
        assertEquals("image/jpeg", SharedFiles.mimeType("Image/JPEG; name=x.jpg", null, null))
        assertEquals("application/pdf", SharedFiles.mimeType("application/octet-stream", null, "application/pdf"))
        assertEquals("image/png", SharedFiles.mimeType("not a type", "image/png", null))
        assertEquals("application/octet-stream", SharedFiles.mimeType(null, "", null))
        assertEquals("application/octet-stream", SharedFiles.mimeType("text/html\r\nX: y", null, null))
    }

    @Test
    fun extensionsAreShortAndPlain() {
        assertEquals("pdf", SharedFiles.extension("Report.PDF"))
        assertNull(SharedFiles.extension("archive"))
        assertNull(SharedFiles.extension("x.a/b"))
    }

    @Test
    fun copiesExpireAfterSixHoursOrWithAClockFromTheFuture() {
        val now = 1_000_000_000_000L
        assertFalse(SharedFiles.stale(now - 60_000, now))
        assertTrue(SharedFiles.stale(now - SharedFiles.MAX_AGE_MS - 1, now))
        assertTrue(SharedFiles.stale(now + 3_600_000, now))
    }
}
