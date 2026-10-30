package io.github.mrksrus.unihub

import org.json.JSONArray
import org.json.JSONObject

/**
 * A contact as servers with `contacts-vcard` (0.26.0 on) keep it, and as the
 * phone holds it: the vCard 4.0 model of api/src/contracts/contacts.ts
 * without what stays in UniHub (notes, categories, kept properties). The
 * photo is synced beside it (ContactsSync, photo pass). Both sides use the
 * server's labels; ContactPhone maps them to Android's types. Plain Kotlin,
 * so the mapping and the merge rules have JVM tests.
 */
data class ContactCard(
    /** FN as written in UniHub ('' = made from the parts); the phone never holds one. */
    val display: String = "",
    val given: String = "",
    val family: String = "",
    val middle: String = "",
    val prefix: String = "",
    val suffix: String = "",
    val organization: String = "",
    val department: String = "",
    val title: String = "",
    val birthday: PartialDate? = null,
    val anniversary: PartialDate? = null,
    val favorite: Boolean = false,
    val emails: List<Value> = emptyList(),
    val phones: List<Value> = emptyList(),
    val addresses: List<Value> = emptyList(),
    val urls: List<Value> = emptyList(),
    val impp: List<Value> = emptyList(),
    val related: List<Value> = emptyList(),
    val nicknames: List<Value> = emptyList(),
) {
    fun values(kind: ValueKind): List<Value> = when (kind) {
        ValueKind.EMAIL -> emails
        ValueKind.PHONE -> phones
        ValueKind.ADDRESS -> addresses
        ValueKind.URL -> urls
        ValueKind.IMPP -> impp
        ValueKind.RELATED -> related
        ValueKind.NICKNAME -> nicknames
    }

    fun with(kind: ValueKind, list: List<Value>): ContactCard = when (kind) {
        ValueKind.EMAIL -> copy(emails = list)
        ValueKind.PHONE -> copy(phones = list)
        ValueKind.ADDRESS -> copy(addresses = list)
        ValueKind.URL -> copy(urls = list)
        ValueKind.IMPP -> copy(impp = list)
        ValueKind.RELATED -> copy(related = list)
        ValueKind.NICKNAME -> copy(nicknames = list)
    }

    val name: Name get() = Name(display, given, family, middle, prefix, suffix)
    fun withName(name: Name) = copy(display = name.display, given = name.given, family = name.family, middle = name.middle, prefix = name.prefix, suffix = name.suffix)

    /** What makes a contact one for UniHub (POST /api/contacts): a name, an organisation, an email or a phone number. */
    val hasIdentity: Boolean
        get() = name.parts.any { it.isNotEmpty() } || display.isNotEmpty() || organization.isNotEmpty() || emails.isNotEmpty() || phones.isNotEmpty()

    /** The same content, whatever the server's value ids. */
    fun sameAs(other: ContactCard): Boolean = withoutIds() == other.withoutIds()

    fun withoutIds(): ContactCard = ValueKind.entries.fold(this) { card, kind -> card.with(kind, card.values(kind).map { it.copy(id = null) }) }

    /**
     * The card as the phone holds it once written (ContactPhone.rows), so the
     * phone's state after a sync equals what the phone reads back: a name
     * known only as a display name becomes the given name (Android would
     * split it), values without a label get the phone's default, and only
     * the first preferred value of a kind stays preferred (Android keeps one).
     */
    fun forPhone(): ContactCard {
        var card = withName(name.forPhone())
        for (kind in ValueKind.entries) {
            var preferred = false
            card = card.with(kind, card.values(kind).map { value ->
                val label = (if (value.label == "custom" && value.custom.isBlank()) "" else value.label).ifEmpty { kind.phoneDefault }
                val first = value.preferred && !preferred
                if (value.preferred) preferred = true
                value.copy(id = null, label = label, custom = if (label == "custom") value.custom else "", preferred = first)
            })
        }
        return card
    }

    /**
     * What the server takes (the input contract in docs/CONTACTS.md): text
     * within its limits, a value too long for UniHub left out (it stays on
     * the phone), at most 100 values of a kind, no unpaired surrogates.
     */
    fun forServer(): ContactCard {
        var card = copy(
            display = clean(display, TEXT_MAX), given = clean(given, TEXT_MAX), family = clean(family, TEXT_MAX),
            middle = clean(middle, TEXT_MAX), prefix = clean(prefix, TEXT_MAX), suffix = clean(suffix, TEXT_MAX),
            organization = clean(organization, TEXT_MAX), department = clean(department, TEXT_MAX), title = clean(title, TEXT_MAX),
        )
        for (kind in ValueKind.entries) {
            card = card.with(kind, card.values(kind).mapNotNull { it.forServer(kind) }.take(ValueKind.MAX_VALUES))
        }
        return card
    }

    /**
     * Keys that identify the same person on both sides: an address or the
     * end of a number, else the whole name. A contact the phone created is
     * found again by them when the server's answer was lost.
     */
    fun identity(): List<String> {
        val keys = emails.map { "e:" + ValueKind.EMAIL.key(it.value) }.filter { it.length > 2 } +
            phones.map { "p:" + ValueKind.PHONE.key(it.value).filter(Char::isDigit).takeLast(9) }.filter { it.length > 2 }
        if (keys.isNotEmpty()) return keys
        val whole = name.forPhone().parts.filter { it.isNotEmpty() }.joinToString(" ").lowercase()
        return when {
            whole.isNotEmpty() -> listOf("n:$whole")
            organization.isNotEmpty() -> listOf("o:" + organization.lowercase())
            else -> emptyList()
        }
    }

    // ── JSON: the API's full body and answer, and the sync state ───────

    /** The API's full body (ContactInput) for these fields; [ids] sends the server's value ids back. */
    fun toJson(ids: Boolean = true): JSONObject = JSONObject().apply {
        put("name", JSONObject().apply {
            put("display", display.orNull()); put("given", given.orNull()); put("family", family.orNull())
            put("middle", middle.orNull()); put("prefix", prefix.orNull()); put("suffix", suffix.orNull())
        })
        put("organization", JSONObject().put("name", organization.orNull()).put("department", department.orNull()))
        put("job_title", title.orNull())
        put("birthday", birthday?.text() ?: JSONObject.NULL)
        put("anniversary", anniversary?.text() ?: JSONObject.NULL)
        put("is_favorite", favorite)
        for (kind in ValueKind.entries) put(kind.field, JSONArray(values(kind).map { it.toJson(ids) }))
    }

    companion object {
        const val TEXT_MAX = 255
        const val CUSTOM_LABEL_MAX = 100
        // Values longer than this are not read from the phone; the server keeps at most 2048.
        const val READ_MAX = 8192

        /** A contact of the API (ContactRecord) or a sync state written by toJson(). */
        fun fromJson(json: JSONObject): ContactCard {
            val name = json.optJSONObject("name") ?: JSONObject()
            val organization = json.optJSONObject("organization") ?: JSONObject()
            var card = ContactCard(
                display = name.text("display"), given = name.text("given"), family = name.text("family"),
                middle = name.text("middle"), prefix = name.text("prefix"), suffix = name.text("suffix"),
                organization = organization.text("name"), department = organization.text("department"),
                title = json.text("job_title"),
                birthday = PartialDate.from(json.opt("birthday")), anniversary = PartialDate.from(json.opt("anniversary")),
                favorite = json.optBoolean("is_favorite", false),
            )
            for (kind in ValueKind.entries) {
                val list = json.optJSONArray(kind.field) ?: continue
                card = card.with(kind, (0 until list.length()).mapNotNull { Value.fromJson(kind, list.opt(it)) })
            }
            return card
        }

        private fun String.orNull(): Any = ifEmpty { null } ?: JSONObject.NULL

        internal fun JSONObject.text(name: String): String = if (isNull(name)) "" else (opt(name)?.toString() ?: "").trim()

        // As the server reads text: trimmed, at most [max] characters, an unpaired surrogate replaced.
        internal fun clean(value: String, max: Int): String {
            val text = buildString {
                var index = 0
                while (index < value.length) {
                    val char = value[index]
                    when {
                        Character.isHighSurrogate(char) && index + 1 < value.length && Character.isLowSurrogate(value[index + 1]) -> {
                            append(char); append(value[index + 1]); index++
                        }
                        Character.isSurrogate(char) -> append('�')
                        else -> append(char)
                    }
                    index++
                }
            }.trim()
            if (text.codePointCount(0, text.length) <= max) return text
            return text.substring(0, text.offsetByCodePoints(0, max)).trim()
        }
    }
}

