package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// What one sync with the full model does with each phone contact.
class ContactPlanTest {
    private fun row(id: Long, source: String?, deleted: Boolean = false, changed: Boolean = false, changedInUniHub: Boolean = false) =
        ContactPlan.Row(id, source, deleted, changed, changedInUniHub)

    /**
     * 26-07: "Merge all" of 12 groups in UniHub. Each group's merged-away
     * contact leaves the phone and its survivor stays; nothing is deleted in
     * UniHub and Android shows no "Too many deletions".
     */
    @Test
    fun mergeAllOfTwelveGroupsRemovesTheMergedAwayCopiesWithoutAQuestion() {
        val survivors = (1..12).map { "s-$it" }
        val mergedAway = (1..12).associate { "m-$it" to "s-$it" }
        val rows = survivors.mapIndexed { i, id -> row(i + 1L, id) } + mergedAway.keys.mapIndexed { i, id -> row(100L + i, id) }
        val plan = ContactPlan.plan(rows, listed = survivors.toSet() + "other", merged = mergedAway)
        assertFalse(plan.tooManyDeletions)
        assertEquals(emptyMap<String, List<ContactPlan.Row>>(), plan.deleteInUniHub)
        assertEquals(mergedAway.keys, plan.removeFromPhone.map { it.source }.toSet())
        assertEquals(survivors.toSet(), plan.merge.map { it.source }.toSet())
        assertEquals(emptyList<ContactPlan.Row>(), plan.unlinked)
    }

    @Test
    fun aMergedAwayContactThePhoneChangedPassesTheChangeToTheSurvivor() {
        val plan = ContactPlan.plan(listOf(row(1, "m-1", changed = true), row(2, "s-1")), listed = setOf("s-1"), merged = mapOf("m-1" to "s-1"))
        assertEquals(listOf(1L to "s-1"), plan.intoSurvivor.map { it.first.id to it.second })
        assertEquals(emptyList<ContactPlan.Row>(), plan.removeFromPhone)
        assertEquals(emptyList<ContactPlan.Row>(), plan.unlinked)

        // The phone's change, three-way against the copy's last state, lands on the survivor.
        val copy = ContactCard(given = "Ada", emails = listOf(Value("ada@example.com", "other")))
        val survivor = ContactCard(given = "Ada", family = "Example", emails = listOf(Value("ada@example.com", "work", id = "v-1"), Value("ada@example.org", id = "v-2")))
        val changed = copy.copy(phones = listOf(Value("+15550100", "mobile")))
        val result = ContactMerge.merge(changed, copy, survivor, survivor).server
        assertEquals(survivor.name, result.name)
        assertEquals(survivor.emails, result.emails)
        assertEquals(listOf("+15550100"), result.phones.map { it.value })
    }

    @Test
    fun aCopyDeletedOnThePhoneOfAMergedAwayContactIsOnlyRemoved() {
        val plan = ContactPlan.plan(
            (1L..12L).map { row(it, "m-$it", deleted = true) },
            listed = (1..12).map { "s-$it" }.toSet(),
            merged = (1..12).associate { "m-$it" to "s-$it" },
        )
        assertEquals(12, plan.removeFromPhone.size)
        assertFalse(plan.tooManyDeletions)
        assertTrue(plan.deleteInUniHub.isEmpty())
    }

    @Test
    fun manyDeletionsOnThePhoneStillWaitForAnAnswer() {
        val listed = (1..20).map { "c-$it" }.toSet()
        val rows = (1L..20L).map { row(it, "c-$it", deleted = it <= 12) }
        val asked = ContactPlan.plan(rows, listed, emptyMap())
        assertTrue(asked.tooManyDeletions)
        assertEquals((1..12).map { "c-$it" }.toSet(), asked.waiting)
        assertTrue(asked.deleteInUniHub.isEmpty())

        val confirmed = ContactPlan.plan(rows, listed, emptyMap(), overrideTooMany = true)
        assertEquals(12, confirmed.deleteInUniHub.size)
        val undone = ContactPlan.plan(rows, listed, emptyMap(), discardPhoneDeletions = true)
        assertEquals(12, undone.undone.size)
        assertTrue(undone.deleteInUniHub.isEmpty())

        // A few deletions go through at once; one UniHub changed since comes back.
        val few = ContactPlan.plan(listOf(row(1, "c-1", deleted = true), row(2, "c-2", deleted = true, changedInUniHub = true)), listed, emptyMap())
        assertEquals(setOf("c-1"), few.deleteInUniHub.keys)
        assertEquals(listOf(2L), few.restore.map { it.id })
    }

    @Test
    fun aContactGoneFromUniHubLeavesThePhoneUnlessThePhoneChangedIt() {
        val plan = ContactPlan.plan(
            listOf(row(1, "gone"), row(2, "gone-changed", changed = true), row(3, null), row(4, "m-1", changed = true)),
            listed = setOf("c-1"),
            // The survivor itself was deleted since.
            merged = mapOf("m-1" to "deleted-survivor"),
        )
        assertEquals(listOf(1L), plan.removeFromPhone.map { it.id })
        assertEquals(listOf(2L, 3L, 4L), plan.unlinked.map { it.id })
    }

    @Test
    fun anUndoneMergeBringsTheContactBackAsNew() {
        // After an undo the merged-away id is listed again and no longer merged:
        // the survivor's copy merges, and the restored contact has no copy
        // (it was removed), so the sync adds it as new.
        val plan = ContactPlan.plan(listOf(row(1, "s-1")), listed = setOf("s-1", "m-1"), merged = emptyMap())
        assertEquals(listOf("s-1"), plan.merge.map { it.source })
        assertTrue(plan.removeFromPhone.isEmpty())
    }
}
