package io.github.mrksrus.unihub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Synthetic contacts: reserved example domains, numbers from the 555-01xx range.
// Phone rows are written with ContactsContract's raw column names and values,
// as a contacts app stores them, so a wrong mapping table fails here.
class ContactCardTest {
    private var nextId = 100L

    private fun row(mime: String, vararg columns: Pair<String, String?>, picture: ByteArray? = null) =
        PhoneData(nextId++, "vnd.android.cursor.item/$mime", mapOf(*columns), picture)

    /** Applies changes the way the contacts provider would, for the round trips below. */
    private fun apply(rows: List<PhoneData>, changes: List<PhoneChange>, starred: Boolean): Pair<List<PhoneData>, Boolean> {
        val result = rows.toMutableList()
        var star = starred
        for (change in changes) when (change) {
            is PhoneChange.Insert -> result += PhoneData(nextId++, change.data.mime, change.data.columns, change.data.picture)
            is PhoneChange.Update -> {
                val index = result.indexOfFirst { it.id == change.id }
                result[index] = PhoneData(change.id, result[index].mime, result[index].columns + change.columns, result[index].picture)
            }
            is PhoneChange.Delete -> result.removeAll { it.id == change.id }
            is PhoneChange.Starred -> star = change.starred
        }
        return result to star
    }

    private val everyKind = listOf(
        row("name", "data1" to "Dr. Ada M. Example Jr.", "data2" to "Ada", "data3" to "Example", "data4" to "Dr.", "data5" to "M.", "data6" to "Jr.", "data7" to "えいだ"),
        row("phone_v2", "data1" to "+1 555 0100", "data2" to "2", "is_primary" to "1"),
        row("phone_v2", "data1" to "+15550101", "data2" to "1"),
        row("phone_v2", "data1" to "+15550102", "data2" to "3"),
        row("phone_v2", "data1" to "+15550103", "data2" to "4"),
        row("phone_v2", "data1" to "+15550104", "data2" to "0", "data3" to "Boat"),
        row("phone_v2", "data1" to "+15550105", "data2" to "20"),
        row("email_v2", "data1" to "ada@example.com", "data2" to "2"),
        row("email_v2", "data1" to "ada@example.org", "data2" to "4"),
        row("email_v2", "data1" to "ada@example.net", "data2" to "0", "data3" to "Club"),
        row("postal-address_v2", "data1" to "1 Example Street\nSpringfield", "data2" to "1", "data4" to "1 Example Street", "data5" to "PO 7",
            "data6" to "Old Town", "data7" to "Springfield", "data8" to "Region", "data9" to "12345", "data10" to "Exampleland"),
        row("organization", "data1" to "Example Labs", "data2" to "1", "data4" to "Engineer", "data5" to "Research", "data6" to "Builds engines"),
        row("im", "data1" to "ada@example.org", "data2" to "3", "data5" to "7"),
        row("im", "data1" to "ada.example", "data2" to "2", "data5" to "3"),
        row("im", "data1" to "ada-signal", "data2" to "1", "data5" to "-1", "data6" to "Signal"),
        row("sip_address", "data1" to "ada@sip.example.com", "data2" to "2"),
        row("website", "data1" to "https://example.com/ada", "data2" to "1"),
        row("website", "data1" to "https://blog.example.com", "data2" to "2"),
        row("relation", "data1" to "Ben Example", "data2" to "2"),
        row("relation", "data1" to "Cy Example", "data2" to "0", "data3" to "Colleague"),
        row("relation", "data1" to "Dee Example", "data2" to "0", "data3" to "Godmother"),
        row("nickname", "data1" to "Addy", "data2" to "1"),
        row("nickname", "data1" to "Byron", "data2" to "3"),
        row("contact_event", "data1" to "--12-10", "data2" to "3"),
        row("contact_event", "data1" to "1835-07-08", "data2" to "1"),
        row("contact_event", "data1" to "2020-01-01", "data2" to "2"),
        row("photo", "data14" to "42", picture = byteArrayOf(1, 2, 3)),
        row("note", "data1" to "the phone's own note"),
        row("group_membership", "data1" to "7"),
    )

