package io.github.mrksrus.unihub

/**
 * What one sync with the full model does with each phone contact, before
 * anything is written (ContactsSync.FullReconcile carries it out). Plain
 * Kotlin, so the rules for deletions and merges have JVM tests.
 */
object ContactPlan {
    /** A phone contact as the plan sees it. [changedInUniHub] only matters for one deleted on the phone. */
    data class Row(val id: Long, val source: String?, val deleted: Boolean, val changedOnPhone: Boolean, val changedInUniHub: Boolean = false)

    class Plan(
        /** Phone contacts to remove from the phone: gone or merged away in UniHub, or deletions already done. Never sent to UniHub. */
        val removeFromPhone: List<Row>,
        /** Deleted on the phone, but UniHub changed the contact since: it comes back. */
        val restore: List<Row>,
        /** Deleted on the phone and undone by the person's answer to "too many deletions": they come back. */
        val undone: List<Row>,
        /** Deleted on the phone: deleted in UniHub too, by contact. */
        val deleteInUniHub: Map<String, List<Row>>,
        /** Many deletions on the phone at once: nothing is deleted until the person answers. */
        val tooManyDeletions: Boolean,
        /** Contacts whose deletion waits for that answer. */
        val waiting: Set<String>,
        /** Linked to a contact in the listing. */
        val merge: List<Row>,
        /** Merged away in UniHub after the phone changed them: the change goes to the survivor (the value), then the row goes. */
        val intoSurvivor: List<Pair<Row, String>>,
        /** New on the phone, or deleted in UniHub after the phone changed them: joined or added. */
        val unlinked: List<Row>,
    )

    /**
     * [listed]: the contact IDs of a complete listing. [merged]: merged-away
     * IDs with their survivor (GET /api/contacts?include=merged). A deletion
     * coming from UniHub, a merge included, is applied on the phone and never
     * counts towards "too many deletions", which only holds deletions made
     * on the phone ([many] of them, and a quarter of all).
     */
    fun plan(
        rows: List<Row>,
        listed: Set<String>,
        merged: Map<String, String>,
        discardPhoneDeletions: Boolean = false,
        overrideTooMany: Boolean = false,
        many: Int = 10,
    ): Plan {
        val removeFromPhone = ArrayList<Row>()
        val restore = ArrayList<Row>()
        val candidates = ArrayList<Row>()
        val live = rows.filter { !it.deleted && it.source != null }.groupingBy { it.source!! }.eachCount()
        for (row in rows.filter { it.deleted }) {
            val source = row.source
            when {
                source == null || source !in listed || (live[source] ?: 0) > 0 -> removeFromPhone += row
                row.changedInUniHub -> restore += row
                else -> candidates += row
            }
        }
        var undone: List<Row> = emptyList()
        var deleteInUniHub: Map<String, List<Row>> = emptyMap()
        var tooMany = false
        var waiting: Set<String> = emptySet()
        if (candidates.isNotEmpty()) {
            val byContact = candidates.groupBy { it.source!! }
            when {
                discardPhoneDeletions -> undone = candidates
                !overrideTooMany && byContact.size >= many && byContact.size * 4 >= listed.size -> {
                    tooMany = true
                    waiting = byContact.keys
                }
                else -> deleteInUniHub = byContact
            }
        }

        val merge = ArrayList<Row>()
        val intoSurvivor = ArrayList<Pair<Row, String>>()
        val unlinked = ArrayList<Row>()
        for (row in rows.filter { !it.deleted }) {
            val source = row.source
            val survivor = source?.let { merged[it] }?.takeIf { it in listed }
            when {
                source != null && source in listed -> merge += row
                survivor != null && row.changedOnPhone -> intoSurvivor += row to survivor
                // Deleted or merged away in UniHub: gone from the phone too,
                // unless the phone changed it since; then it is added again.
                source != null && (survivor != null || !row.changedOnPhone) -> removeFromPhone += row
                else -> unlinked += row
            }
        }
        return Plan(removeFromPhone, restore, undone, deleteInUniHub, tooMany, waiting, merge, intoSurvivor, unlinked)
    }

    /** What happens to the photo of a merged-away phone contact the phone changed (intoSurvivor). */
    enum class SurvivorPhoto {
        /** The phone's picture did not change since the last sync: nothing to send. */
        None,
        /** The phone's new picture goes to the survivor; the copy may leave only after it was sent. */
        Upload,
        /** UniHub gave the survivor another photo meanwhile: UniHub's stays (a photo changed on both sides). */
        UniHubKeeps,
    }