/** The name parts; the merge treats them as one field, as UniHub's merge does. */
data class Name(val display: String = "", val given: String = "", val family: String = "", val middle: String = "", val prefix: String = "", val suffix: String = "") {
    val parts get() = listOf(prefix, given, middle, family, suffix)

    /** As the phone holds it: the parts; a name known only as a display name becomes the given name. */
    fun forPhone(): Name =
        if (listOf(given, family, middle, prefix, suffix).all { it.isEmpty() } && display.isNotEmpty()) Name(given = display)
        else copy(display = "")
}

/** A birthday or anniversary; [year] null when the year is unknown. */
data class PartialDate(val year: Int?, val month: Int, val day: Int) {
    /** `YYYY-MM-DD` or `--MM-DD`, as the API and Android's Event rows write it. */
    fun text(): String = (if (year == null) "--" else "%04d-".format(year)) + "%02d-%02d".format(month, day)

    companion object {
        private val DAYS = intArrayOf(31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
        // yyyy-MM-dd, --MM-dd, yyyyMMdd and --MMdd, optionally followed by a time (some apps add one).
        private val FORMAT = Regex("^(?:(\\d{4})-?|--)(\\d{2})-?(\\d{2})(?:[T ].*)?$")

        fun of(year: Int?, month: Int, day: Int): PartialDate? {
            val leap = year == null || (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))
            val valid = month in 1..12 && day >= 1 && day <= DAYS[month - 1] && (year == null || year in 1..9999) &&
                (month != 2 || day != 29 || leap)
            return if (valid) PartialDate(year, month, day) else null
        }

        fun parse(text: String?): PartialDate? {
            val match = FORMAT.matchEntire(text?.trim() ?: return null) ?: return null
            return of(match.groupValues[1].takeIf { it.isNotEmpty() }?.toInt(), match.groupValues[2].toInt(), match.groupValues[3].toInt())
        }

        fun from(json: Any?): PartialDate? = when (json) {
            is JSONObject -> if (json.has("month") && json.has("day"))
                of(if (json.isNull("year")) null else json.optInt("year"), json.optInt("month"), json.optInt("day")) else null
            is String -> parse(json)
            else -> null
        }
    }
}

