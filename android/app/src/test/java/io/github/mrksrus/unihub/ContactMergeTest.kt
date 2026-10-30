package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The full model's merge (servers with contacts-vcard). Synthetic contacts;
// numbers from the reserved 555-01xx range.
class ContactMergeTest {
    private val ada = ContactCard(
        given = "Ada", family = "Example", organization = "Example Labs", title = "Engineer",
        phones = listOf(Value("+15550100", "mobile", id = "v-1")),
        emails = listOf(Value("ada@example.com", "work", id = "v-2")),
        addresses = listOf(Address(street = "1 Example Street", locality = "Springfield").let { Value(it.formatted(), "home", address = it, id = "v-3") }),
    )
    private val adaOnPhone = ada.forPhone()
    private val none = ContactCard()

    private fun assertSame(expected: ContactCard, actual: ContactCard) =
        assertTrue("expected $expected, got $actual", ContactPhone.same(expected, actual))

    private fun merge(phone: ContactCard, phoneBase: ContactCard, server: ContactCard, serverBase: ContactCard) =
        ContactMerge.merge(phone, phoneBase, server, serverBase)

    /** The next sync, after each side was written as merged: nothing changes any more. */
    private fun settled(merged: MergedContact) {
        val again = merge(merged.phone, merged.phone, merged.server, merged.server)
        assertSame(merged.phone, again.phone)
        assertSame(merged.server, again.server)
    }

    @Test
    fun anEditOnThePhoneReachesUniHubWithItsLabels() {
        val edited = adaOnPhone.copy(
            middle = "M.", department = "Research", birthday = PartialDate(null, 12, 10),
            phones = adaOnPhone.phones + Value("+15550101", "work"),
            urls = listOf(Value("https://example.com/ada", "homepage")),
        )
        val merged = merge(edited, adaOnPhone, ada, ada)
        assertSame(edited, merged.phone)
        assertEquals(listOf("+15550100" to "mobile", "+15550101" to "work"), merged.server.phones.map { it.value to it.label })
        assertEquals("v-1", merged.server.phones[0].id)
        assertEquals("M.", merged.server.middle)
        assertEquals(PartialDate(null, 12, 10), merged.server.birthday)
        assertEquals("homepage", merged.server.urls.single().label)
        settled(merged)
    }

    @Test
    fun anEditInUniHubReachesThePhone() {
        val edited = ada.copy(
            organization = "", anniversary = PartialDate(1835, 7, 8), favorite = true,
            phones = ada.phones.map { it.copy(label = "home") } + Value("+15550102", "", id = "v-9"),
            nicknames = listOf(Value("Addy")),
        )
        val merged = merge(adaOnPhone, adaOnPhone, edited, ada)
        assertSame(edited.forPhone(), merged.phone)
        // A value without a label gets the phone's default there.
        assertEquals(listOf("home", "mobile"), merged.phone.phones.map { it.label })
        assertSame(edited, merged.server)
        settled(merged)
    }

    @Test
    fun aLabelBothSidesChangedTakesUniHubsAndOthersReachEachSide() {
        val onPhone = adaOnPhone.copy(
            phones = listOf(Value("+15550100", "work")),
            emails = listOf(Value("ada@example.com", "custom", "Club")),
        )
        val onServer = ada.copy(phones = listOf(Value("+15550100", "main", id = "v-1")))
        val merged = merge(onPhone, adaOnPhone, onServer, ada)
        assertEquals("main", merged.phone.phones.single().label)
        assertEquals("main", merged.server.phones.single().label)
        assertEquals("custom" to "Club", merged.server.emails.single().let { it.label to it.custom })
        settled(merged)
    }