    @Test
    fun everyKindOnThePhoneHasItsPlaceInUniHub() {
        val phone = ContactPhone.read(everyKind, starred = true)
        val card = phone.card
        assertEquals(Name("", "Ada", "Example", "M.", "Dr.", "Jr."), card.name)
        assertEquals(listOf("mobile", "home", "work", "work_fax", "custom", "mms"), card.phones.map { it.label })
        assertEquals("Boat", card.phones[4].custom)
        assertEquals(listOf(true, false, false, false, false, false), card.phones.map { it.preferred })
        assertEquals(listOf("work" to "", "mobile" to "", "custom" to "Club"), card.emails.map { it.label to it.custom })
        assertEquals(Address("PO 7", "Old Town", "1 Example Street", "Springfield", "Region", "12345", "Exampleland"), card.addresses.single().address)
        assertEquals("home", card.addresses.single().label)
        assertEquals(listOf("Example Labs", "Research", "Engineer"), listOf(card.organization, card.department, card.title))
        assertEquals(
            listOf("xmpp:ada@example.org" to "other", "skype:ada.example" to "work", "Signal:ada-signal" to "home", "sip:ada@sip.example.com" to "work"),
            card.impp.map { it.value to it.label },
        )
        assertEquals(listOf("homepage", "blog"), card.urls.map { it.label })
        assertEquals(listOf("brother" to "", "colleague" to "", "custom" to "Godmother"), card.related.map { it.label to it.custom })
        assertEquals(listOf("" to "Addy", "maiden_name" to "Byron"), card.nicknames.map { it.label to it.value })
        assertEquals(PartialDate(null, 12, 10), card.birthday)
        assertEquals(PartialDate(1835, 7, 8), card.anniversary)
        assertTrue(card.favorite)
        assertEquals("f42", phone.photo)
        // Phonetic name, job description, another event and the phone's note stay on the phone.
        assertTrue(phone.phoneOnly)
        assertFalse(ContactPhone.read(everyKind.filter { it.mime.endsWith("/group_membership") || it.mime.endsWith("/phone_v2") }, false).phoneOnly)
    }

    @Test
    fun aUniHubContactWrittenToThePhoneReadsBackAsWritten() {
        val card = ContactCard(
            given = "Ada", family = "Example", middle = "M.", prefix = "Dr.", suffix = "Jr.",
            organization = "Example Labs", department = "Research", title = "Engineer",
            birthday = PartialDate(null, 2, 29), anniversary = PartialDate(1835, 7, 8), favorite = true,
            phones = ValueKind.PHONE.labels.filter { it.isNotEmpty() && it != "custom" }.mapIndexed { i, label -> Value("+1555010${"%02d".format(i)}", label) } +
                Value("+15550199", "custom", "Boat", preferred = true) + Value("+15550198"),
            emails = listOf(Value("ada@example.com", "home"), Value("ada@example.org", "mobile"), Value("ada@example.net")),
            addresses = listOf(Address(street = "1 Example Street", locality = "Springfield", postalCode = "12345").let { Value(it.formatted(), "work", address = it) }),
            urls = listOf(Value("https://example.com", "profile"), Value("ftp://example.com", "ftp")),
            impp = listOf(Value("xmpp:ada@example.org", "home"), Value("sip:ada@sip.example.com", "work"), Value("matrix:@ada:example.org"), Value("ada-handle")),
            related = listOf(Value("Ben Example", "spouse"), Value("Cy Example", "co_worker"), Value("Dee Example", "")),
            nicknames = listOf(Value("Addy"), Value("A.", "initials")),
        )
        val rows = ContactPhone.rows(card).map { PhoneData(nextId++, it.mime, it.columns, it.picture) }
        val back = ContactPhone.read(rows, starred = card.favorite)
        assertEquals(card.forPhone(), back.card)
        assertFalse(back.phoneOnly)
        // Labels Android has no type for are custom labels on the phone, named as UniHub names them.
        val relation = rows.first { it.mime.endsWith("/relation") && it.columns["data1"] == "Cy Example" }
        assertEquals("0" to "Co worker", relation.columns["data2"] to relation.columns["data3"])
        // A phone number without a label gets the phone's default (mobile), as the 3+3 sync wrote it.
        assertEquals("mobile", back.card.phones.last().label)
        val jabber = rows.first { it.columns["data1"] == "ada@example.org" && it.mime.endsWith("/im") }
        assertEquals("7", jabber.columns["data5"])
        assertTrue(rows.any { it.mime.endsWith("/sip_address") && it.columns["data1"] == "ada@sip.example.com" })
    }