/** A postal address in the server's parts; [Value.value] holds its formatted text. */
data class Address(
    val poBox: String = "",
    val extended: String = "",
    val street: String = "",
    val locality: String = "",
    val region: String = "",
    val postalCode: String = "",
    val country: String = "",
) {
    val isEmpty get() = listOf(poBox, extended, street, locality, region, postalCode, country).all { it.isEmpty() }

    /** As the server writes `value` (formatAddress in api/src/services/contacts.ts). */
    fun formatted(): String {
        val city = listOf(postalCode, locality).filter { it.isNotEmpty() }.joinToString(" ")
        return listOf(poBox, extended, street, city, region, country).filter { it.isNotEmpty() }.joinToString("\n")
    }

    companion object {
        val PARTS = listOf("po_box", "extended", "street", "locality", "region", "postal_code", "country")
    }
}

/** One labelled value: [label] is the server's ('' none, 'custom' with [custom]); [id] the server's row. */
data class Value(
    val value: String,
    val label: String = "",
    val custom: String = "",
    val preferred: Boolean = false,
    val address: Address? = null,
    val id: String? = null,
) {
    /** The label, custom label and preference: a change of any of them is a change of the value. */
    val labelling get() = Triple(label, custom, preferred)

    fun forServer(kind: ValueKind): Value? {
        val label = if (label in kind.labels && (label != "custom" || custom.isNotBlank())) label else ""
        val custom = if (label == "custom") ContactCard.clean(custom, ContactCard.CUSTOM_LABEL_MAX) else ""
        if (kind == ValueKind.ADDRESS) {
            val parts = address ?: Address(street = value)
            fun part(text: String, max: Int = ContactCard.TEXT_MAX) = ContactCard.clean(text, max)
            val cleaned = Address(part(parts.poBox), part(parts.extended), part(parts.street, 1000), part(parts.locality), part(parts.region), part(parts.postalCode), part(parts.country))
            // A part too long for UniHub would be refused with the whole contact: the address stays on the phone.
            if (cleaned.isEmpty || cleaned != parts.trimmed()) return null
            return copy(value = cleaned.formatted(), label = label, custom = custom, address = cleaned)
        }
        val text = ContactCard.clean(value, Int.MAX_VALUE)
        if (text.isEmpty() || text.codePointCount(0, text.length) > kind.limit) return null
        return copy(value = text, label = label, custom = custom)
    }

    private fun Address.trimmed() = Address(poBox.trim(), extended.trim(), street.trim(), locality.trim(), region.trim(), postalCode.trim(), country.trim())

    fun toJson(ids: Boolean): JSONObject = JSONObject().apply {
        if (ids && id != null) put("id", id)
        if (address != null) {
            val parts = listOf(address.poBox, address.extended, address.street, address.locality, address.region, address.postalCode, address.country)
            Address.PARTS.zip(parts).forEach { (name, part) -> put(name, part.ifEmpty { null } ?: JSONObject.NULL) }
        } else put("value", value)
        put("label", label)
        put("custom_label", if (label == "custom") custom else JSONObject.NULL)
        put("preferred", preferred)
    }

    companion object {
        fun fromJson(kind: ValueKind, json: Any?): Value? {
            if (json is String) return json.trim().takeIf { it.isNotEmpty() }?.let { Value(it) }
            if (json !is JSONObject) return null
            with(ContactCard) {
                val label = json.text("label").lowercase()
                val address = if (kind == ValueKind.ADDRESS) Address.PARTS.map { json.text(it) }.let {
                    Address(it[0], it[1], it[2], it[3], it[4], it[5], it[6])
                }.takeUnless { it.isEmpty } else null
                val value = address?.formatted() ?: json.text("value")
                if (value.isEmpty()) return null
                return Value(
                    value = value,
                    label = label,
                    custom = if (label == "custom") json.text("custom_label") else "",
                    preferred = json.optBoolean("preferred", false),
                    address = address,
                    id = json.text("id").takeIf { it.isNotEmpty() },
                )
            }
        }
    }
}