    @Test
    fun valuesAddedAndRemovedOnEitherSideGoOnBoth() {
        val base = ada.copy(phones = listOf(Value("+15550100", "mobile", id = "v-1"), Value("+15550101", "home", id = "v-4"), Value("+15550102", "work", id = "v-5")))
        val phoneBase = base.forPhone()
        val merged = merge(
            phoneBase.copy(phones = phoneBase.phones.filter { it.value != "+15550100" } + Value("+15550103", "car")),
            phoneBase,
            base.copy(phones = base.phones.filter { it.value != "+15550101" } + Value("+15550104", "pager", id = "v-6")),
            base,
        )
        assertEquals(listOf("+15550102", "+15550103", "+15550104"), merged.phone.phones.map { it.value }.sorted())
        assertEquals(listOf("+15550102", "+15550103", "+15550104"), merged.server.phones.map { it.value }.sorted())
        settled(merged)
    }

    @Test
    fun aFieldBothChangedTakesUniHubsValueAndTheNameIsOneField() {
        val onPhone = adaOnPhone.copy(given = "Adelaide", middle = "M.", title = "Director", department = "Lab")
        val onServer = ada.copy(given = "Ada", family = "Lovelace", title = "CTO")
        val merged = merge(onPhone, adaOnPhone, onServer, ada)
        val expected = Name("", "Ada", "Lovelace")
        assertEquals(expected, merged.phone.name)
        assertEquals(expected, merged.server.name)
        assertEquals("CTO" to "Lab", merged.phone.title to merged.phone.department)
        assertEquals("CTO" to "Lab", merged.server.title to merged.server.department)
    }

    @Test
    fun aNumberWrittenDifferentlyIsNotAChange() {
        val formatted = adaOnPhone.copy(phones = listOf(Value("+1 555-0100", "mobile")))
        val merged = merge(formatted, adaOnPhone, ada, ada)
        assertEquals("+1 555-0100", merged.phone.phones.single().value)
        assertEquals(Value("+15550100", "mobile", id = "v-1"), merged.server.phones.single())
        assertSame(ada, merged.server)
    }

    @Test
    fun aContactKnownOnlyByItsDisplayNameKeepsItUntilThePhoneRenamesIt() {
        val reception = ContactCard(display = "Example Labs Reception", emails = listOf(Value("desk@example.com", id = "v-1")))
        val first = merge(none, none, reception, none)
        assertEquals(Name(given = "Example Labs Reception"), first.phone.name)
        assertEquals("Example Labs Reception", first.server.display)
        settled(first)
        val renamed = first.phone.copy(given = "Front", family = "Desk")
        val merged = merge(renamed, first.phone, first.server, first.server)
        // Renamed on the phone: UniHub takes the parts, and its display name goes.
        assertEquals(Name("", "Front", "Desk"), merged.server.name)
    }

    @Test
    fun aPhoneContactJoinedToOneInUniHubFillsBothSidesOnce() {
        val onPhone = ContactCard(
            given = "Ada", phones = listOf(Value("+1 555 0100", "work"), Value("+15550109", "home")),
            emails = listOf(Value("ADA@example.com", "home")),
        )
        val unlabelled = ada.copy(emails = listOf(Value("ada@example.com", "", id = "v-2")))
        val merged = merge(onPhone, none, unlabelled, none)
        // The same number and address are kept once; UniHub's label wins unless it has none.
        assertEquals(listOf("+1 555 0100" to "mobile", "+15550109" to "home"), merged.phone.phones.map { it.value to it.label })
        assertEquals(listOf("+15550100" to "mobile", "+15550109" to "home"), merged.server.phones.map { it.value to it.label })
        assertEquals(listOf("ada@example.com" to "home"), merged.server.emails.map { it.value to it.label })
        assertEquals("Example", merged.phone.family)
        assertEquals(1, merged.phone.addresses.size)
        settled(merged)
    }

