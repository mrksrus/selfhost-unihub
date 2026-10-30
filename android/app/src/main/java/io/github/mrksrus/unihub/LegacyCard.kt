package io.github.mrksrus.unihub

import org.json.JSONArray
import java.security.MessageDigest

/**
 * The 3+3 sync of the apps up to 0.25.1, which this app still runs against
 * servers without `contacts-vcard` (0.24.3 to 0.25.1, P-21): what a UniHub
 * contact and its copy on the phone share there are names, phone numbers,
 * email addresses, company and job title. Everything else stays on its own
 * side: notes in UniHub, and addresses, birthdays, photos or a middle name on
 * the phone. ContactCard is the full model of newer servers. Plain Kotlin, so
 * the merge rules have JVM tests.
 */
data class LegacyCard(
    val first: String = "",
    val last: String = "",
    val phones: List<String> = emptyList(),
    val emails: List<String> = emptyList(),
    val company: String = "",
    val title: String = "",
) {
    val isEmpty: Boolean
        get() = first.isEmpty() && last.isEmpty() && phones.isEmpty() && emails.isEmpty() && company.isEmpty() && title.isEmpty()

    /** The same contact for both sides; a number written differently is the same number. */
    fun sameAs(other: LegacyCard): Boolean =
        first == other.first && last == other.last && company == other.company && title == other.title &&
            phones.map(::phoneKey).toSet() == other.phones.map(::phoneKey).toSet() &&
            emails.map(::emailKey).toSet() == other.emails.map(::emailKey).toSet()

    /** What the server can keep (docker/mariadb/schema.sql, table contacts), trimmed as the server's contact is read back. */
    fun forServer(): LegacyCard = LegacyCard(
        cut(first, 100),
        cut(last, 100),
        phones.filter { it.length <= 50 }.distinctBy(::phoneKey).take(SERVER_SLOTS),
        emails.filter { it.length <= 255 }.distinctBy(::emailKey).take(SERVER_SLOTS),
        cut(company, 255),
        cut(title, 255),
    )

    /**
     * The first name the server requires (POST /api/contacts) for a contact
     * the phone saved without one: the last name, company, an address or a
     * number takes its place.
     */
    fun withFirstName(): LegacyCard = when {
        first.isNotEmpty() -> this
        last.isNotEmpty() -> copy(first = last, last = "")
        else -> copy(first = company.ifEmpty { emails.firstOrNull() ?: phones.firstOrNull() ?: "" })
    }

    /** Keys that identify the same person on both sides: an address or the end of a number. */
    fun identity(): List<String> =
        emails.map { "e:" + emailKey(it) }.filter { it.length > 2 } +
            phones.map { "p:" + phoneKey(it).filter(Char::isDigit).takeLast(9) }.filter { it.length > 2 } +
            // A contact with neither is recognised by its whole name.
            (if (emails.isEmpty() && phones.isEmpty() && (first + last).isNotBlank()) listOf("n:" + "$first $last".trim().lowercase()) else emptyList())

    companion object {
        const val SERVER_SLOTS = 3

        // As the server compares them (api/src/services/contacts.ts).
        fun phoneKey(value: String) = value.filter { it.isDigit() || it == '+' }
        fun emailKey(value: String) = value.trim().lowercase()

        private fun cut(value: String, max: Int): String {
            if (value.length <= max) return value
            val end = if (Character.isHighSurrogate(value[max - 1])) max - 1 else max
            return value.substring(0, end).trim()
        }
    }
}

/** What a sync writes: the phone's copy and the server's contact. */
data class LegacyMerged(val phone: LegacyCard, val server: LegacyCard)

