package io.github.mrksrus.unihub

import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Event
import android.provider.ContactsContract.CommonDataKinds.GroupMembership
import android.provider.ContactsContract.CommonDataKinds.Identity
import android.provider.ContactsContract.CommonDataKinds.Im
import android.provider.ContactsContract.CommonDataKinds.Nickname
import android.provider.ContactsContract.CommonDataKinds.Note
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.Photo
import android.provider.ContactsContract.CommonDataKinds.Relation
import android.provider.ContactsContract.CommonDataKinds.SipAddress
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.CommonDataKinds.Website
import java.security.MessageDigest

/**
 * One data row of a phone contact (ContactsContract.Data): its MIME type and
 * columns as text ("data1" to "data15", "is_primary"), and a photo's picture.
 * Plain Kotlin, so the mapping below has JVM tests; ContactsSync turns these
 * into provider operations.
 */
class PhoneData(val id: Long?, val mime: String, val columns: Map<String, String?>, val picture: ByteArray? = null) {
    fun text(column: String): String = columns[column]?.trim().orEmpty()
    fun number(column: String): Int? = columns[column]?.trim()?.toIntOrNull()
}

/** A change to a phone contact's data rows (and its star). */
sealed interface PhoneChange {
    data class Insert(val data: PhoneData) : PhoneChange
    data class Update(val id: Long, val columns: Map<String, String?>) : PhoneChange
    data class Delete(val id: Long) : PhoneChange
    data class Starred(val starred: Boolean) : PhoneChange
}

/**
 * What the phone holds of a contact in UniHub's terms, with the rows each
 * part came from. [phoneOnly]: it also holds something UniHub does not keep
 * (phonetic names, notes, other events, a second organisation, a value too
 * long for UniHub, ...), which stays on the phone and keeps the contact there
 * when UniHub's contacts are taken off (ContactsSync.clear).
 */
class PhoneContact(
    val card: ContactCard,
    val photo: String,
    val photoRow: Long?,
    val phoneOnly: Boolean,
    val nameRow: Long?,
    val orgRow: Long?,
    val birthdayRow: Long?,
    val anniversaryRow: Long?,
    val rows: Map<ValueKind, List<Pair<Long, Value>>>,
)

/**
 * Android's contact kinds and UniHub's model (docs/ANDROID.md, "Contacts on
 * the phone"). Labels follow AOSP's vCard composer: every Android type has a
 * label of its own in UniHub, a relation UniHub knows and Android does not
 * ("Colleague") is a custom label on the phone and is read back as its
 * label. Messaging addresses are IMPP URIs (`xmpp:`, `skype:`, `sip:` for
 * SIP addresses, the custom protocol's name otherwise).
 */