/** The kinds of labelled values both sides keep, with the server's labels and limits (api/src/services/contacts.ts). */
enum class ValueKind(val field: String, val limit: Int, val labels: Set<String>, val phoneDefault: String) {
    EMAIL("emails", 255, setOf("", "home", "work", "mobile", "other", "custom"), "other"),
    PHONE("phones", 64, setOf(
        "", "mobile", "home", "work", "main", "home_fax", "work_fax", "other_fax", "pager", "work_mobile", "work_pager",
        "callback", "car", "company_main", "isdn", "radio", "telex", "tty_tdd", "assistant", "mms", "other", "custom",
    ), "mobile"),
    ADDRESS("addresses", 2048, setOf("", "home", "work", "other", "custom"), "other"),
    URL("urls", 2048, setOf("", "homepage", "blog", "profile", "home", "work", "ftp", "other", "custom"), "other"),
    IMPP("impp", 2048, setOf("", "home", "work", "other", "custom"), "other"),
    RELATED("related", 2048, setOf(
        "", "assistant", "brother", "child", "domestic_partner", "father", "friend", "manager", "mother", "parent", "partner",
        "referred_by", "relative", "sister", "spouse", "contact", "acquaintance", "met", "co_worker", "colleague", "co_resident",
        "neighbor", "sibling", "kin", "muse", "crush", "date", "sweetheart", "me", "agent", "emergency", "other", "custom",
    ), ""),
    NICKNAME("nicknames", 255, setOf("", "other_name", "maiden_name", "short_name", "initials", "custom"), "");

    /** The server's value_key (api/src/services/contact-keys.ts): the same value on both sides. */
    fun key(value: String): String = bounded(when (this) {
        EMAIL -> value.trim().lowercase()
        PHONE -> value.trim().let { text ->
            val digits = text.filter { it in '0'..'9' }
            if (digits.isEmpty()) "" else (if (text.startsWith("+")) "+" else "") + digits
        }
        URL -> value.trim().lowercase().replace(SCHEME, "").replace(TRAILING_SLASHES, "")
        else -> value.trim().lowercase().replace(SPACES, " ")
    })

