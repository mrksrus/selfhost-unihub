package io.github.mrksrus.unihub

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.OperationApplicationException
import android.content.SyncResult
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.RawContacts
import android.util.Log
import io.github.mrksrus.unihub.AppSession.Current
import io.github.mrksrus.unihub.AppSession.Stale
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest

/**
 * Keeps the signed-in user's UniHub contacts in the phone's own contacts, so
 * the Phone app, WhatsApp and others can show their names.
 *
 * The contacts belong to an Android account of this app ("UniHub", named after
 * the server), kept by a sync adapter (ContactsSyncService). It syncs both
 * ways: a contact added, changed or deleted on the phone in that account
 * (also one Android moved there from the phone's own contacts) is added,
 * changed or deleted in UniHub, and UniHub's changes come to the phone. It
 * uses the session of the app's WebView and the contacts API pages use, so no
 * server change is needed and it signs in and out with the app. Removing the
 * account (Android settings, changing server, uninstalling) removes its
 * contacts from the phone.
 */
object ContactsSync {
    const val ACCOUNT_TYPE = "io.github.mrksrus.unihub"
    private const val AUTHORITY = ContactsContract.AUTHORITY
    private const val TAG = "UniHubContacts"
    private const val KEY_ORIGIN = "origin"
    private const val KEY_USER = "user"
    private const val PREFS = "contacts"
    private const val KEY_OFFERED = "offered"
    private const val PERIOD_SECONDS = 6 * 60 * 60L
    private const val PAGE = 2000
    // Bounds one sync; the server lists at most 2000 per page.
    private const val MAX_CONTACTS = 100_000
    // Values longer than this are cut; the server keeps 255 characters.
    private const val MAX_VALUE = 1000
    // Operations per transaction; a contact's rows always share one.
    private const val BATCH = 300
    // Marks a phone contact this version linked (SYNC1); 0.22.0 kept a hash there.
    private const val FORMAT = "2"
    // Deletions on the phone from this many on (and a quarter of all) wait for the person's answer.
    private const val MANY_DELETIONS = 10

