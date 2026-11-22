package io.github.mrksrus.unihub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class CallMessageTest {
    private fun message(call: String, title: String = "Alex Example", kind: String = "call") =
        CallMessage.parse(JSONObject("""{"version":1,"kind":"$kind","title":"$title","call":$call}"""))

    @Test
    fun readsARingAndItsEnd() {
        assertEquals(CallMessage("3f2c-a1", ring = true, name = "Alex Example"), message("""{"id":"3f2c-a1","event":"ring"}"""))
        assertEquals(CallMessage("3f2c-a1", ring = false, name = "Alex Example"), message("""{"id":"3f2c-a1","event":"end"}"""))
    }

    @Test
    fun refusesWhatIsNotACallItCanName() {
        // Another kind never rings, and an id that could leave the /call?id= query is refused.
        assertNull(message("""{"id":"3f2c-a1","event":"ring"}""", kind = "chat"))
        assertNull(message("""{"id":"x&next=/mail","event":"ring"}"""))
        assertNull(message("""{"id":"${"a".repeat(65)}","event":"ring"}"""))
        assertNull(message("""{"id":"3f2c-a1","event":"accept"}"""))
        assertNull(message("\"3f2c-a1\""))
    }

    @Test
    fun keepsTheNameShort() {
        assertEquals(120, message("""{"id":"a","event":"ring"}""", title = "n".repeat(500))!!.name.length)
    }

    @Test
    fun readsTheOpenPagesHandOver() {
        assertEquals(CallMessage("3f2c-a1", ring = true, name = "Incoming call"),
            CallMessage.fromPage(JSONObject("""{"type":"call","action":"ring","id":"3f2c-a1","name":"Incoming call"}""")))
        assertEquals(false, CallMessage.fromPage(JSONObject("""{"type":"call","action":"end","id":"3f2c-a1","name":""}"""))?.ring)
        // Placing a call is not a ring.
        assertNull(CallMessage.fromPage(JSONObject("""{"type":"call","action":"place","id":"3f2c-a1"}""")))
    }

    @Test
    fun readsWhatTheCallPageReports() {
        fun report(json: String) = PageReport.parse(JSONObject(json))
        assertEquals(PageReport("connecting", "3f2c-a1", muted = false), report("""{"type":"call","state":"connecting","id":"3f2c-a1","muted":false}"""))
        // A call still being started has no id; JSON null is not the id "null".
        assertEquals(PageReport("calling", null, muted = true), report("""{"type":"call","state":"calling","id":null,"muted":true}"""))
        assertEquals(PageReport("none", null, muted = false), report("""{"type":"call","state":"none","id":null}"""))
        assertNull(report("""{"type":"call","state":"held","id":"a"}"""))
        assertNull(report("""{"type":"appLock","state":"active"}"""))
        assertNull(report("""{"type":"call","state":"active","id":"x&y"}""")?.id)
    }

    @Test
    fun theNotificationSaysOpenToTalkUntilTheServerHasTheAnswer() {
        // A headset answered with nothing of the app on screen: no sound is promised.
        assertEquals(CallWords.OPEN_TO_TALK, CallWords.of(outgoing = false, atServer = false, state = "ringing"))
        assertEquals(CallWords.CONNECTING, CallWords.of(outgoing = false, atServer = true, state = "connecting"))
        assertEquals(CallWords.ONGOING, CallWords.of(outgoing = false, atServer = true, state = "active"))
        assertEquals(CallWords.RECONNECTING, CallWords.of(outgoing = true, atServer = true, state = "reconnecting"))
        assertEquals(CallWords.CALLING, CallWords.of(outgoing = true, atServer = false, state = "calling"))
    }

    @Test
    fun namesTelecomsRoutesAsThePageDoes() {
        assertEquals(listOf("earpiece", "bluetooth", "wired", "speaker"), (1..4).map { Calls.routeKind(it) })
        // A streaming endpoint (5) or an unknown one is not offered.
        assertFalse(listOf(5, -1).any { Calls.routeKind(it) != null })
    }
}
