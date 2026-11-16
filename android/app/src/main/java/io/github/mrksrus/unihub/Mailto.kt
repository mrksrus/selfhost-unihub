package io.github.mrksrus.unihub

import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale

/**
 * An email link (RFC 6068, `mailto:`) as UniHub's composer takes it: to, cc,
 * bcc, subject and body, as plain text. Other headers are ignored; the
 * composer only opens, nothing is sent by itself.
 */
object Mailto {
    // Bounds the page's address: the first load goes to Nginx, whose request line is 8 KB by default.
    private const val MAX_PATH = 6_000

    data class Mail(
        val to: List<String> = emptyList(),
        val cc: List<String> = emptyList(),
        val bcc: List<String> = emptyList(),
        val subject: String = "",
        val body: String = "",
    )

    /** The link's fields, or null when it is not a mailto link. */
    fun parse(link: String): Mail? {
        if (!link.startsWith("mailto:", ignoreCase = true)) return null
        val rest = link.substring("mailto:".length).substringBefore('#')
        var mail = Mail(to = addresses(decode(rest.substringBefore('?'))))
        for (pair in rest.substringAfter('?', "").split('&')) {
            val value = decode(pair.substringAfter('=', ""))
            mail = when (decode(pair.substringBefore('=')).lowercase(Locale.ROOT)) {
                "to" -> mail.copy(to = mail.to + addresses(value))
                "cc" -> mail.copy(cc = mail.cc + addresses(value))
                "bcc" -> mail.copy(bcc = mail.bcc + addresses(value))
                "subject" -> if (mail.subject.isEmpty()) mail.copy(subject = value) else mail
                "body" -> if (mail.body.isEmpty()) mail.copy(body = value) else mail
                else -> mail
            }
        }
        return mail
    }

    /** The composer's page for [mail]: `/mail?action=compose&to=…`, every value encoded. */
    fun path(mail: Mail): String {
        fun line(text: String) = text.replace(Regex("[\\r\\n]+"), " ").trim()
        val fields = listOf(
            "to" to mail.to.joinToString(", ", transform = ::line),
            "cc" to mail.cc.joinToString(", ", transform = ::line),
            "bcc" to mail.bcc.joinToString(", ", transform = ::line),
            "subject" to line(mail.subject),
            "body" to mail.body.replace("\r\n", "\n"),
        )
        val out = StringBuilder("/mail?action=compose")
        for ((name, value) in fields) {
            var text = value
            var encoded = URLEncoder.encode(text, "UTF-8")
            val room = MAX_PATH - out.length - name.length - 2
            // A field too long for what is left keeps its start; the body is last, so it is the one cut.
            while (encoded.length > room && text.isNotEmpty()) {
                text = text.take(maxOf(0, minOf(text.length - 1, text.length * room / encoded.length)))
                encoded = URLEncoder.encode(text, "UTF-8")
            }
            if (text.isNotEmpty()) out.append('&').append(name).append('=').append(encoded)
        }
        return out.toString()
    }

    private fun addresses(text: String) = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    // In a mailto link "+" is itself, not a space; a broken escape stays as written.
    private fun decode(text: String): String = try {
        URLDecoder.decode(text.replace("+", "%2B"), "UTF-8")
    } catch (_: IllegalArgumentException) {
        text
    }
}