    val PERMISSIONS = arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)

    fun hasPermission(context: Context) =
        PERMISSIONS.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    fun account(context: Context): Account? =
        AccountManager.get(context).getAccountsByType(ACCOUNT_TYPE).firstOrNull()

    /** The server whose contacts the account holds. */
    fun origin(context: Context, account: Account): String? =
        AccountManager.get(context).getUserData(account, KEY_ORIGIN)

    // ── Turning it on and off ──────────────────────────────────────────

    /** Whether the app already asked about contacts for this server (asked once per server). */
    fun offered(context: Context, origin: String) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY_OFFERED, emptySet())!!.contains(origin)

    fun markOffered(context: Context, origin: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val origins = prefs.getStringSet(KEY_OFFERED, emptySet())!!.toMutableSet().apply { add(origin) }
        prefs.edit().putStringSet(KEY_OFFERED, origins).apply()
    }

    /** Adds the account for this server and starts the first sync. Needs the contacts permission. */
    fun turnOn(context: Context, origin: String): Account {
        val manager = AccountManager.get(context)
        account(context)?.let { existing ->
            if (manager.getUserData(existing, KEY_ORIGIN) == origin) {
                requestSync(context, existing)
                return existing
            }
            manager.removeAccountExplicitly(existing)
        }
        val account = Account(ServerAddress.host(origin), ACCOUNT_TYPE)
        manager.addAccountExplicitly(account, null, Bundle().apply { putString(KEY_ORIGIN, origin) })
        ContentResolver.setIsSyncable(account, AUTHORITY, 1)
        ContentResolver.setSyncAutomatically(account, AUTHORITY, true)
        ContentResolver.addPeriodicSync(account, AUTHORITY, Bundle.EMPTY, PERIOD_SECONDS)
        requestSync(context, account)
        return account
    }

    /** Removes the account; Android deletes its contacts from the phone with it. */
    fun turnOff(context: Context) {
        account(context)?.let { AccountManager.get(context).removeAccountExplicitly(it) }
    }

    /**
     * Brings the phone up to date soon, unless the person turned syncing off
     * for this account in Android's settings.
     */
    fun requestSync(context: Context, account: Account? = account(context)) {
        if (account == null || !ContentResolver.getSyncAutomatically(account, AUTHORITY)) return
        ContentResolver.requestSync(account, AUTHORITY, Bundle().apply {
            putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
            putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
        })
    }

    enum class Offer { SignedOut, Unavailable, Empty, Ready }

    /** Whether the app's session can read contacts on this server. Blocks; call off the main thread. */
    fun check(context: Context, origin: String): Offer {
        val session = cookie(origin) ?: return Offer.SignedOut
        val current = Current { sessionOf(cookie(origin)) == sessionOf(session) }
        return try {
            val me = get(context, origin, "/api/auth/me?background=1", session, current)
            if (me.status == 401) return Offer.SignedOut
            if (me.status != 200) return Offer.Unavailable
            val page = get(context, origin, "/api/contacts?limit=1", session, current)
            when {
                page.status == 401 -> Offer.SignedOut
                page.status != 200 -> Offer.Unavailable
                (JSONObject(page.body).optJSONArray("contacts")?.length() ?: 0) > 0 -> Offer.Ready
                else -> Offer.Empty
            }
        } catch (_: Exception) {
            Offer.Unavailable
        }
    }

    // ── One sync ───────────────────────────────────────────────────────

    /**
     * Brings the phone's UniHub contacts and the server together, both ways
     * (ContactMerge has the rules). A failed or partial listing changes
     * nothing. Signing out, a session that ended, a disabled Contacts module
     * or another server takes the server's contacts off the phone, but keeps
     * what the phone has not sent yet.
     */
    fun sync(context: Context, account: Account, extras: Bundle, provider: ContentProviderClient, result: SyncResult) {
        val manager = AccountManager.get(context)
        val origin = manager.getUserData(account, KEY_ORIGIN)
        if (origin == null || origin != ServerAddress.saved(context)) {
            clear(manager, account, provider, result, "the app is on another server")
            return
        }
        renewSession(context)
        val session = cookie(origin)
        if (session == null) {
            clear(manager, account, provider, result, "signed out")
            return
        }
        // An answer counts only while this is still the app's server, session
        // and account, and Android has not cancelled the sync. It is checked
        // again before every write, since signing out or another sign-in can
        // happen while a request is under way.
        val current = Current {
            !Thread.currentThread().isInterrupted &&
                account in manager.getAccountsByType(ACCOUNT_TYPE) &&
                ServerAddress.saved(context) == origin &&
                sessionOf(cookie(origin)) == sessionOf(session)
        }
        try {
            val me = get(context, origin, "/api/auth/me?background=1", session, current)
            if (me.status == 401) {
                current.check()
                clear(manager, account, provider, result, "the session ended")
                return
            }
            me.expectOk()
            val user = JSONObject(me.body).getJSONObject("user").getString("id")
            current.check()
            // Another person's contacts go before this one's are loaded, so a
            // failed listing cannot leave them on the phone.
            val previous = manager.getUserData(account, KEY_USER)
            if (previous != user) {
                if (previous != null) clear(manager, account, provider, result, "another user signed in")
                manager.setUserData(account, KEY_USER, user)
            }
            when (val listing = fetch(context, origin, session, current)) {
                is Listing.Gone -> {
                    current.check()
                    clear(manager, account, provider, result, listing.why)
                }
                is Listing.Complete -> {
                    current.check()
                    makeVisible(account, provider)
                    val sent = Reconcile(Server(context, origin, session, current), user, account, provider, result, extras).run(listing.contacts)
                    Log.i(TAG, "Synced ${listing.contacts.size} contacts: ${result.stats.numInserts} added, ${result.stats.numUpdates} changed, ${result.stats.numDeletes} removed on the phone; $sent")
                }
            }
        } catch (_: Stale) {
            Log.i(TAG, "Sync stopped: the session, server or account changed")
        } catch (error: IOException) {
            Log.w(TAG, "Sync postponed: ${error.javaClass.simpleName}")
            result.stats.numIoExceptions++
        } catch (_: org.json.JSONException) {
            Log.w(TAG, "Sync postponed: unexpected answer")
            result.stats.numParseExceptions++
        }
    }

    /**
     * Takes the server's contacts off the phone. A contact the phone has not
     * sent yet (new, or changed since the last sync) stays, marked as the
     * previous user's, and goes to UniHub when that user signs in again.
     */
    private fun clear(manager: AccountManager, account: Account, provider: ContentProviderClient, result: SyncResult, why: String) {
        val previous = manager.getUserData(account, KEY_USER)
        val ops = Batch(provider, current = null)
        var kept = 0
        for (row in readRows(account, provider)) {
            when {
                row.owner != null && row.owner != previous -> kept++
                row.deleted || (row.source != null && !row.changedOnPhone()) -> {
                    ops += deleteRow(account, row.id)
                    result.stats.numDeletes++
                }
                else -> {
                    kept++
                    if (row.owner == null && previous != null) ops += updateRow(account, row.id) { put(RawContacts.SYNC4, previous) }
                }
            }
            ops.flushIfFull()
        }
        ops.flush()
        manager.setUserData(account, KEY_USER, null)
        Log.i(TAG, "Removed UniHub's contacts from the phone: $why" + if (kept > 0) " ($kept not yet sent stay)" else "")
    }

    private sealed interface Listing {
        class Complete(val contacts: List<ServerContact>) : Listing
        class Gone(val why: String) : Listing
    }

    // Complete or an exception: a page without has_more, or an empty page
    // that claims more, is not a listing to delete by.
    private fun fetch(context: Context, origin: String, session: String, current: Current): Listing {
        val contacts = LinkedHashMap<String, ServerContact>()
        var offset = 0
        while (true) {
            val page = get(context, origin, "/api/contacts?limit=$PAGE&offset=$offset", session, current)
            if (page.status == 401) return Listing.Gone("the session ended")
            if (page.status == 403 && page.json()?.optString("code") == "MODULE_DISABLED") return Listing.Gone("the Contacts module is off")
            page.expectOk()
            val json = JSONObject(page.body)
            val rows = json.getJSONArray("contacts")
            val more = json.get("has_more") as? Boolean ?: throw org.json.JSONException("has_more is not a boolean")
            for (index in 0 until rows.length()) {
                ServerContact.from(rows.getJSONObject(index))?.let { contacts[it.id] = it }
            }
            if (!more) break
            if (rows.length() == 0) throw org.json.JSONException("An empty page with more to come")
            offset += rows.length()
            if (offset >= MAX_CONTACTS) throw IOException("More than $MAX_CONTACTS contacts")
        }
        return Listing.Complete(contacts.values.toList())
    }

    /** A contact on the server: its whole answer, to send back what the phone does not change (notes), and the shared part. */
    private class ServerContact(val id: String, val json: JSONObject, val card: ContactCard) {
        companion object {
            private fun JSONObject.text(name: String): String =
                if (isNull(name)) "" else optString(name).trim().take(MAX_VALUE)

            fun from(json: JSONObject): ServerContact? {
                val id = json.text("id").takeIf { it.isNotEmpty() } ?: return null
                return ServerContact(id, json, ContactCard(
                    json.text("first_name"),
                    json.text("last_name"),
                    listOf("phone", "phone2", "phone3").map { json.text(it) }.filter { it.isNotEmpty() }.distinct(),
                    listOf("email", "email2", "email3").map { json.text(it) }.filter { it.isNotEmpty() }.distinct(),
                    json.text("company"),
                    json.text("job_title"),
                ))
            }
        }
    }

    // ── Writing to the server ──────────────────────────────────────────
    // The existing contacts API (api/src/routes/contacts.ts), so the app
    // works with servers from 0.22.0 on. PUT replaces the whole contact; it
    // gets the server's own notes back unchanged.

    private class Server(val context: Context, val origin: String, val session: String, val current: Current) {
        /** The contact as the server saved it, or null when the server refused this one (it is tried again next sync). */
        fun save(existing: ServerContact?, card: ContactCard): ServerContact? {
            val body = JSONObject()
                .put("first_name", card.first)
                .put("last_name", card.last.ifEmpty { null })
                .put("company", card.company.ifEmpty { null })
                .put("job_title", card.title.ifEmpty { null })
                .put("notes", existing?.json?.opt("notes").takeUnless { it == JSONObject.NULL })
            listOf("phone", "phone2", "phone3").forEachIndexed { index, field -> body.put(field, card.phones.getOrNull(index)) }
            listOf("email", "email2", "email3").forEachIndexed { index, field -> body.put(field, card.emails.getOrNull(index)) }
            val response = if (existing == null) send("POST", "/api/contacts", body)
            else send("PUT", "/api/contacts/" + Uri.encode(existing.id), body)
            if (response == null) return null
            // A contact deleted meanwhile answers without one; the next listing tells.
            return response.json()?.optJSONObject("contact")?.let { ServerContact.from(it) }
        }

        /** Whether the server deleted it (or never had it). */
        fun delete(id: String): Boolean = send("DELETE", "/api/contacts/" + Uri.encode(id), null) != null

        // A refused request (4xx) skips this contact; anything else postpones the sync.
        private fun send(method: String, path: String, body: JSONObject?): AppSession.Response? {
            current.check()
            val response = AppSession.request(context, origin, method, path, session, current, body)
            return when (response.status) {
                200, 404 -> response.takeIf { it.status == 200 || method == "DELETE" }
                401 -> throw IOException("HTTP 401")
                in 400..499 -> {
                    val code = response.json()?.optString("code")
                    if (code == "MODULE_DISABLED" || code == "RESTORE_IN_PROGRESS") throw IOException(code)
                    Log.w(TAG, "UniHub refused a contact change: HTTP ${response.status}")
                    null
                }
                else -> throw IOException("HTTP ${response.status}")
            }
        }
    }

    // ── Both sides together ────────────────────────────────────────────

    private class Reconcile(
        val server: Server,
        val user: String,
        val account: Account,
        val provider: ContentProviderClient,
        val result: SyncResult,
        val extras: Bundle,
    ) {
        private val batch = Batch(provider, server.current)
        private val remote = LinkedHashMap<String, ServerContact>()
        // Server contacts that have a contact on the phone.
        private val covered = HashSet<String>()
        // Who is who in UniHub (ContactCard.identity), to join a new phone contact to.
        private val identities = HashMap<String, String>()
        private var created = 0
        private var updated = 0
        private var deleted = 0

        fun run(contacts: List<ServerContact>): String {
            contacts.forEach { remote[it.id] = it }
            // Another user's contacts that were not sent yet stay untouched.
            val rows = readRows(account, provider).filter { it.owner == null || it.owner == user }
            val unlinked = ArrayList<Row>()

            // Deleted on the phone: deleted in UniHub too, unless UniHub
            // changed the contact since (then it comes back) or another
            // contact on the phone still stands for it.
            val live = rows.filter { !it.deleted && it.source != null }.groupingBy { it.source!! }.eachCount()
            val deletions = ArrayList<Pair<Row, ServerContact>>()
            for (row in rows.filter { it.deleted }) {
                val contact = row.source?.let { remote[it] }
                when {
                    contact == null || (live[contact.id] ?: 0) > 0 -> batch += deleteRow(account, row.id)
                    row.serverBase(contact)?.sameAs(contact.card) != true -> restore(row, contact)
                    else -> deletions += row to contact
                }
                batch.flushIfFull()
            }
            deleteOnServer(deletions)

            for (row in rows.filter { !it.deleted }) {
                val contact = row.source?.let { remote[it] }
                when {
                    contact != null -> merge(row, contact, link = false)
                    // Deleted in UniHub: gone from the phone too, unless the
                    // phone changed it since; then it goes back as new.
                    row.source != null && !row.changedOnPhone() -> {
                        batch += deleteRow(account, row.id)
                        result.stats.numDeletes++
                    }
                    else -> unlinked += row
                }
                batch.flushIfFull()
            }

            // New on the phone (saved to the UniHub account or moved there
            // from the phone's own contacts): the same person in UniHub is
            // joined, anyone else is added.
            remote.values.forEach(::index)
            for (row in unlinked) {
                val card = row.card()
                val match = card.identity().firstNotNullOfOrNull { identities[it] }?.let { remote[it] }
                when {
                    // Nothing UniHub keeps (only an address, say): it stays the phone's own.
                    card.isEmpty -> if (row.owner == null) batch += updateRow(account, row.id) { put(RawContacts.SYNC4, user) }
                    match != null -> merge(row, match, link = true)
                    else -> create(row, card)
                }
                batch.flushIfFull()
            }

            // New in UniHub.
            for (contact in remote.values) {
                if (contact.id in covered || contact.card.isEmpty) continue
                insertRow(contact)
                batch.flushIfFull()
            }
            batch.flush()
            return "to UniHub $created added, $updated changed, $deleted deleted"
        }

        private fun index(contact: ServerContact) = contact.card.identity().forEach { identities.putIfAbsent(it, contact.id) }

        /** Merges one phone contact with its UniHub contact and writes what changed on each side. */
        private fun merge(row: Row, contact: ServerContact, link: Boolean) {
            covered += contact.id
            val phone = row.card()
            val phoneBase = if (link) ContactCard() else row.phoneBase(contact)
            val serverBase = if (link) ContactCard() else row.serverBase(contact)
            // Without the last sync's state (a copy written by 0.22.0 whose
            // contact changed since, or a damaged record) UniHub's version wins.
            val merged = if (phoneBase == null || serverBase == null) MergedContact(contact.card, contact.card)
            else ContactMerge.merge(phone, phoneBase, contact.card, serverBase)
            val phoneChanges = !merged.phone.sameAs(phone)
            val serverChanges = !merged.server.sameAs(contact.card)
            if (!link && !phoneChanges && !serverChanges && row.owner == user && phoneBase?.sameAs(phone) == true && serverBase?.sameAs(contact.card) == true) return

            // The phone first, and only if nobody edited the contact since it
            // was read; the server after. Should the server's write fail, the
            // next sync finds the same changes again.
            val phoneOps = ArrayList<ContentProviderOperation>()
            if (phoneChanges) {
                phoneOps += assertUnchanged(account, row)
                phoneOps += writeCard(account, row, merged.phone)
            }
            var saved = contact
            if (serverChanges) {
                if (phoneOps.isNotEmpty() && !batch.applyAlone(phoneOps)) return
                phoneOps.clear()
                saved = server.save(contact, merged.server) ?: run { result.stats.numSkippedEntries++; return }
                remote[saved.id] = saved
                index(saved)
                updated++
            }
            val state = updateRow(account, row.id) { link(saved.id, merged.phone, saved.card) }
            if (phoneOps.isEmpty()) batch += state else if (!batch.applyAlone(phoneOps + state)) return
            if (phoneChanges) result.stats.numUpdates++
        }

        /** A contact new on the phone becomes a new UniHub contact. */
        private fun create(row: Row, card: ContactCard) {
            val saved = server.save(null, card.withFirstName().forServer()) ?: run { result.stats.numSkippedEntries++; return }
            remote[saved.id] = saved
            index(saved)
            covered += saved.id
            created++
            batch += updateRow(account, row.id) { link(saved.id, card, saved.card) }
        }

        /** Undoes a deletion on the phone, with UniHub's changes since. */
        private fun restore(row: Row, contact: ServerContact) {
            covered += contact.id
            val merged = row.serverBase(contact)?.let { ContactMerge.merge(row.card(), row.card(), contact.card, it) } ?: MergedContact(contact.card, contact.card)
            val ops = arrayListOf(assertUnchanged(account, row), updateRow(account, row.id) { put(RawContacts.DELETED, 0) })
            ops += writeCard(account, row, merged.phone)
            ops += updateRow(account, row.id) { link(contact.id, merged.phone, contact.card) }
            if (batch.applyAlone(ops)) result.stats.numInserts++
        }

        /**
         * Many deletions at once are not passed on unasked: Android then asks
         * the person to delete them in UniHub or to undo them on the phone
         * (SyncResult.tooManyDeletions).
         */
        private fun deleteOnServer(deletions: List<Pair<Row, ServerContact>>) {
            if (deletions.isEmpty()) return
            if (extras.getBoolean(ContentResolver.SYNC_EXTRAS_DISCARD_LOCAL_DELETIONS)) {
                Log.i(TAG, "Undoing ${deletions.size} deletions on the phone")
                deletions.forEach { (row, contact) -> restore(row, contact) }
                return
            }
            // A joined contact has more than one phone contact; deleting it deletes all.
            val contacts = deletions.map { it.second.id }.distinct()
            if (!extras.getBoolean(ContentResolver.SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS) &&
                contacts.size >= MANY_DELETIONS && contacts.size * 4 >= remote.size
            ) {
                Log.w(TAG, "${contacts.size} contacts deleted on the phone: waiting for confirmation")
                result.tooManyDeletions = true
                result.stats.numDeletes = contacts.size.toLong()
                covered += contacts
                return
            }
            for (id in contacts) {
                if (!server.delete(id)) {
                    covered += id
                    result.stats.numSkippedEntries++
                    continue
                }
                remote.remove(id)
                deleted++
                deletions.filter { it.second.id == id }.forEach { (row, _) -> batch += deleteRow(account, row.id) }
                batch.flushIfFull()
            }
        }

        private fun insertRow(contact: ServerContact) {
            val first = batch.size
            batch += ContentProviderOperation.newInsert(syncUri(RawContacts.CONTENT_URI, account))
                .withValue(RawContacts.ACCOUNT_NAME, account.name)
                .withValue(RawContacts.ACCOUNT_TYPE, account.type)
                .withValues(ContentValues().apply { link(contact.id, contact.card, contact.card) })
                .build()
            for (values in dataRows(contact.card)) {
                batch += ContentProviderOperation.newInsert(syncUri(ContactsContract.Data.CONTENT_URI, account))
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, first)
                    .withValues(values).build()
            }
            result.stats.numInserts++
        }

        // A phone contact's link to its UniHub contact and the state both sides had after this sync.
        private fun ContentValues.link(id: String, phone: ContactCard, server: ContactCard) {
            put(RawContacts.SOURCE_ID, id)
            put(RawContacts.SYNC1, FORMAT)
            put(RawContacts.SYNC2, encode(phone))
            put(RawContacts.SYNC3, encode(server))
            put(RawContacts.SYNC4, user)
            put(RawContacts.DIRTY, 0)
        }
    }

    // ── The phone's side ───────────────────────────────────────────────
    // A phone contact (raw contact) of the UniHub account keeps its UniHub
    // contact's ID in SOURCE_ID and the state of both sides after the last
    // sync in SYNC2 (phone) and SYNC3 (server), so a sync can tell who
    // changed what. SYNC4 is the UniHub user it belongs to. Copies written by
    // 0.22.0 and 0.22.1 have only a hash of the server's contact in SYNC1.

    private fun syncUri(uri: Uri, account: Account): Uri = uri.buildUpon()
        .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(RawContacts.ACCOUNT_NAME, account.name)
        .appendQueryParameter(RawContacts.ACCOUNT_TYPE, account.type)
        .build()

    private class Row(
        val id: Long,
        val source: String?,
        val deleted: Boolean,
        val version: String,
        private val sync1: String?,
        private val phoneState: ContactCard?,
        private val serverState: ContactCard?,
        val owner: String?,
    ) {
        var nameRow: Long? = null
        var first = ""
        var last = ""
        var orgRow: Long? = null
        var company = ""
        var title = ""
        val phones = ArrayList<Pair<Long, String>>()
        val emails = ArrayList<Pair<Long, String>>()

        fun card() = ContactCard(first, last, phones.map { it.second }, emails.map { it.second }, company, title)

        // 0.22.0 and 0.22.1 wrote read-only copies of the server's contact:
        // while that contact has not changed, both sides were the same.
        private val legacy get() = serverState == null && sync1 != null && sync1.length == 64
        private fun legacyBase(contact: ServerContact) = contact.card.takeIf { legacyHash(it) == sync1 }

        fun phoneBase(contact: ServerContact): ContactCard? = if (legacy) legacyBase(contact) else phoneState
        fun serverBase(contact: ServerContact): ContactCard? = if (legacy) legacyBase(contact) else serverState

        /** Whether the phone changed it since the last sync. A 0.22.0 copy was read-only. */
        fun changedOnPhone(): Boolean = !legacy && phoneState?.sameAs(card()) != true
    }

    private fun readRows(account: Account, provider: ContentProviderClient): List<Row> {
        val rows = LinkedHashMap<Long, Row>()
        provider.query(
            syncUri(RawContacts.CONTENT_URI, account),
            arrayOf(RawContacts._ID, RawContacts.SOURCE_ID, RawContacts.DELETED, RawContacts.VERSION, RawContacts.SYNC1, RawContacts.SYNC2, RawContacts.SYNC3, RawContacts.SYNC4),
            "${RawContacts.ACCOUNT_NAME} = ? AND ${RawContacts.ACCOUNT_TYPE} = ?",
            arrayOf(account.name, account.type),
            null,
        )?.use { c ->
            while (c.moveToNext()) {
                rows[c.getLong(0)] = Row(c.getLong(0), c.getString(1), c.getInt(2) != 0, c.getString(3), c.getString(4), decode(c.getString(5)), decode(c.getString(6)), c.getString(7))
            }
        }
        val mimeTypes = listOf(StructuredName.CONTENT_ITEM_TYPE, Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE, Organization.CONTENT_ITEM_TYPE)
        for (ids in rows.keys.chunked(500)) {
            provider.query(
                syncUri(ContactsContract.Data.CONTENT_URI, account),
                arrayOf(ContactsContract.Data._ID, ContactsContract.Data.RAW_CONTACT_ID, ContactsContract.Data.MIMETYPE, "data1", "data2", "data3", "data4"),
                "${ContactsContract.Data.RAW_CONTACT_ID} IN (${ids.joinToString(",")}) AND ${ContactsContract.Data.MIMETYPE} IN (${mimeTypes.joinToString(",") { "?" }})",
                mimeTypes.toTypedArray(),
                ContactsContract.Data._ID,
            )?.use { c ->
                fun text(column: Int) = c.getString(column)?.trim()?.take(MAX_VALUE).orEmpty()
                while (c.moveToNext()) {
                    val row = rows[c.getLong(1)] ?: continue
                    val id = c.getLong(0)
                    when (c.getString(2)) {
                        // GIVEN_NAME is data2, FAMILY_NAME data3.
                        StructuredName.CONTENT_ITEM_TYPE -> if (row.nameRow == null) { row.nameRow = id; row.first = text(4); row.last = text(5) }
                        Phone.CONTENT_ITEM_TYPE -> text(3).takeIf { it.isNotEmpty() }?.let { row.phones += id to it }
                        Email.CONTENT_ITEM_TYPE -> text(3).takeIf { it.isNotEmpty() }?.let { row.emails += id to it }
                        // COMPANY is data1, TITLE data4.
                        Organization.CONTENT_ITEM_TYPE -> if (row.orgRow == null) { row.orgRow = id; row.company = text(3); row.title = text(6) }
                    }
                }
            }
        }
        return rows.values.toList()
    }

    private fun deleteRow(account: Account, id: Long): ContentProviderOperation =
        ContentProviderOperation.newDelete(syncUri(RawContacts.CONTENT_URI, account))
            .withSelection("${RawContacts._ID} = ?", arrayOf(id.toString())).build()

    private fun updateRow(account: Account, id: Long, values: ContentValues.() -> Unit): ContentProviderOperation =
        ContentProviderOperation.newUpdate(syncUri(RawContacts.CONTENT_URI, account))
            .withSelection("${RawContacts._ID} = ?", arrayOf(id.toString()))
            .withValues(ContentValues().apply(values)).build()

    // Fails the batch if the contact changed after it was read (VERSION
    // counts every change), so a sync never writes over a fresh edit.
    private fun assertUnchanged(account: Account, row: Row): ContentProviderOperation =
        ContentProviderOperation.newAssertQuery(syncUri(RawContacts.CONTENT_URI, account))
            .withSelection("${RawContacts._ID} = ?", arrayOf(row.id.toString()))
            .withValue(RawContacts.VERSION, row.version)
            .build()

    /**
     * Turns the phone contact into [card], touching only what differs:
     * labels the person chose, other numbers' order and everything UniHub
     * does not keep stay as they are.
     */
    private fun writeCard(account: Account, row: Row, card: ContactCard): List<ContentProviderOperation> = buildList {
        val data = syncUri(ContactsContract.Data.CONTENT_URI, account)
        fun update(id: Long, values: ContentValues) =
            ContentProviderOperation.newUpdate(data).withSelection("${ContactsContract.Data._ID} = ?", arrayOf(id.toString())).withValues(values).build()
        fun insert(values: ContentValues) =
            ContentProviderOperation.newInsert(data).withValue(ContactsContract.Data.RAW_CONTACT_ID, row.id).withValues(values).build()
        fun delete(id: Long) =
            ContentProviderOperation.newDelete(data).withSelection("${ContactsContract.Data._ID} = ?", arrayOf(id.toString())).build()

        if (card.first != row.first || card.last != row.last) {
            val name = nameValues(card)
            val existing = row.nameRow
            if (existing != null) add(update(existing, name)) else if (card.first.isNotEmpty() || card.last.isNotEmpty()) add(insert(name))
        }
        if (card.company != row.company || card.title != row.title) {
            val organization = organizationValues(card)
            val existing = row.orgRow
            if (existing != null) add(update(existing, organization)) else if (card.company.isNotEmpty() || card.title.isNotEmpty()) add(insert(organization))
        }
        fun entries(have: List<Pair<Long, String>>, want: List<String>, key: (String) -> String, values: (String) -> ContentValues) {
            val wanted = want.map(key).toSet()
            val present = have.map { key(it.second) }.toSet()
            have.filter { key(it.second) !in wanted }.forEach { add(delete(it.first)) }
            want.filter { key(it) !in present }.distinctBy(key).forEach { add(insert(values(it))) }
        }
        entries(row.phones, card.phones, ContactCard::phoneKey, ::phoneValues)
        entries(row.emails, card.emails, ContactCard::emailKey, ::emailValues)
    }

    private fun dataRows(card: ContactCard): List<ContentValues> = buildList {
        if (card.first.isNotEmpty() || card.last.isNotEmpty()) add(nameValues(card))
        card.phones.forEach { add(phoneValues(it)) }
        card.emails.forEach { add(emailValues(it)) }
        if (card.company.isNotEmpty() || card.title.isNotEmpty()) add(organizationValues(card))
    }

    private fun data(mime: String, fill: ContentValues.() -> Unit) =
        ContentValues().apply { put(ContactsContract.Data.MIMETYPE, mime); fill() }

    // Android puts the display name together from the parts.
    private fun nameValues(card: ContactCard) = data(StructuredName.CONTENT_ITEM_TYPE) {
        put(StructuredName.GIVEN_NAME, card.first.ifEmpty { null })
        put(StructuredName.FAMILY_NAME, card.last.ifEmpty { null })
    }

    // UniHub's vCard export calls every number a mobile number.
    private fun phoneValues(number: String) = data(Phone.CONTENT_ITEM_TYPE) { put(Phone.NUMBER, number); put(Phone.TYPE, Phone.TYPE_MOBILE) }
    private fun emailValues(address: String) = data(Email.CONTENT_ITEM_TYPE) { put(Email.ADDRESS, address); put(Email.TYPE, Email.TYPE_OTHER) }
    private fun organizationValues(card: ContactCard) = data(Organization.CONTENT_ITEM_TYPE) {
        put(Organization.COMPANY, card.company.ifEmpty { null })
        put(Organization.TITLE, card.title.ifEmpty { null })
        put(Organization.TYPE, Organization.TYPE_WORK)
    }

    /** Operations applied in transactions of up to BATCH; a contact's rows always share one. */
    private class Batch(val provider: ContentProviderClient, val current: Current?) {
        private val ops = ArrayList<ContentProviderOperation>()
        val size get() = ops.size

        operator fun plusAssign(op: ContentProviderOperation) { ops += op }

        fun flushIfFull() { if (ops.size >= BATCH) flush() }

        fun flush() {
            if (ops.isEmpty()) return
            current?.check()
            provider.applyBatch(ArrayList(ops))
            ops.clear()
        }

        /** One contact's changes on their own; false if the contact changed meanwhile (the next sync sees the edit). */
        fun applyAlone(contactOps: List<ContentProviderOperation>): Boolean {
            flush()
            current?.check()
            return try {
                provider.applyBatch(ArrayList(contactOps))
                true
            } catch (_: OperationApplicationException) {
                Log.i(TAG, "A contact changed on the phone during the sync; it follows next time")
                false
            }
        }
    }

    private fun encode(card: ContactCard): String =
        JSONArray(listOf(card.first, card.last, JSONArray(card.phones), JSONArray(card.emails), card.company, card.title)).toString()

    private fun decode(text: String?): ContactCard? {
        if (text == null) return null
        return try {
            val array = JSONArray(text)
            fun list(index: Int) = array.getJSONArray(index).let { list -> List(list.length()) { list.getString(it) } }
            ContactCard(array.getString(0), array.getString(1), list(2), list(3), array.getString(4), array.getString(5))
        } catch (_: org.json.JSONException) {
            null
        }
    }

    // The hash 0.22.0 and 0.22.1 kept in SYNC1 (format "1").
    private fun legacyHash(card: ContactCard): String = MessageDigest.getInstance("SHA-256")
        .digest(JSONArray(listOf("1", card.first, card.last, JSONArray(card.phones), JSONArray(card.emails), card.company, card.title)).toString().toByteArray())
        .joinToString("") { "%02x".format(it) }

    // Contacts apps list an account's contacts without groups only when the
    // account says so. Set once; a person may hide the account later.
    private fun makeVisible(account: Account, provider: ContentProviderClient) {
        val uri = syncUri(ContactsContract.Settings.CONTENT_URI, account)
        val known = provider.query(
            uri,
            arrayOf(ContactsContract.Settings.UNGROUPED_VISIBLE),
            "${ContactsContract.Settings.ACCOUNT_NAME} = ? AND ${ContactsContract.Settings.ACCOUNT_TYPE} = ?",
            arrayOf(account.name, account.type),
            null,
        )?.use { it.moveToFirst() } ?: false
        if (known) return
        provider.insert(uri, ContentValues().apply {
            put(ContactsContract.Settings.ACCOUNT_NAME, account.name)
            put(ContactsContract.Settings.ACCOUNT_TYPE, account.type)
            put(ContactsContract.Settings.UNGROUPED_VISIBLE, 1)
            put(ContactsContract.Settings.SHOULD_SYNC, 1)
        })
    }

    // ── The server (AppSession: the WebView's session) ─────────────────

    private fun cookie(origin: String) = AppSession.cookie(origin)
    private fun sessionOf(cookies: String?) = AppSession.sessionOf(cookies)

    /** MainActivity: the WebView shows this address now (null: the WebView is gone). */
    fun pageShown(context: Context, url: String?) = AppSession.pageShown(context, url)

    /** Writes a kept session renewal if that is safe now. */
    fun renewSession(context: Context) = AppSession.renewSession(context)

    private fun get(context: Context, origin: String, path: String, session: String, current: Current) =
        AppSession.get(context, origin, path, session, current)
}
