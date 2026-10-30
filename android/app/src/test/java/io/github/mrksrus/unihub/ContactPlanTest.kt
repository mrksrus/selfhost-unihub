package io.github.mrksrus.unihub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
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

    /**
     * A photo set on the phone for a contact UniHub then merged away: the
     * picture goes to the survivor, and the copy leaves the phone only once
     * it was sent; deferred (metered network, the per-sync limit) it stays.
     */
    @Test
    fun aMergedAwayCopysNewPhotoGoesToTheSurvivorBeforeTheCopyLeaves() {
        // Changed on the phone since the last sync; the survivor still has the
        // photo the copy last saw (the merge carries it over), or never had one.
        assertEquals(ContactPlan.SurvivorPhoto.Upload, ContactPlan.survivorPhoto("f12", "f7", "e-old", "e-old"))
        assertEquals(ContactPlan.SurvivorPhoto.Upload, ContactPlan.survivorPhoto("f12", "f7", "", ""))
        // Removed in UniHub since: a change there, so UniHub's (no photo) stays and the copy goes.
        assertEquals(ContactPlan.SurvivorPhoto.UniHubKeeps, ContactPlan.survivorPhoto("f12", "f7", "e-old", ""))
        // A state from the 3+3 sync (no photo state): every picture is new.
        assertEquals(ContactPlan.SurvivorPhoto.Upload, ContactPlan.survivorPhoto("t0a1b", "", "", ""))
        assertEquals(ContactPlan.SurvivorPhoto.Upload, ContactPlan.survivorPhoto("f12", null, null, ""))
        // UniHub gave the survivor another photo meanwhile: a photo changed on both sides keeps UniHub's.
        assertEquals(ContactPlan.SurvivorPhoto.UniHubKeeps, ContactPlan.survivorPhoto("f12", "f7", "e-old", "e-other"))
        // Unchanged, or removed on the phone (which would take the survivor's photo): nothing to send.
        assertEquals(ContactPlan.SurvivorPhoto.None, ContactPlan.survivorPhoto("f7", "f7", "e-old", "e-old"))
        assertEquals(ContactPlan.SurvivorPhoto.None, ContactPlan.survivorPhoto("", "f7", "e-old", "e-old"))

        assertFalse("never removed with its picture unsent", ContactPlan.copyMayGo(ContactPlan.SurvivorPhoto.Upload, sent = false))
        assertTrue(ContactPlan.copyMayGo(ContactPlan.SurvivorPhoto.Upload, sent = true))
        assertTrue(ContactPlan.copyMayGo(ContactPlan.SurvivorPhoto.None, sent = false))
        assertTrue(ContactPlan.copyMayGo(ContactPlan.SurvivorPhoto.UniHubKeeps, sent = false))

        // The budget the copy and the photo pass share: none on a metered network, at most the limit.
        assertFalse(ContactPlan.PhotoBudget(metered = true, 200).take())
        val budget = ContactPlan.PhotoBudget(metered = false, 2)
        assertEquals(listOf(true, true, false), List(3) { budget.take() })

        // A copy kept for its photo is planned the same way at the next sync: still changed on the phone.
        val again = ContactPlan.plan(listOf(row(1, "m-1", changed = true)), listed = setOf("s-1"), merged = mapOf("m-1" to "s-1"))
        assertEquals(listOf(1L to "s-1"), again.intoSurvivor.map { it.first.id to it.second })
    }

    /**
     * A copy kept for its unsent photo: the card changes it delivered are
     * checkpointed, so the next sync sends only the picture and keeps what
     * UniHub changed on the survivor meanwhile (a title, a number).
     */
    @Test
    fun aCopyKeptForItsPhotoDoesNotReplayItsDeliveredChanges() {
        val copyInUniHub = ContactCard(given = "Ada", family = "Example", title = "Engineer", phones = listOf(Value("+15550100", id = "v-1")))
        val bases = ContactState(copyInUniHub.forPhone(), "f7") to ContactState(copyInUniHub, "e-old", 3)
        val survivor = copyInUniHub.copy(emails = listOf(Value("ada@example.com", id = "v-2")))
        // On the phone: a new title, a second number and a new photo.
        val phone = bases.first.card.copy(title = "Director", phones = bases.first.card.phones + Value("+15550101", "work"))

        // Sync 1, metered: the card reaches the survivor, the photo waits.
        val first = ContactPlan.survivorStep(phone, "f12", bases, survivor, "e-old")
        val saved = first.survivor!!
        assertEquals("Director", saved.title)
        assertEquals(listOf("+15550100", "+15550101"), saved.phones.map { it.value })
        assertEquals(ContactPlan.SurvivorPhoto.Upload, first.photo)
        assertFalse(ContactPlan.copyMayGo(first.photo, sent = ContactPlan.PhotoBudget(metered = true, 200).take()))

        // In UniHub meanwhile: another title, the phone's number removed, another added.
        val edited = saved.copy(title = "CTO", phones = listOf(Value("+15550100", id = "v-1"), Value("+15550102", id = "v-3")))

        // Sync 2 from the checkpoint: nothing to write; only the photo is sent.
        val second = ContactPlan.survivorStep(phone, "f12", first.checkpoint, edited, "e-old")
        assertEquals(null, second.survivor)
        assertEquals(ContactPlan.SurvivorPhoto.Upload, second.photo)
        // Without the checkpoint the old title and number would come back.
        val replayed = ContactPlan.survivorStep(phone, "f12", bases, edited, "e-old").survivor!!
        assertEquals("Director", replayed.title)
        assertTrue(replayed.phones.any { it.value == "+15550101" })

        // Still a change on the phone (its photo), so it is retried, not taken as a copy.
        assertTrue(first.checkpoint.first.photo != "f12")
        // The photo was removed in UniHub before it could be sent: UniHub's stays and the copy goes.
        val removed = ContactPlan.survivorStep(phone, "f12", first.checkpoint, edited, "")
        assertEquals(ContactPlan.SurvivorPhoto.UniHubKeeps, removed.photo)
        assertTrue(ContactPlan.copyMayGo(removed.photo, sent = false))
    }

    /** UniHub and the copy's sync columns as intoSurvivor leaves them; [photoFails] makes the upload time out. */
    private class Sides(var survivor: ContactCard, var states: Pair<ContactState, ContactState>, var photoFails: Boolean) : ContactPlan.SurvivorSides {
        var saves = 0
        var photos = 0
        override fun save(card: ContactCard): Boolean { survivor = card; saves++; return true }
        override fun checkpoint(states: Pair<ContactState, ContactState>): Boolean { this.states = states; return true }
        override fun sendPhoto(): Boolean {
            if (photoFails) throw java.io.IOException("timeout")
            photos++
            return true
        }
        fun sync(phone: ContactCard, photo: String, survivorPhoto: String, budget: ContactPlan.PhotoBudget) =
            ContactPlan.intoSurvivor(ContactPlan.survivorStep(phone, photo, states, survivor, survivorPhoto), this, budget)
    }

    /**
     * The checkpoint is stored right after the card, before the picture: an
     * upload that times out (the sync fails) does not lose it, so the retry
     * after UniHub's newer edits sends only the picture.
     */
    @Test
    fun aPhotoUploadThatFailsAfterTheCardWasSavedDoesNotReplayTheCard() {
        val copyInUniHub = ContactCard(given = "Ada", family = "Example", title = "Engineer", phones = listOf(Value("+15550100", id = "v-1")))
        val sides = Sides(copyInUniHub, ContactState(copyInUniHub.forPhone(), "f7") to ContactState(copyInUniHub, "e-old", 3), photoFails = true)
        val phone = sides.states.first.card.copy(title = "Director", phones = sides.states.first.card.phones + Value("+15550101", "work"))

        // Sync 1: the card is saved, then the upload times out and the sync fails.
        assertThrows(java.io.IOException::class.java) { sides.sync(phone, "f12", "e-old", ContactPlan.PhotoBudget(metered = false, 200)) }
        assertEquals("Director", sides.survivor.title)
        assertTrue("the delivered card is recorded", ContactPhone.same(phone, sides.states.first.card))
        assertEquals("f7", sides.states.first.photo)

        // In UniHub meanwhile: another title, the phone's number removed.
        sides.survivor = sides.survivor.copy(title = "CTO", phones = listOf(Value("+15550100", id = "v-1")))
        val edited = sides.survivor

        // Sync 2, metered: nothing written, the copy kept for its picture.
        assertEquals(ContactPlan.SurvivorOutcome.Kept, sides.sync(phone, "f12", "e-old", ContactPlan.PhotoBudget(metered = true, 200)))
        // Sync 3: the picture goes, the copy too; UniHub's edits stay.
        sides.photoFails = false
        assertEquals(ContactPlan.SurvivorOutcome.CopyGoes, sides.sync(phone, "f12", "e-old", ContactPlan.PhotoBudget(metered = false, 200)))
        assertEquals(1, sides.saves)
        assertEquals(1, sides.photos)
        assertSame(edited, sides.survivor)
    }

    @Test
    fun aRefusedCardSaveOrAnEditOnThePhoneStopsBeforeThePicture() {
        val card = ContactCard(given = "Ada", title = "Engineer")
        val bases = ContactState(card.forPhone(), "f7") to ContactState(card, "e-old", 3)
        val step = ContactPlan.survivorStep(card.forPhone().copy(title = "Director"), "f12", bases, card, "e-old")
        val calls = mutableListOf<String>()
        fun sides(saves: Boolean, unchanged: Boolean) = object : ContactPlan.SurvivorSides {
            override fun save(card: ContactCard) = saves.also { calls += "save" }
            override fun checkpoint(states: Pair<ContactState, ContactState>) = unchanged.also { calls += "checkpoint" }
            override fun sendPhoto() = true.also { calls += "photo" }
        }
        assertEquals(ContactPlan.SurvivorOutcome.Refused, ContactPlan.intoSurvivor(step, sides(saves = false, unchanged = true), ContactPlan.PhotoBudget(false, 200)))
        assertEquals(listOf("save"), calls)
        calls.clear()
        assertEquals(ContactPlan.SurvivorOutcome.ChangedOnPhone, ContactPlan.intoSurvivor(step, sides(saves = true, unchanged = false), ContactPlan.PhotoBudget(false, 200)))
        assertEquals(listOf("save", "checkpoint"), calls)
    }
}
