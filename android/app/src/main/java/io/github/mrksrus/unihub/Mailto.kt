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
    // Bounds what a link from any app puts into the page's address.
    private const val MAX_FIELD = 32_000

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
        return "/mail?action=compose" + fields.filter { it.second.isNotEmpty() }
            .joinToString("") { (name, value) -> "&$name=" + URLEncoder.encode(value.take(MAX_FIELD), "UTF-8") }
    }

    private fun addresses(text: String) = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    // In a mailto link "+" is itself, not a space; a broken escape stays as written.
    private fun decode(text: String): String = try {
        URLDecoder.decode(text.replace("+", "%2B"), "UTF-8")
    } catch (_: IllegalArgumentException) {
        text
    }
}