    /**
     * [phonePhoto]: the copy's photo identity now ('' none); [phoneBase] and
     * [serverBase]: its photo and its UniHub contact's etag at the last sync
     * (null without a state); [survivorPhoto]: the survivor's etag now.
     * UniHub changed the photo when the survivor's is not the one the copy
     * last saw: another photo, or none because it was removed in UniHub;
     * then UniHub's stays. Without a state, only an empty survivor takes the
     * picture. Removing a picture on the phone is not passed on: it would
     * take the survivor's photo, which may be another contact's.
     */
    fun survivorPhoto(phonePhoto: String, phoneBase: String?, serverBase: String?, survivorPhoto: String): SurvivorPhoto = when {
        phonePhoto.isEmpty() || phonePhoto == phoneBase -> SurvivorPhoto.None
        survivorPhoto == serverBase -> SurvivorPhoto.Upload
        serverBase == null && survivorPhoto.isEmpty() -> SurvivorPhoto.Upload
        else -> SurvivorPhoto.UniHubKeeps
    }

    /**
     * One sync's step for a merged-away copy the phone changed (intoSurvivor):
     * [survivor] is what UniHub should now hold (null: nothing to write),
     * [photo] what happens to the copy's picture, and [checkpoint] the copy's
     * states once [survivor] is saved: the phone's card counts as delivered,
     * its photo still as the last sync's. Stored as soon as the card is
     * saved, so a copy kept for its unsent picture sends only the picture
     * next time and never replays card changes over newer edits of the survivor.
     */
    class SurvivorStep(val survivor: ContactCard?, val photo: SurvivorPhoto, val checkpoint: Pair<ContactState, ContactState>)

    fun survivorStep(phone: ContactCard, phonePhoto: String, bases: Pair<ContactState, ContactState>?, survivor: ContactCard, survivorPhoto: String): SurvivorStep {
        val merged = if (bases == null) ContactMerge.merge(phone, ContactCard(), survivor, ContactCard())
        else ContactMerge.merge(phone, bases.first.card, survivor, survivor)
        val write = merged.server.takeUnless { ContactPhone.same(it, survivor) }
        val checkpoint = ContactState(phone, bases?.first?.photo ?: "") to
            ContactState(bases?.second?.card ?: ContactCard(), bases?.second?.photo ?: "", bases?.second?.version)
        return SurvivorStep(write, survivorPhoto(phonePhoto, bases?.first?.photo, bases?.second?.photo, survivorPhoto), checkpoint)
    }

    /**
     * Whether the copy may leave the phone: never while a picture it has to
     * send could not be sent yet (a metered network, the per-sync limit, a
     * failed upload); it stays and the step runs again at the next sync.
     */
    fun copyMayGo(photo: SurvivorPhoto, sent: Boolean): Boolean = photo != SurvivorPhoto.Upload || sent

    /** What intoSurvivor does on each side, in this order (ContactsSync, or a test). */
    interface SurvivorSides {
        /** Saves the survivor's card in UniHub; false if UniHub refused it. */
        fun save(card: ContactCard): Boolean
        /** Records the copy's states on the phone at once; false if the phone changed the copy meanwhile. */
        fun checkpoint(states: Pair<ContactState, ContactState>): Boolean
        /** Sends the copy's picture to the survivor; false if it was not taken. May throw (a timeout). */
        fun sendPhoto(): Boolean
    }

    enum class SurvivorOutcome { Refused, ChangedOnPhone, Kept, CopyGoes }

    /**
     * Runs [step]: the card first, then its checkpoint, stored before the
     * picture so a failed or interrupted upload, or a later failure of the
     * sync, never sends the delivered card again over newer edits in UniHub.
     */
    fun intoSurvivor(step: SurvivorStep, sides: SurvivorSides, budget: PhotoBudget): SurvivorOutcome {
        if (step.survivor != null && !sides.save(step.survivor)) return SurvivorOutcome.Refused
        if (!sides.checkpoint(step.checkpoint)) return SurvivorOutcome.ChangedOnPhone
        val sent = step.photo == SurvivorPhoto.Upload && budget.take() && sides.sendPhoto()
        return if (copyMayGo(step.photo, sent)) SurvivorOutcome.CopyGoes else SurvivorOutcome.Kept
    }

    /** Photo transfers of one sync: at most [limit], none on a metered network. Shared by intoSurvivor and the photo pass. */
    class PhotoBudget(val metered: Boolean, private var left: Int) {
        /** Takes one transfer; false when none may happen now. */
        fun take(): Boolean {
            if (metered || left <= 0) return false
            left--
            return true
        }
    }
}
