package io.github.mrksrus.unihub

import org.json.JSONObject
import org.junit.Assert.assertEquals
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
}