    @Test
    fun aDisplayNameAloneBecomesTheGivenNameOnThePhone() {
        val card = ContactCard(display = "Example Labs Reception", emails = listOf(Value("desk@example.com")))
        val rows = ContactPhone.rows(card)
        assertEquals("Example Labs Reception", rows.first { it.mime.endsWith("/name") }.columns["data2"])
        assertNull(rows.first { it.mime.endsWith("/name") }.columns["data1"])
        val back = ContactPhone.read(rows.map { PhoneData(nextId++, it.mime, it.columns) }, false)
        assertEquals(card.forPhone(), back.card)
    }

    @Test
    fun changesTouchOnlyWhatDiffers() {
        val have = ContactPhone.read(everyKind, starred = true)
        val want = have.card.copy(
            family = "Lovelace",
            title = "",
            favorite = false,
            birthday = PartialDate(1815, 12, 10),
            anniversary = null,
            phones = have.card.phones.filter { it.value != "+15550103" }.map { if (it.value == "+15550101") it.copy(label = "work_mobile") else it } + Value("+15550106", "car"),
            emails = have.card.emails.map { it.copy(preferred = it.value == "ada@example.org") },
        )
        val changes = ContactPhone.changes(have, want)
        // The number written with spaces keeps its row; only what differs is touched.
        assertFalse(changes.any { it is PhoneChange.Update && it.id == everyKind[1].id })
        assertFalse(changes.any { it is PhoneChange.Delete && it.id == everyKind[1].id })
        assertEquals(1, changes.count { it is PhoneChange.Insert })
        val (rows, starred) = apply(everyKind, changes, starred = true)
        val back = ContactPhone.read(rows, starred)
        assertEquals(want.forPhone(), back.card)
        // The phonetic name, job description, the other event and the note are still there.
        val name = rows.first { it.mime.endsWith("/name") }
        assertEquals("えいだ" to "Lovelace", name.columns["data7"] to name.columns["data3"])
        assertEquals("Builds engines", rows.first { it.mime.endsWith("/organization") }.columns["data6"])
        assertTrue(rows.any { it.mime.endsWith("/contact_event") && it.columns["data2"] == "2" })
        assertTrue(rows.any { it.mime.endsWith("/note") })
        assertEquals(emptyList<PhoneChange>(), ContactPhone.changes(back, want))
    }

    @Test
    fun theApisContactAndTheSyncStateKeepEveryField() {
        val json = JSONObject("""{
            "id": "c-1", "version": 7, "display_name": "Ada Example",
            "name": {"display": null, "given": "Ada", "family": "Example", "middle": null, "prefix": "Dr.", "suffix": null},
            "organization": {"name": "Example Labs", "department": "Research"}, "job_title": "Engineer",
            "birthday": {"year": null, "month": 12, "day": 10}, "anniversary": {"year": 1835, "month": 7, "day": 8},
            "notes": "private note", "is_favorite": true,
            "emails": [{"id": "v-1", "value": "ada@example.com", "label": "work", "custom_label": null, "preferred": true}],
            "phones": [{"id": "v-2", "value": "+15550100", "label": "custom", "custom_label": "Boat", "preferred": false},
                       {"id": "v-3", "value": "+15550101", "label": "", "custom_label": null, "preferred": false}],
            "addresses": [{"id": "v-4", "value": "1 Example Street\n12345 Springfield", "label": "home", "custom_label": null, "preferred": false,
                           "po_box": null, "extended": null, "street": "1 Example Street", "locality": "Springfield", "region": null, "postal_code": "12345", "country": null}],
            "urls": [], "impp": [{"id": "v-5", "value": "xmpp:ada@example.org", "label": "", "preferred": false}],
            "related": [], "nicknames": [], "categories": ["Friends"], "photo": {"etag": "abc", "width": 512, "height": 512},
            "first_name": "Ada", "last_name": "Example", "email": "ada@example.com", "email2": null, "email3": null,
            "phone": "+15550100", "phone2": "+15550101", "phone3": null, "company": "Example Labs"
        }""")
        val card = ContactCard.fromJson(json)
        assertEquals(Name("", "Ada", "Example", "", "Dr.", ""), card.name)
        assertEquals(PartialDate(null, 12, 10), card.birthday)
        assertEquals("v-2", card.phones[0].id)
        assertEquals("Boat", card.phones[0].custom)
        assertEquals("1 Example Street\n12345 Springfield", card.addresses[0].value)
        assertEquals(card, ContactCard.fromJson(card.toJson()))
        val body = card.toJson()
        assertEquals("--12-10", body.getString("birthday"))
        assertEquals("v-4", body.getJSONArray("addresses").getJSONObject(0).getString("id"))
        assertEquals("Springfield", body.getJSONArray("addresses").getJSONObject(0).getString("locality"))
        assertFalse(body.has("notes"))

        val state = ContactState(card.withoutIds(), "abc", 7)
        assertEquals(state, ContactState.decode(state.encode()))
        assertNull(ContactState.decode("""["Ada","",[],[],"",""]"""))
    }