object ContactPhone {
    private val PHONE_TYPES = mapOf(
        Phone.TYPE_HOME to "home", Phone.TYPE_MOBILE to "mobile", Phone.TYPE_WORK to "work", Phone.TYPE_FAX_WORK to "work_fax",
        Phone.TYPE_FAX_HOME to "home_fax", Phone.TYPE_PAGER to "pager", Phone.TYPE_OTHER to "other", Phone.TYPE_CALLBACK to "callback",
        Phone.TYPE_CAR to "car", Phone.TYPE_COMPANY_MAIN to "company_main", Phone.TYPE_ISDN to "isdn", Phone.TYPE_MAIN to "main",
        Phone.TYPE_OTHER_FAX to "other_fax", Phone.TYPE_RADIO to "radio", Phone.TYPE_TELEX to "telex", Phone.TYPE_TTY_TDD to "tty_tdd",
        Phone.TYPE_WORK_MOBILE to "work_mobile", Phone.TYPE_WORK_PAGER to "work_pager", Phone.TYPE_ASSISTANT to "assistant", Phone.TYPE_MMS to "mms",
    )
    private val EMAIL_TYPES = mapOf(Email.TYPE_HOME to "home", Email.TYPE_WORK to "work", Email.TYPE_OTHER to "other", Email.TYPE_MOBILE to "mobile")
    private val POSTAL_TYPES = mapOf(StructuredPostal.TYPE_HOME to "home", StructuredPostal.TYPE_WORK to "work", StructuredPostal.TYPE_OTHER to "other")
    private val WEBSITE_TYPES = mapOf(
        Website.TYPE_HOMEPAGE to "homepage", Website.TYPE_BLOG to "blog", Website.TYPE_PROFILE to "profile", Website.TYPE_HOME to "home",
        Website.TYPE_WORK to "work", Website.TYPE_FTP to "ftp", Website.TYPE_OTHER to "other",
    )
    // Im and SipAddress share their types.
    private val IM_TYPES = mapOf(Im.TYPE_HOME to "home", Im.TYPE_WORK to "work", Im.TYPE_OTHER to "other")
    private val RELATION_TYPES = mapOf(
        Relation.TYPE_ASSISTANT to "assistant", Relation.TYPE_BROTHER to "brother", Relation.TYPE_CHILD to "child",
        Relation.TYPE_DOMESTIC_PARTNER to "domestic_partner", Relation.TYPE_FATHER to "father", Relation.TYPE_FRIEND to "friend",
        Relation.TYPE_MANAGER to "manager", Relation.TYPE_MOTHER to "mother", Relation.TYPE_PARENT to "parent", Relation.TYPE_PARTNER to "partner",
        Relation.TYPE_REFERRED_BY to "referred_by", Relation.TYPE_RELATIVE to "relative", Relation.TYPE_SISTER to "sister", Relation.TYPE_SPOUSE to "spouse",
    )
    private val NICKNAME_TYPES = mapOf(
        Nickname.TYPE_DEFAULT to "", Nickname.TYPE_OTHER_NAME to "other_name", Nickname.TYPE_MAIDEN_NAME to "maiden_name",
        Nickname.TYPE_SHORT_NAME to "short_name", Nickname.TYPE_INITIALS to "initials",
    )
    // Im.PROTOCOL_* as IMPP URI schemes; PROTOCOL_CUSTOM carries its own name.
    private val PROTOCOLS = mapOf(
        Im.PROTOCOL_AIM to "aim", Im.PROTOCOL_MSN to "msnim", Im.PROTOCOL_YAHOO to "ymsgr", Im.PROTOCOL_SKYPE to "skype",
        Im.PROTOCOL_QQ to "qq", Im.PROTOCOL_GOOGLE_TALK to "gtalk", Im.PROTOCOL_ICQ to "icq", Im.PROTOCOL_JABBER to "xmpp",
        Im.PROTOCOL_NETMEETING to "netmeeting",
    )
    private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*):(.+)$", RegexOption.DOT_MATCHES_ALL)
    // Mime types that are the contacts app's bookkeeping, never content.
    private val BOOKKEEPING = setOf(GroupMembership.CONTENT_ITEM_TYPE, Identity.CONTENT_ITEM_TYPE)

    private fun types(kind: ValueKind): Map<Int, String> = when (kind) {
        ValueKind.PHONE -> PHONE_TYPES
        ValueKind.EMAIL -> EMAIL_TYPES
        ValueKind.ADDRESS -> POSTAL_TYPES
        ValueKind.URL -> WEBSITE_TYPES
        ValueKind.IMPP -> IM_TYPES
        ValueKind.RELATED -> RELATION_TYPES
        ValueKind.NICKNAME -> NICKNAME_TYPES
    }

    private fun kindOf(mime: String): ValueKind? = when (mime) {
        Phone.CONTENT_ITEM_TYPE -> ValueKind.PHONE
        Email.CONTENT_ITEM_TYPE -> ValueKind.EMAIL
        StructuredPostal.CONTENT_ITEM_TYPE -> ValueKind.ADDRESS
        Website.CONTENT_ITEM_TYPE -> ValueKind.URL
        Im.CONTENT_ITEM_TYPE, SipAddress.CONTENT_ITEM_TYPE -> ValueKind.IMPP
        Relation.CONTENT_ITEM_TYPE -> ValueKind.RELATED
        Nickname.CONTENT_ITEM_TYPE -> ValueKind.NICKNAME
        else -> null
    }

    // A label as UniHub names it: the type's own, a custom label (one that
    // names a label UniHub knows is that label), or none.
    private fun label(kind: ValueKind, row: PhoneData): Pair<String, String> {
        val type = row.number("data2") ?: return "" to ""
        types(kind)[type]?.let { return it to "" }
        val custom = row.text("data3")
        if (type != 0 || custom.isEmpty()) return "" to ""
        val named = custom.lowercase().replace(Regex("[\\s-]+"), "_")
        if (named in kind.labels && named !in types(kind).values && named != "custom") return named to ""
        return "custom" to custom
    }

    private fun readable(label: String) = label.replace('_', ' ').replaceFirstChar { it.uppercase() }

    // The type and label columns for a label: Android's type, else custom with the label's text.
    private fun labelColumns(kind: ValueKind, value: Value): Map<String, String?> {
        val type = types(kind).entries.firstOrNull { it.value == value.label && value.label != "custom" }?.key
        return mapOf(
            "data2" to (type ?: 0).toString(),
            "data3" to when {
                type != null -> null
                value.label == "custom" -> value.custom.ifEmpty { null }
                value.label.isEmpty() -> null
                else -> readable(value.label)
            },
            "is_primary" to if (value.preferred) "1" else "0",
        )
    }

    /** The phone contact of these data rows (RawContactsEntity) and its star. */
    fun read(data: List<PhoneData>, starred: Boolean): PhoneContact {
        var card = ContactCard(favorite = starred)
        var phoneOnly = false
        var nameRow: Long? = null
        var orgRow: Long? = null
        var birthdayRow: Long? = null
        var anniversaryRow: Long? = null
        var photoRow: Long? = null
        var photo = ""
        val rows = ValueKind.entries.associateWith { ArrayList<Pair<Long, Value>>() }
        for (row in data) {
            val id = row.id ?: continue
            val kind = kindOf(row.mime)
            if (kind != null) {
                val value = value(kind, row) ?: continue
                rows.getValue(kind) += id to value
                if (value.forServer(kind) == null || rows.getValue(kind).size > ValueKind.MAX_VALUES) phoneOnly = true
                continue
            }
            when (row.mime) {
                StructuredName.CONTENT_ITEM_TYPE -> if (nameRow == null) {
                    nameRow = id
                    card = card.copy(given = row.text("data2"), family = row.text("data3"), prefix = row.text("data4"), middle = row.text("data5"), suffix = row.text("data6"))
                    // Android splits a display name into the parts; one without parts is the given name.
                    if (card.name.parts.all { it.isEmpty() }) card = card.copy(given = row.text("data1"))
                    if ((7..9).any { row.text("data$it").isNotEmpty() }) phoneOnly = true
                } else if (row.columns.values.any { !it.isNullOrBlank() }) phoneOnly = true
                Organization.CONTENT_ITEM_TYPE -> if (orgRow == null) {
                    orgRow = id
                    card = card.copy(organization = row.text("data1"), title = row.text("data4"), department = row.text("data5"))
                    if ((6..9).any { row.text("data$it").isNotEmpty() }) phoneOnly = true
                } else if ((1..9).any { row.text("data$it").isNotEmpty() }) phoneOnly = true
                Event.CONTENT_ITEM_TYPE -> {
                    val date = PartialDate.parse(row.text("data1"))
                    when {
                        row.number("data2") == Event.TYPE_BIRTHDAY && birthdayRow == null -> { birthdayRow = id; card = card.copy(birthday = date) }
                        row.number("data2") == Event.TYPE_ANNIVERSARY && anniversaryRow == null -> { anniversaryRow = id; card = card.copy(anniversary = date) }
                        else -> phoneOnly = true
                    }
                    if (date == null && row.text("data1").isNotEmpty()) phoneOnly = true
                }
                Photo.CONTENT_ITEM_TYPE -> if (photoRow == null) {
                    photoRow = id
                    photo = photoIdentity(row.columns["data14"], row.picture)
                }
                Note.CONTENT_ITEM_TYPE -> if (row.text("data1").isNotEmpty()) phoneOnly = true
                in BOOKKEEPING -> {}
                else -> if (row.columns.values.any { !it.isNullOrBlank() } || row.picture != null) phoneOnly = true
            }
        }
        for (kind in ValueKind.entries) card = card.with(kind, rows.getValue(kind).map { it.second })
        val name = card.name.forPhone()
        return PhoneContact(card.withName(name), photo, photoRow, phoneOnly, nameRow, orgRow, birthdayRow, anniversaryRow, rows)
    }

    /**
     * The phone's photo identity: Android's display photo file (a new one for
     * every new picture), else a hash of the thumbnail it holds; '' for none.
     */
    fun photoIdentity(fileId: String?, thumbnail: ByteArray?): String = when {
        !fileId.isNullOrBlank() -> "f" + fileId.trim()
        thumbnail != null && thumbnail.isNotEmpty() -> "t" + MessageDigest.getInstance("SHA-256").digest(thumbnail).take(12).joinToString("") { "%02x".format(it) }
        else -> ""
    }

    private fun value(kind: ValueKind, row: PhoneData): Value? {
        val (label, custom) = label(kind, row)
        val preferred = row.text("is_primary") == "1"
        return when (kind) {
            ValueKind.ADDRESS -> {
                var address = Address(
                    poBox = row.text("data5"), extended = row.text("data6"), street = row.text("data4"), locality = row.text("data7"),
                    region = row.text("data8"), postalCode = row.text("data9"), country = row.text("data10"),
                )
                // An address saved as text only (Android normally splits it into the street).
                if (address.isEmpty) address = Address(street = row.text("data1"))
                if (address.isEmpty) null else Value(address.formatted(), label, custom, preferred, address)
            }
            ValueKind.IMPP -> {
                val handle = row.text("data1").takeIf { it.isNotEmpty() } ?: return null
                val uri = if (row.mime == SipAddress.CONTENT_ITEM_TYPE) {
                    if (handle.startsWith("sip:", ignoreCase = true)) handle else "sip:$handle"
                } else {
                    val protocol = row.number("data5")
                    val scheme = PROTOCOLS[protocol] ?: row.text("data6").takeIf { protocol == Im.PROTOCOL_CUSTOM && it.isNotEmpty() }
                    if (scheme == null || handle.startsWith("$scheme:", ignoreCase = true)) handle else "$scheme:$handle"
                }
                Value(uri, label, custom, preferred)
            }
            else -> row.text("data1").takeIf { it.isNotEmpty() }?.let { Value(it.take(ContactCard.READ_MAX), label, custom, preferred) }
        }
    }

    /** The data row of one value (a new row, or the columns an update sets). */
    fun valueRow(kind: ValueKind, value: Value): PhoneData {
        val labels = labelColumns(kind, value)
        return when (kind) {
            ValueKind.PHONE -> PhoneData(null, Phone.CONTENT_ITEM_TYPE, labels + ("data1" to value.value))
            ValueKind.EMAIL -> PhoneData(null, Email.CONTENT_ITEM_TYPE, labels + ("data1" to value.value))
            ValueKind.ADDRESS -> {
                val address = value.address ?: Address(street = value.value)
                PhoneData(null, StructuredPostal.CONTENT_ITEM_TYPE, labels + mapOf(
                    "data4" to address.street.ifEmpty { null }, "data5" to address.poBox.ifEmpty { null }, "data6" to address.extended.ifEmpty { null },
                    "data7" to address.locality.ifEmpty { null }, "data8" to address.region.ifEmpty { null }, "data9" to address.postalCode.ifEmpty { null },
                    "data10" to address.country.ifEmpty { null },
                ))
            }
            ValueKind.URL -> PhoneData(null, Website.CONTENT_ITEM_TYPE, labels + ("data1" to value.value))
            ValueKind.RELATED -> PhoneData(null, Relation.CONTENT_ITEM_TYPE, labels + ("data1" to value.value))
            ValueKind.NICKNAME -> PhoneData(null, Nickname.CONTENT_ITEM_TYPE, labels + ("data1" to value.value))
            ValueKind.IMPP -> {
                val match = SCHEME.matchEntire(value.value)
                val scheme = match?.groupValues?.get(1)
                val rest = match?.groupValues?.get(2) ?: value.value
                when {
                    scheme.equals("sip", ignoreCase = true) -> PhoneData(null, SipAddress.CONTENT_ITEM_TYPE, labels + ("data1" to rest))
                    scheme == null -> PhoneData(null, Im.CONTENT_ITEM_TYPE, labels + mapOf("data1" to value.value, "data5" to Im.PROTOCOL_CUSTOM.toString(), "data6" to null))
                    else -> {
                        val protocol = PROTOCOLS.entries.firstOrNull { it.value == scheme.lowercase() }?.key
                        PhoneData(null, Im.CONTENT_ITEM_TYPE, labels + mapOf(
                            "data1" to rest,
                            "data5" to (protocol ?: Im.PROTOCOL_CUSTOM).toString(),
                            "data6" to if (protocol == null) scheme else null,
                        ))
                    }
                }
            }
        }
    }

    private fun nameColumns(card: ContactCard): Map<String, String?> {
        val name = card.name.forPhone()
        // The parts only: Android puts the display name together from them.
        return mapOf(
            "data2" to name.given.ifEmpty { null }, "data3" to name.family.ifEmpty { null }, "data4" to name.prefix.ifEmpty { null },
            "data5" to name.middle.ifEmpty { null }, "data6" to name.suffix.ifEmpty { null },
        )
    }

    private fun organizationColumns(card: ContactCard) =
        mapOf("data1" to card.organization.ifEmpty { null }, "data4" to card.title.ifEmpty { null }, "data5" to card.department.ifEmpty { null })

    private fun event(type: Int, date: PartialDate) = PhoneData(null, Event.CONTENT_ITEM_TYPE, mapOf("data1" to date.text(), "data2" to type.toString()))

    /** The data rows of a new phone contact (its star is set on the raw contact). */
    fun rows(card: ContactCard): List<PhoneData> = buildList {
        val phone = card.forPhone()
        if (phone.name.parts.any { it.isNotEmpty() }) add(PhoneData(null, StructuredName.CONTENT_ITEM_TYPE, nameColumns(phone)))
        if (phone.organization.isNotEmpty() || phone.title.isNotEmpty() || phone.department.isNotEmpty()) {
            add(PhoneData(null, Organization.CONTENT_ITEM_TYPE, organizationColumns(phone) + ("data2" to Organization.TYPE_WORK.toString())))
        }
        phone.birthday?.let { add(event(Event.TYPE_BIRTHDAY, it)) }
        phone.anniversary?.let { add(event(Event.TYPE_ANNIVERSARY, it)) }
        for (kind in ValueKind.entries) phone.values(kind).forEach { add(valueRow(kind, it)) }
    }

    /**
     * Turns the phone contact into [want], touching only what differs: a
     * value whose number or address is the same keeps its row and its
     * writing, and what UniHub does not keep (phonetic names, the
     * organisation's type, other events, ...) stays as it is.
     */
    fun changes(have: PhoneContact, want: ContactCard): List<PhoneChange> = buildList {
        val phone = want.forPhone()
        val now = have.card
        if (phone.name != now.name) {
            val existing = have.nameRow
            if (existing != null) add(PhoneChange.Update(existing, nameColumns(phone)))
            else if (phone.name.parts.any { it.isNotEmpty() }) add(PhoneChange.Insert(PhoneData(null, StructuredName.CONTENT_ITEM_TYPE, nameColumns(phone))))
        }
        if (phone.organization != now.organization || phone.title != now.title || phone.department != now.department) {
            val existing = have.orgRow
            if (existing != null) add(PhoneChange.Update(existing, organizationColumns(phone)))
            else add(PhoneChange.Insert(PhoneData(null, Organization.CONTENT_ITEM_TYPE, organizationColumns(phone) + ("data2" to Organization.TYPE_WORK.toString()))))
        }
        fun date(row: Long?, type: Int, current: PartialDate?, wanted: PartialDate?) {
            if (current == wanted) return
            when {
                wanted == null -> row?.let { add(PhoneChange.Delete(it)) }
                row != null -> add(PhoneChange.Update(row, mapOf("data1" to wanted.text())))
                else -> add(PhoneChange.Insert(event(type, wanted)))
            }
        }
        date(have.birthdayRow, Event.TYPE_BIRTHDAY, now.birthday, phone.birthday)
        date(have.anniversaryRow, Event.TYPE_ANNIVERSARY, now.anniversary, phone.anniversary)
        if (phone.favorite != now.favorite) add(PhoneChange.Starred(phone.favorite))
        for (kind in ValueKind.entries) {
            val wanted = LinkedHashMap<String, Value>()
            phone.values(kind).forEach { wanted.putIfAbsent(kind.key(it.value), it) }
            val present = HashSet<String>()
            for ((id, value) in have.rows.getValue(kind)) {
                val key = kind.key(value.value)
                val target = wanted[key]
                if (target == null) { add(PhoneChange.Delete(id)); continue }
                present += key
                if (target.labelling != value.labelling) add(PhoneChange.Update(id, labelColumns(kind, target)))
            }
            for ((key, value) in wanted) if (key !in present) add(PhoneChange.Insert(valueRow(kind, value)))
        }
    }

    /**
     * Whether two cards hold the same: the same single fields, and per kind
     * the same values (by the server's key) with the same labels. A value
     * written differently (spaces in a number, a scheme's case) is the same.
     */
    fun same(a: ContactCard, b: ContactCard): Boolean {
        val plain = { card: ContactCard -> ValueKind.entries.fold(card.copy()) { c, kind -> c.with(kind, emptyList()) } }
        if (plain(a) != plain(b)) return false
        return ValueKind.entries.all { kind ->
            val set = { card: ContactCard -> card.values(kind).map { kind.key(it.value) to it.labelling }.toSet() }
            set(a) == set(b)
        }
    }
}
