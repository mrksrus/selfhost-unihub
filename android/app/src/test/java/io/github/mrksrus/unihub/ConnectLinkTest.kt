package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectLinkTest {
    private val link = "https://hub.example.com"
    private val other = "https://other.example.org"

    @Test
    fun aNewStartFromALinkAsksAboutItsServer() {
        assertEquals(link, ConnectLink.toAsk(link, recreated = false, openQuestion = null, saved = null))
        assertEquals(link, ConnectLink.toAsk(link, recreated = false, openQuestion = null, saved = other))
    }

    // B-33: recreated while the question was open, the app showed its connect screen without it.
    @Test
    fun aRecreatedActivityAsksAgainWhileTheQuestionWasOpen() {
        assertEquals(link, ConnectLink.toAsk(link, recreated = true, openQuestion = link, saved = null))
        assertEquals(link, ConnectLink.toAsk(link, recreated = true, openQuestion = link, saved = other))
        // A later link (onNewIntent) replaced the starting one's question.
        assertEquals(other, ConnectLink.toAsk(link, recreated = true, openQuestion = other, saved = null))
    }

    @Test
    fun anAnsweredLinkIsNotAskedAgainWhenTheActivityIsRecreated() {
        assertNull(ConnectLink.toAsk(link, recreated = true, openQuestion = null, saved = null))
        assertNull(ConnectLink.toAsk(link, recreated = true, openQuestion = null, saved = link))
    }

    @Test
    fun theServerInUseIsNeverAskedAbout() {
        assertNull(ConnectLink.toAsk(link, recreated = false, openQuestion = null, saved = link))
        assertNull(ConnectLink.toAsk(link, recreated = true, openQuestion = link, saved = link))
        assertNull(ConnectLink.toAsk(null, recreated = false, openQuestion = null, saved = null))
    }
}