    @Test
    fun theServerGetsWhatItCanKeep() {
        val card = ContactCard(
            given = "A".repeat(300), family = " Example ", organization = "Labs\uD800",
            phones = listOf(Value("+1 555 0100"), Value("1".repeat(65)), Value("+15550101", "custom", " ")),
            emails = listOf(Value("x".repeat(250) + "@example.com")),
            addresses = listOf(Value("", address = Address(street = "S".repeat(1001)))),
        ).forServer()
        assertEquals(255, card.given.length)
        assertEquals("Example", card.family)
        assertEquals("Labs�", card.organization)
        // A number too long for UniHub stays on the phone; a custom label without text is no label.
        assertEquals(listOf("+1 555 0100" to "", "+15550101" to ""), card.phones.map { it.value to it.label })
        assertEquals(emptyList<Value>(), card.emails)
        assertEquals(emptyList<Value>(), card.addresses)
        assertTrue(ContactPhone.read(listOf(row("phone_v2", "data1" to "1".repeat(65), "data2" to "2")), false).phoneOnly)
    }

    @Test
    fun androidTypesAndUniHubLabelsMapBothWays() {
        val types = (0..20).map { type -> ContactPhone.read(listOf(row("phone_v2", "data1" to "+1555010$type", "data2" to "$type", "data3" to "Own")), false).card.phones.single() }
        assertEquals("custom", types[0].label)
        val labels = types.drop(1).map { it.label }
        assertEquals(20, labels.toSet().size)
        assertTrue(labels.all { it in ValueKind.PHONE.labels })
        for (value in types) {
            val written = ContactPhone.valueRow(ValueKind.PHONE, value)
            assertEquals(value.labelling, ContactPhone.read(listOf(PhoneData(1, written.mime, written.columns)), false).card.phones.single().labelling)
        }
    }

    @Test
    fun datesAreRealCalendarDates() {
        assertEquals(PartialDate(null, 2, 29), PartialDate.parse("--02-29"))
        assertNull(PartialDate.parse("2023-02-29"))
        assertEquals(PartialDate(2024, 2, 29), PartialDate.parse("2024-02-29"))
        assertEquals(PartialDate(1990, 1, 1), PartialDate.parse("19900101"))
        assertEquals(PartialDate(1990, 1, 1), PartialDate.parse("1990-01-01T00:00:00.000Z"))
        assertNull(PartialDate.parse("next week"))
        assertEquals("--02-29", PartialDate(null, 2, 29).text())
        // A birthday the phone cannot date stays there and blocks nothing.
        val phone = ContactPhone.read(listOf(row("contact_event", "data1" to "next week", "data2" to "3")), false)
        assertNull(phone.card.birthday)
        assertTrue(phone.phoneOnly)
    }

    @Test
    fun theServersKeysDecideWhatIsTheSameValue() {
        assertEquals("+15550100", ValueKind.PHONE.key(" +1 (555) 0100 "))
        assertEquals("15550100", ValueKind.PHONE.key("1-555-0100"))
        assertEquals("example.org/ada", ValueKind.URL.key("HTTPS://Example.org/ada/"))
        assertEquals("ada@example.com", ValueKind.EMAIL.key(" Ada@Example.com"))
        assertEquals("xmpp:ada@example.org", ValueKind.IMPP.key("XMPP:ada@example.org"))
        assertTrue(ContactPhone.same(
            ContactCard(phones = listOf(Value("+1 555 0100", "mobile"))),
            ContactCard(phones = listOf(Value("+15550100", "mobile", id = "v-1"))),
        ))
        assertFalse(ContactPhone.same(ContactCard(phones = listOf(Value("+15550100", "mobile"))), ContactCard(phones = listOf(Value("+15550100", "work")))))
    }
}