object LegacyMerge {
    /**
     * Each side takes the other's changes since the last sync. A field both
     * changed takes the server's value. Numbers and addresses are merged one
     * by one: each side's additions and removals reach the other. The server
     * keeps three of each; the phone keeps any more as its own.
     *
     * A contact seen for the first time on both sides (the phone's contact
     * matched one in UniHub) merges against empty bases: each side fills in
     * what the other lacks, and the server's value wins where both have one.
     */
    fun merge(phone: LegacyCard, phoneBase: LegacyCard, server: LegacyCard, serverBase: LegacyCard): LegacyMerged {
        fun field(p: String, pb: String, s: String, sb: String): Pair<String, String> {
            val serverChanged = s != sb
            val phoneChanged = p != pb
            return (if (serverChanged) s else p) to (if (phoneChanged && !serverChanged) p else s)
        }
        val first = field(phone.first, phoneBase.first, server.first, serverBase.first)
        val last = field(phone.last, phoneBase.last, server.last, serverBase.last)
        val company = field(phone.company, phoneBase.company, server.company, serverBase.company)
        val title = field(phone.title, phoneBase.title, server.title, serverBase.title)

        val phonePhones = applyChanges(phone.phones, serverBase.phones, server.phones, LegacyCard::phoneKey)
        val phoneEmails = applyChanges(phone.emails, serverBase.emails, server.emails, LegacyCard::emailKey)
        // Free places on the server take the phone's other entries, so both
        // sides settle on the same first three.
        val serverPhones = fill(applyChanges(server.phones, phoneBase.phones, phone.phones, LegacyCard::phoneKey), phonePhones, LegacyCard::phoneKey)
        val serverEmails = fill(applyChanges(server.emails, phoneBase.emails, phone.emails, LegacyCard::emailKey), phoneEmails, LegacyCard::emailKey)

        return LegacyMerged(
            LegacyCard(first.first, last.first, phonePhones, phoneEmails, company.first, title.first),
            LegacyCard(first.second, last.second, serverPhones, serverEmails, company.second, title.second).forServer(),
        )
    }

    /** [target] with what changed from [from] to [to]: removals first, then additions. */
    private fun applyChanges(target: List<String>, from: List<String>, to: List<String>, key: (String) -> String): List<String> {
        val before = from.map(key).toSet()
        val removed = before - to.map(key).toSet()
        val kept = target.filter { key(it) !in removed }
        val present = kept.map(key).toMutableSet()
        return kept + to.filter { key(it) !in before && present.add(key(it)) }
    }

    private fun fill(list: List<String>, from: List<String>, key: (String) -> String): List<String> {
        val present = list.map(key).toMutableSet()
        val room = (LegacyCard.SERVER_SLOTS - list.size).coerceAtLeast(0)
        return list + from.filter { present.add(key(it)) }.take(room)
    }
}

/**
 * The sync state of format "2" (SYNC2 and SYNC3 of a phone contact): the six
 * fields of each side after the last sync, the server's with its print.
 */
object LegacyState {
    fun encode(card: LegacyCard, print: String? = null): String =
        JSONArray(listOf(card.first, card.last, JSONArray(card.phones), JSONArray(card.emails), card.company, card.title))
            .apply { if (print != null) put(print) }.toString()

    fun decode(text: String?): LegacyCard? = decodeServer(text)?.first

    // The server's state also carries its print (ServerContact.print).
    fun decodeServer(text: String?): Pair<LegacyCard, String?>? {
        if (text == null || !text.startsWith("[")) return null
        return try {
            val array = JSONArray(text)
            fun list(index: Int) = array.getJSONArray(index).let { list -> List(list.length()) { list.getString(it) } }
            LegacyCard(array.getString(0), array.getString(1), list(2), list(3), array.getString(4), array.getString(5)) to
                array.optString(6).takeIf { it.isNotEmpty() }
        } catch (_: org.json.JSONException) {
            null
        }
    }

    // The hash 0.22.0 and 0.22.1 kept in SYNC1 (format "1").
    fun hash(card: LegacyCard): String = MessageDigest.getInstance("SHA-256")
        .digest(JSONArray(listOf("1", card.first, card.last, JSONArray(card.phones), JSONArray(card.emails), card.company, card.title)).toString().toByteArray())
        .joinToString("") { "%02x".format(it) }
}
