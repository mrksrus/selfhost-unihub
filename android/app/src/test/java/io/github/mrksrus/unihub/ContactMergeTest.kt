package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Synthetic contacts; numbers from the reserved 555-01xx range.
class ContactMergeTest {
    private val ada = ContactCard("Ada", "Example", listOf("+15550100"), listOf("ada@example.com"), "Example Labs", "Engineer")
    private val none = ContactCard()

    private fun assertSame(expected: ContactCard, actual: ContactCard) =
        assertTrue("expected $expected, got $actual", expected.sameAs(actual))

    @Test
    fun anEditOnThePhoneReachesTheServerAndStaysOnThePhone() {
        val edited = ada.copy(last = "Changed", phones = listOf("+15550100", "+15550101"))
        val merged = ContactMerge.merge(edited, ada, ada, ada)
        assertSame(edited, merged.phone)
        assertSame(edited, merged.server)
    }

    @Test
    fun anEditInUniHubReachesThePhone() {
        val edited = ada.copy(company = "", emails = listOf("ada@example.org"))
        val merged = ContactMerge.merge(ada, ada, edited, ada)
        assertSame(edited, merged.phone)
        assertSame(edited, merged.server)
    }

    @Test
    fun bothSidesKeepTheOthersChangesAndUniHubWinsTheSameField() {
        val onPhone = ada.copy(first = "Adelaide", title = "Director", phones = listOf("+15550100", "+15550102"))
        val onServer = ada.copy(first = "Ada Lovelace", emails = listOf("ada@example.com", "ada@example.net"))
        val merged = ContactMerge.merge(onPhone, ada, onServer, ada)
        val expected = ada.copy(
            first = "Ada Lovelace",
            title = "Director",
            phones = listOf("+15550100", "+15550102"),
            emails = listOf("ada@example.com", "ada@example.net"),
        )
        assertSame(expected, merged.phone)
        assertSame(expected, merged.server)
    }

    @Test
    fun aNumberRemovedOnEitherSideGoesOnBoth() {
        val base = ada.copy(phones = listOf("+15550100", "+15550101", "+15550102"))
        val merged = ContactMerge.merge(
            base.copy(phones = listOf("+15550100", "+15550102")),
            base,
            base.copy(phones = listOf("+15550101", "+15550102")),
            base,
        )
        assertEquals(listOf("+15550102"), merged.phone.phones)
        assertEquals(listOf("+15550102"), merged.server.phones)
    }

    @Test
    fun theServerKeepsThreeNumbersAndThePhoneKeepsTheRest() {
        val four = ada.copy(phones = listOf("+15550100", "+15550101", "+15550102", "+15550103"))
        val merged = ContactMerge.merge(four, ada, ada, ada)
        assertEquals(four.phones, merged.phone.phones)
        assertEquals(four.phones.take(3), merged.server.phones)

        // The next sync changes nothing: the fourth number is the phone's own.
        val next = ContactMerge.merge(merged.phone, merged.phone, merged.server, merged.server)
        assertEquals(four.phones, next.phone.phones)
        assertEquals(four.phones.take(3), next.server.phones)

        // When a place frees up, the fourth number takes it.
        val fewer = four.copy(phones = four.phones - "+15550101")
        val after = ContactMerge.merge(fewer, merged.phone, merged.server, merged.server)
        assertEquals(fewer.phones, after.server.phones)
    }

    @Test
    fun aNumberWrittenDifferentlyIsNotAChange() {
        val formatted = ada.copy(phones = listOf("+1 555-0100"))
        assertTrue(formatted.sameAs(ada))
        val merged = ContactMerge.merge(formatted, ada, ada, ada)
        assertEquals(listOf("+1 555-0100"), merged.phone.phones)
        assertEquals(listOf("+15550100"), merged.server.phones)
    }

    @Test
    fun aPhoneContactMatchedInUniHubFillsBothSides() {
        val onPhone = ContactCard("Ada", "", listOf("+1 555 0100", "+15550109"), emptyList(), "", "")
        val merged = ContactMerge.merge(onPhone, none, ada, none)
        assertSame(ada.copy(phones = listOf("+15550100", "+15550109")), merged.phone)
        assertSame(ada.copy(phones = listOf("+15550100", "+15550109")), merged.server)
        assertEquals("Example", merged.phone.last)
    }

    @Test
    fun theServerGetsWhatItCanKeep() {
        val long = ContactCard("A".repeat(150), "", listOf("1".repeat(60), "+15550100"), listOf("x@example.com", "X@Example.com"), "C".repeat(300), "")
        val server = long.forServer()
        assertEquals(100, server.first.length)
        assertEquals(listOf("+15550100"), server.phones)
        assertEquals(listOf("x@example.com"), server.emails)
        assertEquals(255, server.company.length)
    }

    @Test
    fun aContactWithoutFirstNameGetsOneForTheServer() {
        assertEquals(ContactCard("Example"), ContactCard(last = "Example").withFirstName())
        assertEquals("Example Labs", ContactCard(company = "Example Labs").withFirstName().first)
        assertEquals("+15550100", ContactCard(phones = listOf("+15550100")).withFirstName().first)
    }

    @Test
    fun theSamePersonIsRecognisedByAddressOrNumber() {
        val onPhone = ContactCard("A", "", listOf("(555) 010-0100"), emptyList(), "", "")
        val inUniHub = ContactCard("Ada", "", listOf("+1 555 010 0100"), emptyList(), "", "")
        assertTrue(onPhone.identity().any { it in inUniHub.identity() })
        assertTrue(ContactCard("Ada", "Example").identity().any { it in ContactCard("ada", "example").identity() })
        assertFalse(ContactCard("Ada", "Example", emails = listOf("a@example.com")).identity().any { it in ContactCard("Ada", "Example").identity() })
        assertTrue(none.isEmpty)
        assertTrue(none.identity().isEmpty())
    }

    @Test
    fun aFourthNumberStillFindsThePersonInUniHub() {
        val onPhone = ContactCard("Ada", "", listOf("+15550101", "+15550102", "+15550103", "+15550100"))
        val keys = onPhone.withFirstName().let { it.identity() + it.forServer().identity() }
        assertTrue(keys.any { it in ada.identity() })
    }

    @Test
    fun aContactWithoutFirstNameIsRecognisedByTheOneUniHubGaveIt() {
        // A creation whose answer was lost must find its contact, not add it again.
        for (onPhone in listOf(
            ContactCard(company = "Example Labs"),
            ContactCard(last = "Example"),
            ContactCard(title = "Engineer", company = "Example Labs"),
            ContactCard("Ada", "E".repeat(120)),
            // Cut right after a space, which the server trims.
            ContactCard("Abc ".repeat(25) + "Tail", "Example"),
        )) {
            val sent = onPhone.withFirstName().forServer()
            // What the server answers: the same, as it stores it.
            val inUniHub = ContactCard(sent.first.trim(), sent.last.trim(), sent.phones, sent.emails, sent.company, sent.title)
            assertTrue("$onPhone", sent.identity().any { it in inUniHub.identity() })
        }
    }
}