    companion object {
        const val MAX_VALUES = 100
        private const val KEY_MAX = 255
        private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://")
        private val TRAILING_SLASHES = Regex("/+$")
        private val SPACES = Regex("(?U)\\s+")

        private fun bounded(text: String) =
            if (text.codePointCount(0, text.length) <= KEY_MAX) text else text.substring(0, text.offsetByCodePoints(0, KEY_MAX))
    }
}

/** What a sync writes: the phone's copy and the server's contact. */
data class MergedContact(val phone: ContactCard, val server: ContactCard)

object ContactMerge {
    /**
     * Each side takes the other's changes since the last sync; each side's
     * change is found against its own state of the last sync, so the two
     * sides may write a value differently (a number's spaces, a label the
     * phone needs) without that counting as a change.
     *
     * - The name (all its parts), organisation, department, job title,
     *   birthday, anniversary and favourite: a field both sides changed takes
     *   UniHub's value.
     * - Lists merge value by value (by the server's value_key): each side's
     *   additions and removals reach the other, and so do label changes; a
     *   label both sides changed takes UniHub's. A value both sides added (a
     *   contact joined for the first time, or the first sync after updating
     *   from the 3+3 app) is kept once, with UniHub's label unless UniHub has
     *   none. A value the server already has is never added again.
     *
     * A contact seen for the first time on both sides merges against empty
     * states: each side fills in what the other lacks, UniHub's value wins
     * where both have one.
     */
    fun merge(phone: ContactCard, phoneBase: ContactCard, server: ContactCard, serverBase: ContactCard): MergedContact {
        fun <T> field(p: T, pb: T, s: T, sb: T): Pair<T, T> {
            val serverChanged = s != sb
            val phoneChanged = p != pb
            return (if (serverChanged) s else p) to (if (phoneChanged && !serverChanged) p else s)
        }
        // The phone holds the parts only, so its change is found on the parts
        // and UniHub's on the whole name (with its display name). A name
        // changed on the phone replaces UniHub's display name.
        val phoneName = phone.name.forPhone()
        val serverNameChanged = server.name != serverBase.name
        val phoneNameChanged = phoneName != phoneBase.name.forPhone()
        val name = when {
            serverNameChanged -> server.name.forPhone() to server.name
            phoneNameChanged -> phoneName to phoneName.copy(display = "")
            else -> phoneName to server.name
        }
        val organization = field(phone.organization, phoneBase.organization, server.organization, serverBase.organization)
        val department = field(phone.department, phoneBase.department, server.department, serverBase.department)
        val title = field(phone.title, phoneBase.title, server.title, serverBase.title)
        val birthday = field(phone.birthday, phoneBase.birthday, server.birthday, serverBase.birthday)
        val anniversary = field(phone.anniversary, phoneBase.anniversary, server.anniversary, serverBase.anniversary)
        val favorite = field(phone.favorite, phoneBase.favorite, server.favorite, serverBase.favorite)

        var onPhone = ContactCard(
            organization = organization.first, department = department.first, title = title.first,
            birthday = birthday.first, anniversary = anniversary.first, favorite = favorite.first,
        ).withName(name.first)
        var onServer = ContactCard(
            organization = organization.second, department = department.second, title = title.second,
            birthday = birthday.second, anniversary = anniversary.second, favorite = favorite.second,
        ).withName(name.second)
        for (kind in ValueKind.entries) {
            val (p, s) = mergeList(kind, phone.values(kind), phoneBase.values(kind), server.values(kind), serverBase.values(kind))
            onPhone = onPhone.with(kind, p)
            onServer = onServer.with(kind, s)
        }
        return MergedContact(onPhone.forPhone(), onServer)
    }

