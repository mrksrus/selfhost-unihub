package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.URLDecoder

class MailtoTest {
    private fun query(path: String): Map<String, String> = path.substringAfter('?').split('&').associate {
        it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }

    @Test
    fun readsEveryFieldOfALink() {
        val mail = Mailto.parse("MAILTO:ada@example.com,ben%40example.com?CC=cy@example.com&bcc=di@example.com,%20ed@example.com" +
            "&to=fay@example.com&subject=Caf%C3%A9%20%26%20more&body=Line%201%0D%0ALine+2&X-Other=ignored&in-reply-to=%3Cid%3E#part")!!
        assertEquals(listOf("ada@example.com", "ben@example.com", "fay@example.com"), mail.to)
        assertEquals(listOf("cy@example.com"), mail.cc)
        assertEquals(listOf("di@example.com", "ed@example.com"), mail.bcc)
        assertEquals("Café & more", mail.subject)
        // "+" is a plus sign in a mailto link.
        assertEquals("Line 1\r\nLine+2", mail.body)
    }

    @Test
    fun theComposerPathCarriesOnlyTheFiveFieldsEncoded() {
        val path = Mailto.path(Mailto.parse("mailto:a@example.com?subject=Hi%0D%0ABcc:%20x@example.com&body=a%26action%3Dsend%0D%0Ab&cc=c@example.com")!!)
        assertEquals("/mail", path.substringBefore('?'))
        // A line break cannot add a header to the subject; the body stays plain text, its "&" no parameter.
        assertEquals(mapOf("action" to "compose", "to" to "a@example.com", "cc" to "c@example.com", "subject" to "Hi Bcc: x@example.com", "body" to "a&action=send\nb"), query(path))
    }

    @Test
    fun aLongLinkKeepsThePathWithinOneRequestLine() {
        val body = "é".repeat(20_000)
        val path = Mailto.path(Mailto.Mail(to = listOf("a@example.com"), subject = "Hi", body = body))
        assert(path.length <= 6_000) { "path is ${path.length} characters" }
        val fields = query(path)
        assertEquals("a@example.com", fields["to"])
        assertEquals("Hi", fields["subject"])
        assert(body.startsWith(fields.getValue("body")) && fields.getValue("body").length > 500)
    }

    @Test
    fun anEmptyLinkOpensAnEmptyComposerAndOtherLinksNone() {
        assertEquals("/mail?action=compose", Mailto.path(Mailto.parse("mailto:")!!))
        assertEquals(Mailto.Mail(to = listOf("100%zz@example.com")), Mailto.parse("mailto:100%zz@example.com"))
        assertNull(Mailto.parse("https://example.com/?to=a@example.com"))
        assertNull(Mailto.parse("unihub://connect?server=https://example.com"))
    }
}