    /**
     * 26-09: a contact the 0.25 app synced (format "2", 3+3 fields) holds on
     * the phone what that app kept as the phone's own: a fourth number,
     * labels, an address, a birthday, a middle name. The first sync with the
     * full model sends them to UniHub, adds nothing twice and takes nothing
     * away; a number UniHub got meanwhile (a 0.25-era merge) is not added again.
     */
    @Test
    fun theFirstFullSyncAfterTheUpdateSendsWhatOnlyThePhoneHadWithoutDuplicates() {
        val phoneV2 = LegacyState.decode("""["Ada","Example",["+1 555 0100","+15550101","+15550102","+15550103"],["ada@example.com"],"Example Labs",""]""")!!
        val serverV2 = LegacyState.decodeServer("""["Ada","Example",["+15550100","+15550101","+15550102"],["ada@example.com"],"Example Labs","","print"]""")!!.first
        val (phoneBase, serverBase) = ContactState.upgrade(phoneV2, serverV2)
        // As the phone holds it: the 0.25 app labelled UniHub's values mobile and other.
        val onPhone = ContactCard(
            given = "Ada", family = "Example", middle = "M.", organization = "Example Labs",
            birthday = PartialDate(null, 12, 10),
            phones = listOf(Value("+1 555 0100", "mobile"), Value("+15550101", "mobile"), Value("+15550102", "work"), Value("+15550103", "home")),
            emails = listOf(Value("ada@example.com", "other")),
            addresses = listOf(Address(street = "1 Example Street").let { Value(it.formatted(), "home", address = it) }),
        )
        // The server after its upgrade: the migrated values without labels, and
        // the fourth number from a merge in UniHub.
        val onServer = ContactCard(
            given = "Ada", family = "Example", organization = "Example Labs",
            phones = listOf("+15550100", "+15550101", "+15550102", "+1 (555) 0103").mapIndexed { i, number -> Value(number, id = "v-$i") },
            emails = listOf(Value("ada@example.com", id = "v-9")),
        )
        val merged = merge(onPhone, phoneBase.card, onServer, serverBase.card)
        assertEquals(listOf("+15550100" to "", "+15550101" to "", "+15550102" to "work", "+1 (555) 0103" to "home"), merged.server.phones.map { it.value to it.label })
        assertEquals(listOf("v-0", "v-1", "v-2", "v-3"), merged.server.phones.map { it.id })
        assertEquals("", merged.server.emails.single().label)
        assertEquals("M.", merged.server.middle)
        assertEquals(PartialDate(null, 12, 10), merged.server.birthday)
        assertEquals("1 Example Street", merged.server.addresses.single().address?.street)
        // The phone keeps what it had, nothing twice.
        assertSame(onPhone, merged.phone)
        assertEquals(4, merged.phone.phones.size)
        settled(merged)
    }

    @Test
    fun theUpgradeKeepsAChangeMadeInUniHubToASharedField() {
        val v2 = LegacyCard("Ada", "Example", listOf("+15550100"), listOf("ada@example.com"), "Example Labs", "")
        val (phoneBase, serverBase) = ContactState.upgrade(v2, v2)
        val onPhone = ContactCard(given = "Ada", family = "Example", organization = "Example Labs", phones = listOf(Value("+15550100", "mobile")), emails = listOf(Value("ada@example.com", "other")))
        val onServer = onPhone.copy(family = "Lovelace", phones = emptyList(), emails = listOf(Value("ada@example.com")))
        val merged = merge(onPhone, phoneBase.card, onServer, serverBase.card)
        assertEquals("Lovelace", merged.phone.family)
        // Removed in UniHub, so removed on the phone.
        assertEquals(emptyList<Value>(), merged.phone.phones)
    }

    @Test
    fun aSecondLongWebAddressAddedOnThePhoneReachesUniHub() {
        val start = "https://example.com/" + "a".repeat(300)
        val first = Value("$start/one", "work")
        val base = ada.copy(urls = listOf(first.copy(id = "u-1")))
        val phoneBase = base.forPhone()
        val onPhone = phoneBase.copy(urls = phoneBase.urls + Value("$start/two", "work"))
        val merged = merge(onPhone, phoneBase, base, base)
        assertEquals(listOf("$start/one", "$start/two"), merged.server.urls.map { it.value })
        assertEquals("u-1", merged.server.urls[0].id)
        settled(merged)
    }
}