    private fun mergeList(kind: ValueKind, phone: List<Value>, phoneBase: List<Value>, server: List<Value>, serverBase: List<Value>): Pair<List<Value>, List<Value>> {
        val key = { value: Value -> kind.key(value.value) }
        val phoneWas = phoneBase.associateBy(key)
        val serverWas = serverBase.associateBy(key)
        val phoneNow = phone.associateBy(key)
        val serverNow = server.associateBy(key)
        // Removed on that side since the last sync. When the states disagree
        // (one side added what the other removed), the value is kept on both.
        fun removedOnPhone(k: String) = k in phoneWas && k !in phoneNow
        fun removedOnServer(k: String) = k in serverWas && k !in serverNow
        fun relabelled(now: Map<String, Value>, was: Map<String, Value>, k: String) =
            now[k]?.let { value -> was[k]?.let { it.labelling != value.labelling } } == true
        fun bothAdded(k: String) = k !in phoneWas && k !in serverWas && k in phoneNow && k in serverNow
        // A value both sides added takes UniHub's label, unless UniHub has none.
        fun agreed(k: String): Value = serverNow.getValue(k).takeIf { it.label.isNotEmpty() } ?: phoneNow.getValue(k)

        val onPhone = ArrayList<Value>()
        val onPhoneKeys = HashSet<String>()
        for (value in phone) {
            val k = key(value)
            if (removedOnServer(k) && k in phoneWas) continue
            onPhoneKeys += k
            onPhone += when {
                bothAdded(k) -> value.relabel(agreed(k))
                relabelled(serverNow, serverWas, k) -> value.relabel(serverNow.getValue(k))
                else -> value
            }
        }
        for (value in server) {
            val k = key(value)
            if (k !in serverWas && onPhoneKeys.add(k)) onPhone += value.copy(id = null)
        }

        val onServer = ArrayList<Value>()
        val onServerKeys = HashSet<String>()
        for (value in server) {
            val k = key(value)
            if (removedOnPhone(k) && k in serverWas) continue
            onServerKeys += k
            onServer += when {
                bothAdded(k) -> value.relabel(agreed(k))
                relabelled(phoneNow, phoneWas, k) && !relabelled(serverNow, serverWas, k) -> value.relabel(phoneNow.getValue(k))
                else -> value
            }
        }
        for (value in phone) {
            val k = key(value)
            if (k !in phoneWas && onServerKeys.add(k)) onServer += value.copy(id = null)
        }
        return onPhone to onServer
    }

    private fun Value.relabel(from: Value) = copy(label = from.label, custom = from.custom, preferred = from.preferred)
}

/**
 * The sync state of format "3", kept in SYNC2 (the phone) and SYNC3 (the
 * server): each side's card after the last sync, the photo identity (the
 * phone's PHOTO_FILE_ID or a hash of its picture; the server's etag) and the
 * server's version.
 */
data class ContactState(val card: ContactCard, val photo: String = "", val version: Long? = null) {
    fun encode(): String = JSONObject().put("f", 3).put("c", card.toJson()).put("p", photo).apply { if (version != null) put("v", version) }.toString()

    companion object {
        fun decode(text: String?): ContactState? {
            if (text == null || !text.startsWith("{")) return null
            return try {
                val json = JSONObject(text)
                if (json.optInt("f") != 3) return null
                ContactState(ContactCard.fromJson(json.getJSONObject("c")), json.optString("p"), if (json.has("v")) json.getLong("v") else null)
            } catch (_: org.json.JSONException) {
                null
            }
        }

        /**
         * The states of a contact the 3+3 app synced (format "2"), for the
         * first sync with the full model. The six fields it shared keep their
         * state: the names, organisation, job title, and the numbers and
         * addresses both sides had (labelled as that app wrote them on the
         * phone: mobile and other). Everything that was the phone's own (a
         * fourth number, labels, addresses, birthdays, a middle name, the
         * photo, ...) starts from an empty state on both sides, as when a
         * contact is joined, so the phone's values go to UniHub and nothing
         * is added twice.
         */
        fun upgrade(phone: LegacyCard, server: LegacyCard): Pair<ContactState, ContactState> {
            val sharedPhones = server.phones.map(LegacyCard::phoneKey).toSet()
            val sharedEmails = server.emails.map(LegacyCard::emailKey).toSet()
            val phoneBase = ContactCard(
                given = phone.first, family = phone.last, organization = phone.company, title = phone.title,
                phones = phone.phones.filter { LegacyCard.phoneKey(it) in sharedPhones }.map { Value(it, "mobile") },
                emails = phone.emails.filter { LegacyCard.emailKey(it) in sharedEmails }.map { Value(it, "other") },
            )
            val serverBase = ContactCard(
                given = server.first, family = server.last, organization = server.company, title = server.title,
                phones = server.phones.map { Value(it) }, emails = server.emails.map { Value(it) },
            )
            return ContactState(phoneBase) to ContactState(serverBase)
        }
    }
}
