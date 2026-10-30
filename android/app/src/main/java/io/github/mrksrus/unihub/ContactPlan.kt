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
}
