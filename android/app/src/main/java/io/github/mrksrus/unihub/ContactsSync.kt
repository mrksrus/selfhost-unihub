package io.github.mrksrus.unihub

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.OperationApplicationException
import android.content.SyncResult
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Im
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.Photo
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.RawContacts
import android.util.Log
import io.github.mrksrus.unihub.AppSession.Current
import io.github.mrksrus.unihub.AppSession.Stale
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException

/**
 * Keeps the signed-in user's UniHub contacts in the phone's own contacts, so
 * the Phone app, WhatsApp and others can show their names.
 *
 * The contacts belong to an Android account of this app ("UniHub", named after
 * the server), kept by a sync adapter (ContactsSyncService). It syncs both
 * ways: a contact added, changed or deleted on the phone in that account
 * (also one Android moved there from the phone's own contacts) is added,
 * changed or deleted in UniHub, and UniHub's changes come to the phone. It
 * uses the session of the app's WebView and the contacts API pages use, so it
 * signs in and out with the app. Removing the account (Android settings,
 * changing server, uninstalling) removes its contacts from the phone.
 *
 * A server that lists `contacts-vcard` in GET /api/version (0.26.0 on) gets
 * the full model (FullReconcile: every kind Android has, labels, photos,
 * version-checked writes, merges). Older servers get the 3+3 fields the apps
 * up to 0.25.1 sync (Reconcile, LegacyCard).
 */
object ContactsSync {
    const val ACCOUNT_TYPE = "io.github.mrksrus.unihub"
    private const val AUTHORITY = ContactsContract.AUTHORITY
    private const val TAG = "UniHubContacts"
    private const val KEY_ORIGIN = "origin"
    // Whose UniHub contacts are on the phone now (none after a sign-out).
    private const val KEY_USER = "user"
    // Who last used the account: contacts saved on the phone without a known
    // user are theirs. Set when contacts are turned on; a sign-out keeps it.
    private const val KEY_LAST_USER = "lastUser"
    // The owner of contacts saved while no user was known (an account signed
    // out before 0.22.3): they stay on the phone and go to no one.
    private const val UNKNOWN_OWNER = "unknown"
    private const val PREFS = "contacts"
    private const val KEY_OFFERED = "offered"
    private const val KEY_CHECKED = "checked:"
    private const val KEY_PRINT_KEY = "printKey"
    private const val PERIOD_SECONDS = 6 * 60 * 60L
    private const val PAGE = 2000
    // Bounds one sync; the server lists at most 2000 per page.
    private const val MAX_CONTACTS = 100_000
    // Values longer than this are cut; the server keeps 255 characters.
    private const val MAX_VALUE = 1000
    // Operations per transaction; a contact's rows always share one.
    private const val BATCH = 300
    // Marks a phone contact the 3+3 sync linked (SYNC1); 0.22.0 kept a hash there.
    private const val FORMAT = "2"
    // Marks one the full model linked (SYNC1): SYNC2 and SYNC3 hold ContactState.
    private const val FORMAT_FULL = "3"
    // GET /api/version lists it on servers with the full contact model.
    private const val FEATURE_VCARD = "contacts-vcard"
    // Photos moved per sync, either way; the rest follow on later syncs.
    private const val MAX_PHOTO_TRANSFERS = 200
    // UniHub's photos are about 120 KB; the phone takes one through a single
    // binder call (1 MB at most). A phone's own picture is sent up to the server's bound.
    private const val MAX_PHOTO_DOWNLOAD = 800 * 1024
    private const val MAX_PHOTO_UPLOAD = 20 * 1024 * 1024
    // Deletions on the phone from this many on (and a quarter of all) wait for the person's answer.
    private const val MANY_DELETIONS = 10
    // How old the listing may be that a change or deletion in UniHub is checked against.
    private const val FRESH_MS = 5_000L

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
        val user = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CHECKED + origin, null)
        manager.addAccountExplicitly(account, null, Bundle().apply {
            putString(KEY_ORIGIN, origin)
            putString(KEY_LAST_USER, user)
        })
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
            // turnOn() records who turned contacts on.
            val user = JSONObject(me.body).getJSONObject("user").getString("id")
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_CHECKED + origin, user).apply()
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
            // Contacts saved on the phone while another user was the last one
            // are theirs, never this user's. An account from 0.22.0 or 0.22.1
            // knows only the user whose contacts it holds, and after a
            // sign-out not even that: then they belong to no one.
            val last = manager.getUserData(account, KEY_LAST_USER) ?: manager.getUserData(account, KEY_USER)
            if (last != user) claimUnowned(account, provider, last ?: UNKNOWN_OWNER)
            manager.setUserData(account, KEY_LAST_USER, user)
            // Another person's contacts go before this one's are loaded, so a
            // failed listing cannot leave them on the phone.
            val previous = manager.getUserData(account, KEY_USER)
            if (previous != user) {
                if (previous != null) clear(manager, account, provider, result, "another user signed in")
                manager.setUserData(account, KEY_USER, user)
            }
            val full = speaksVcard(context, origin, session, current)
            when (val listing = fetch(context, origin, session, current, full)) {
                is Listing.Gone -> {
                    current.check()
                    clear(manager, account, provider, result, listing.why)
                }
                is Listing.Complete -> {
                    current.check()
                    makeVisible(account, provider)
                    val server = Server(context, origin, session, current, printKey(context), full)
                    val sent = if (full) FullReconcile(server, user, account, provider, result, extras).run(listing)
                    else Reconcile(server, user, account, provider, result, extras).run(listing.contacts)
                    Log.i(TAG, "Synced ${listing.contacts.size} contacts (${if (full) "every field" else "3+3 fields"}): ${result.stats.numInserts} added, ${result.stats.numUpdates} changed, ${result.stats.numDeletes} removed on the phone; $sent")
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
     * Takes the server's contacts off the phone: the copies that hold nothing
     * beyond the UniHub contact. A contact the phone has not sent yet (new,
     * or changed since the last sync), or one with something UniHub does not
     * keep (a photo, an address, a fourth number), stays, marked as the
     * previous user's, and syncs again when that user signs in.
     */
    private fun clear(manager: AccountManager, account: Account, provider: ContentProviderClient, result: SyncResult, why: String) {
        val previous = manager.getUserData(account, KEY_USER) ?: manager.getUserData(account, KEY_LAST_USER)
        val ops = Batch(provider, current = null)
        var kept = 0
        for (row in readRows(account, provider)) {
            when {
                row.owner != null && row.owner != previous -> kept++
                row.deleted -> ops += deleteRow(account, row.id)
                row.source != null && row.isCopy() -> {
                    ops.checked(listOf(assertUnchanged(account, row), deleteRow(account, row.id)))
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
        Log.i(TAG, "Removed UniHub's contacts from the phone: $why" + if (kept > 0) " ($kept with the phone's own changes stay)" else "")
    }

    private fun claimUnowned(account: Account, provider: ContentProviderClient, user: String) {
        val ops = Batch(provider, current = null)
        for (row in readRows(account, provider)) if (row.owner == null) {
            ops += updateRow(account, row.id) { put(RawContacts.SYNC4, user) }
            ops.flushIfFull()
        }
        ops.flush()
    }

    // A key of this installation for fingerprints of server contacts (Server
    // print), so a contact's notes cannot be guessed from what the phone keeps.
    private fun printKey(context: Context): ByteArray {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_PRINT_KEY, null)?.let { return android.util.Base64.decode(it, android.util.Base64.NO_WRAP) }
        val key = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        prefs.edit().putString(KEY_PRINT_KEY, android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP)).commit()
        return key
    }

    /**
     * Whether the server keeps the full contact model (`contacts-vcard`). A
     * server without GET /api/version is an old one; any other failure
     * postpones the sync, so a passing error never switches the mode.
     */
    private fun speaksVcard(context: Context, origin: String, session: String, current: Current): Boolean {
        val answer = get(context, origin, "/api/version", session, current)
        if (answer.status == 404) return false
        answer.expectOk()
        val features = JSONObject(answer.body).optJSONArray("features") ?: return false
        return (0 until features.length()).any { features.optString(it) == FEATURE_VCARD }
    }

    private sealed interface Listing {
        /** [merged]: contacts merged away in the last 30 days, with their survivor (full model only). */
        class Complete(val contacts: List<ServerContact>, val merged: Map<String, String> = emptyMap()) : Listing
        class Gone(val why: String) : Listing
    }

    // Complete or an exception: a page without has_more, or an empty page
    // that claims more, is not a listing to delete by.
    private fun fetch(context: Context, origin: String, session: String, current: Current, full: Boolean): Listing {
        val contacts = LinkedHashMap<String, ServerContact>()
        val merged = HashMap<String, String>()
        var offset = 0
        while (true) {
            val page = get(context, origin, "/api/contacts?limit=$PAGE&offset=$offset" + if (full) "&include=merged" else "", session, current)
            if (page.status == 401) return Listing.Gone("the session ended")
            if (page.status == 403 && page.json()?.optString("code") == "MODULE_DISABLED") return Listing.Gone("the Contacts module is off")
            page.expectOk()
            val json = JSONObject(page.body)
            val rows = json.getJSONArray("contacts")
            val more = json.get("has_more") as? Boolean ?: throw org.json.JSONException("has_more is not a boolean")
            for (index in 0 until rows.length()) {
                ServerContact.from(rows.getJSONObject(index))?.let { contacts[it.id] = it }
            }
            if (full) {
                val away = json.optJSONArray("merged") ?: throw org.json.JSONException("No merged contacts listed")
                for (index in 0 until away.length()) away.getJSONObject(index).let { merged[it.getString("id")] = it.getString("into") }
            }
            if (!more) break
            if (rows.length() == 0) throw org.json.JSONException("An empty page with more to come")
            offset += rows.length()
            if (offset >= MAX_CONTACTS) throw IOException("More than $MAX_CONTACTS contacts")
        }
        return Listing.Complete(contacts.values.toList(), merged)
    }

    /**
     * A contact on the server: its whole answer, to send back what the phone
     * does not change (notes, categories); the 3+3 fields every server
     * answers; and, from servers with the full model, the card, version and
     * photo etag.
     */
    private class ServerContact(val id: String, val json: JSONObject, val legacy: LegacyCard) {
        // The full model, read only where a server has it.
        val card: ContactCard by lazy { ContactCard.fromJson(json) }
        val version: Long? get() = if (json.has("version") && !json.isNull("version")) json.optLong("version") else null
        val photo: String get() = json.optJSONObject("photo")?.optString("etag").orEmpty()

        /**
         * A fingerprint of everything an old server keeps of the contact, notes
         * included, so the phone notices a change it does not share without
         * keeping the notes. Keyed per installation (printKey).
         */
        fun print(key: ByteArray): String {
            val mac = javax.crypto.Mac.getInstance("HmacSHA256")
            mac.init(javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"))
            val fields = JSONArray(FIELDS.map { if (json.isNull(it)) JSONObject.NULL else json.optString(it) })
            return mac.doFinal(fields.toString().toByteArray()).joinToString("") { "%02x".format(it) }
        }

        companion object {
            // What PUT /api/contacts/:id writes on a 3+3 server.
            val FIELDS = listOf("first_name", "last_name", "email", "email2", "email3", "phone", "phone2", "phone3", "company", "job_title", "notes")

            private fun JSONObject.text(name: String): String =
                if (isNull(name)) "" else optString(name).trim().take(MAX_VALUE)

            fun from(json: JSONObject): ServerContact? {
                val id = json.text("id").takeIf { it.isNotEmpty() } ?: return null
                return ServerContact(id, json, LegacyCard(
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
    // The contacts API (api/src/routes/contacts.ts), so the app works with
    // servers from 0.22.0 on. A PUT replaces the whole contact; it gets the
    // server's own notes (and categories) back unchanged. With the full model
    // a PUT names the version it was merged with, and a contact changed in
    // UniHub meanwhile is refused (409) and merged again at the next sync.
    // Deletions, and every write to a 3+3 server, have no conditional form:
    // they are sent only if the contact is still as listed a few seconds
    // before (unchanged()), so an edit made in UniHub in that moment can be
    // overwritten, as between two open web pages.

    private class Server(val context: Context, val origin: String, val session: String, val current: Current, val key: ByteArray, val full: Boolean) {
        private var fresh: MutableMap<String, String>? = null
        private var freshAt = 0L

        // What tells a changed contact: its version, or on a 3+3 server its print.
        private fun mark(contact: ServerContact) = if (full) "v${contact.version}" else contact.print(key)

        /** Whether the server still has the contact as listed (read again at most every FRESH_MS). */
        fun unchanged(contact: ServerContact): Boolean {
            val now = android.os.SystemClock.elapsedRealtime()
            val known = fresh?.takeIf { now - freshAt <= FRESH_MS } ?: when (val listing = fetch(context, origin, session, current, full)) {
                is Listing.Complete -> listing.contacts.associate { it.id to mark(it) }.toMutableMap()
                is Listing.Gone -> throw IOException(listing.why)
            }.also { fresh = it; freshAt = now }
            return known[contact.id] == mark(contact)
        }

        /** The contact as the server saved it, or null when the server refused this one (it is tried again next sync). */
        fun save(existing: ServerContact?, card: LegacyCard): ServerContact? {
            val body = JSONObject()
                .put("first_name", card.first)
                .put("last_name", card.last.ifEmpty { null })
                .put("company", card.company.ifEmpty { null })
                .put("job_title", card.title.ifEmpty { null })
                .put("notes", existing?.json?.opt("notes").takeUnless { it == JSONObject.NULL })
            listOf("phone", "phone2", "phone3").forEachIndexed { index, field -> body.put(field, card.phones.getOrNull(index)) }
            listOf("email", "email2", "email3").forEachIndexed { index, field -> body.put(field, card.emails.getOrNull(index)) }
            return saved(if (existing == null) send("POST", "/api/contacts", body) else send("PUT", "/api/contacts/" + Uri.encode(existing.id), body))
        }

        /**
         * Writes the full model: everything the phone shares, with the values'
         * ids so they keep their identity, and UniHub's notes and categories
         * as they are. A change needs the version it was merged with.
         */
        fun saveFull(existing: ServerContact?, card: ContactCard): ServerContact? {
            val body = card.forServer().toJson(ids = true)
            if (existing == null) return saved(send("POST", "/api/contacts", body))
            body.put("notes", existing.json.opt("notes") ?: JSONObject.NULL)
                .put("categories", existing.json.optJSONArray("categories") ?: JSONArray())
                .put("version", existing.version ?: return null)
            return saved(send("PUT", "/api/contacts/" + Uri.encode(existing.id), body))
        }

        // A contact deleted meanwhile answers without one; the next listing tells.
        private fun saved(response: AppSession.Response?): ServerContact? {
            val saved = response?.json()?.optJSONObject("contact")?.let { ServerContact.from(it) } ?: return null
            fresh?.put(saved.id, mark(saved))
            return saved
        }

        /** Whether the server deleted it (or never had it). */
        fun delete(id: String): Boolean =
            (send("DELETE", "/api/contacts/" + Uri.encode(id), null) != null).also { if (it) fresh?.remove(id) }

        /** The contact's photo (JPEG), or null when it has none now or it is too large for the phone. */
        fun photo(contact: ServerContact): ByteArray? {
            current.check()
            val answer = try {
                AppSession.transfer(context, origin, "GET", "/api/contacts/" + Uri.encode(contact.id) + "/photo?size=full", session, current, null, null, MAX_PHOTO_DOWNLOAD)
            } catch (_: AppSession.TooLarge) {
                Log.w(TAG, "A contact photo is too large for the phone")
                return null
            }
            return when (answer.status) {
                200 -> answer.bytes.takeIf { it.isNotEmpty() }
                401 -> throw IOException("HTTP 401")
                in 400..499 -> null
                else -> throw IOException("HTTP ${answer.status}")
            }
        }

        /** Sets (bytes) or removes (null) the contact's photo; the contact as saved, or null when refused. */
        fun setPhoto(contact: ServerContact, bytes: ByteArray?): ServerContact? {
            current.check()
            val path = "/api/contacts/" + Uri.encode(contact.id) + "/photo"
            val answer = if (bytes == null) AppSession.transfer(context, origin, "DELETE", path, session, current, null, null, MAX_ANSWER)
            else AppSession.transfer(context, origin, "PUT", "$path?source=android", session, current, bytes, "application/octet-stream", MAX_ANSWER)
            return when (answer.status) {
                200 -> answer.json()?.optJSONObject("contact")?.let { ServerContact.from(it) }
                401 -> throw IOException("HTTP 401")
                in 400..499 -> {
                    val code = answer.json()?.optString("code")
                    if (code == "MODULE_DISABLED" || code == "RESTORE_IN_PROGRESS") throw IOException(code)
                    // A picture UniHub cannot read stays on the phone; it is offered again when it changes.
                    Log.w(TAG, "UniHub refused a contact photo: HTTP ${answer.status} ${code.orEmpty()}")
                    null
                }
                else -> throw IOException("HTTP ${answer.status}")
            }
        }

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
                    if (code == "VERSION_CONFLICT") Log.i(TAG, "A contact changed in UniHub during the sync; it is merged at the next one")
                    else Log.w(TAG, "UniHub refused a contact change: HTTP ${response.status}")
                    null
                }
                else -> throw IOException("HTTP ${response.status}")
            }
        }

        companion object {
            private const val MAX_ANSWER = 1024 * 1024
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
        // Who is who in UniHub (LegacyCard.identity), to join a new phone contact to.
        private val identities = HashMap<String, String>()
        private var created = 0
        private var updated = 0
        private var deleted = 0

        private fun print(contact: ServerContact) = contact.print(server.key)

        // Whether UniHub changed the contact since the last sync, notes included.
        private fun changedInUniHub(row: Row, contact: ServerContact) =
            row.serverBase(contact)?.sameAs(contact.legacy) != true || (!row.legacy && row.serverPrint != print(contact))

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
                    changedInUniHub(row, contact) -> restore(row, contact)
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
                    // phone changed it since; then it goes back as new. What
                    // UniHub does not keep (a photo, say) goes with it.
                    row.source != null && !row.changedOnPhone() -> {
                        batch.checked(listOf(assertUnchanged(account, row), deleteRow(account, row.id)))
                        result.stats.numDeletes++
                    }
                    else -> unlinked += row
                }
                batch.flushIfFull()
            }

            // New on the phone (saved to the UniHub account or moved there
            // from the phone's own contacts): the same person in UniHub is
            // joined, anyone else is added. A contact is recognised by all its
            // numbers and addresses, and also as it was sent (with the first
            // name UniHub requires, cut to its lengths), so a creation whose
            // answer was lost is not repeated.
            remote.values.forEach(::index)
            for (row in unlinked) {
                val card = row.card()
                val named = card.withFirstName()
                val match = (named.identity() + named.forServer().identity()).firstNotNullOfOrNull { identities[it] }?.let { remote[it] }
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
                if (contact.id in covered || contact.legacy.isEmpty) continue
                insertRow(contact)
                batch.flushIfFull()
            }
            batch.flush()
            return "to UniHub $created added, $updated changed, $deleted deleted"
        }

        private fun index(contact: ServerContact) = contact.legacy.identity().forEach { identities.putIfAbsent(it, contact.id) }

        /** Merges one phone contact with its UniHub contact and writes what changed on each side. */
        private fun merge(row: Row, contact: ServerContact, link: Boolean) {
            covered += contact.id
            val phone = row.card()
            // A contact the full model synced (the server went back to an
            // older version) merges as a joined one: nothing is removed.
            val joined = link || row.format == FORMAT_FULL
            val phoneBase = if (joined) LegacyCard() else row.phoneBase(contact)
            val serverBase = if (joined) LegacyCard() else row.serverBase(contact)
            // Without the last sync's state (a copy written by 0.22.0 whose
            // contact changed since, or a damaged record) UniHub's version wins.
            val merged = if (phoneBase == null || serverBase == null) LegacyMerged(contact.legacy, contact.legacy)
            else LegacyMerge.merge(phone, phoneBase, contact.legacy, serverBase)
            val phoneChanges = !merged.phone.sameAs(phone)
            val serverChanges = !merged.server.sameAs(contact.legacy)
            if (!joined && !phoneChanges && !serverChanges && row.owner == user && row.serverPrint == print(contact) &&
                phoneBase?.sameAs(phone) == true && serverBase?.sameAs(contact.legacy) == true
            ) return
            // Changed in UniHub since it was listed: the next sync merges that first.
            if (serverChanges && !server.unchanged(contact)) {
                result.stats.numSkippedEntries++
                return
            }

            // The phone first, and only if nobody edited the contact since it
            // was read; the server after. Should the server's write fail, the
            // next sync finds the same changes again.
            val phoneOps = ArrayList<ContentProviderOperation>()
            if (phoneChanges) {
                phoneOps += assertUnchanged(account, row)
                phoneOps += writeLegacyCard(account, row, merged.phone)
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
            val state = updateRow(account, row.id) { link(saved, merged.phone) }
            if (phoneOps.isEmpty()) batch += state else if (!batch.applyAlone(phoneOps + state)) return
            if (phoneChanges) result.stats.numUpdates++
        }

        /** A contact new on the phone becomes a new UniHub contact. */
        private fun create(row: Row, card: LegacyCard) {
            val saved = server.save(null, card.withFirstName().forServer()) ?: run { result.stats.numSkippedEntries++; return }
            remote[saved.id] = saved
            index(saved)
            covered += saved.id
            created++
            // At once: a later failure in this sync must not lose the link.
            batch += updateRow(account, row.id) { link(saved, card) }
            batch.flush()
        }

        /** Undoes a deletion on the phone, with UniHub's changes since. */
        private fun restore(row: Row, contact: ServerContact) {
            covered += contact.id
            val merged = row.serverBase(contact)?.let { LegacyMerge.merge(row.card(), row.card(), contact.legacy, it) } ?: LegacyMerged(contact.legacy, contact.legacy)
            val ops = arrayListOf(assertUnchanged(account, row), updateRow(account, row.id) { put(RawContacts.DELETED, 0) })
            ops += writeLegacyCard(account, row, merged.phone)
            ops += updateRow(account, row.id) { link(contact, merged.phone) }
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
            val contacts = deletions.map { it.second }.distinctBy { it.id }
            if (!extras.getBoolean(ContentResolver.SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS) &&
                contacts.size >= MANY_DELETIONS && contacts.size * 4 >= remote.size
            ) {
                Log.w(TAG, "${contacts.size} contacts deleted on the phone: waiting for confirmation")
                result.tooManyDeletions = true
                result.stats.numDeletes = contacts.size.toLong()
                covered += contacts.map { it.id }
                return
            }
            for (contact in contacts) {
                val rows = deletions.filter { it.second.id == contact.id }.map { it.first }
                // Changed in UniHub since it was listed: it comes back instead.
                if (!server.unchanged(contact)) {
                    rows.forEach { restore(it, contact) }
                    continue
                }
                if (!server.delete(contact.id)) {
                    covered += contact.id
                    result.stats.numSkippedEntries++
                    continue
                }
                remote.remove(contact.id)
                deleted++
                rows.forEach { batch += deleteRow(account, it.id) }
                batch.flushIfFull()
            }
        }

        private fun insertRow(contact: ServerContact) {
            val first = batch.size
            batch += ContentProviderOperation.newInsert(syncUri(RawContacts.CONTENT_URI, account))
                .withValue(RawContacts.ACCOUNT_NAME, account.name)
                .withValue(RawContacts.ACCOUNT_TYPE, account.type)
                .withValues(ContentValues().apply { link(contact, contact.legacy) })
                .build()
            for (values in legacyDataRows(contact.legacy)) {
                batch += ContentProviderOperation.newInsert(syncUri(ContactsContract.Data.CONTENT_URI, account))
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, first)
                    .withValues(values).build()
            }
            result.stats.numInserts++
        }

        // A phone contact's link to its UniHub contact and the state both sides had after this sync.
        private fun ContentValues.link(contact: ServerContact, phone: LegacyCard) {
            put(RawContacts.SOURCE_ID, contact.id)
            put(RawContacts.SYNC1, FORMAT)
            put(RawContacts.SYNC2, LegacyState.encode(phone))
            put(RawContacts.SYNC3, LegacyState.encode(contact.legacy, print(contact)))
            put(RawContacts.SYNC4, user)
            put(RawContacts.DIRTY, 0)
        }
    }

    /**
     * The full model (servers with `contacts-vcard`): every kind both sides
     * keep (ContactPhone), merged per kind (ContactMerge), written with the
     * version they were merged with; contacts merged in UniHub leave the
     * phone; photos follow in a pass of their own. ContactPlan decides what
     * happens to each phone contact.
     */
    private class FullReconcile(
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

        // Whether UniHub changed the contact since the last sync, notes included.
        private fun changedInUniHub(row: Row, contact: ServerContact): Boolean {
            if (row.format != FORMAT_FULL) return row.serverBase(contact)?.sameAs(contact.legacy) != true || (!row.legacy && row.serverPrint != contact.print(server.key))
            val state = row.serverState ?: return true
            return state.version != contact.version || !ContactPhone.same(state.card, contact.card) || state.photo != contact.photo
        }

        fun run(listing: Listing.Complete): String {
            listing.contacts.forEach { remote[it.id] = it }
            // Another user's contacts that were not sent yet stay untouched.
            val rows = readRows(account, provider).filter { it.owner == null || it.owner == user }
            val byId = rows.associateBy { it.id }
            val plan = ContactPlan.plan(
                rows.map { row ->
                    val contact = row.source?.let { remote[it] }
                    ContactPlan.Row(row.id, row.source, row.deleted, row.changedOnPhoneFull(), row.deleted && contact != null && changedInUniHub(row, contact))
                },
                remote.keys, listing.merged,
                discardPhoneDeletions = extras.getBoolean(ContentResolver.SYNC_EXTRAS_DISCARD_LOCAL_DELETIONS),
                overrideTooMany = extras.getBoolean(ContentResolver.SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS),
                many = MANY_DELETIONS,
            )
            fun row(planned: ContactPlan.Row) = byId.getValue(planned.id)

            // Deleted on the phone: deleted in UniHub too, unless UniHub
            // changed the contact since (then it comes back) or another
            // contact on the phone still stands for it. Many at once wait for
            // the person's answer (SyncResult.tooManyDeletions).
            for (planned in plan.removeFromPhone.filter { it.deleted }) {
                batch += deleteRow(account, planned.id)
                batch.flushIfFull()
            }
            plan.restore.forEach { restore(row(it), remote.getValue(it.source!!)) }
            if (plan.undone.isNotEmpty()) {
                Log.i(TAG, "Undoing ${plan.undone.size} deletions on the phone")
                plan.undone.forEach { restore(row(it), remote.getValue(it.source!!)) }
            }
            if (plan.tooManyDeletions) {
                Log.w(TAG, "${plan.waiting.size} contacts deleted on the phone: waiting for confirmation")
                result.tooManyDeletions = true
                result.stats.numDeletes = plan.waiting.size.toLong()
                covered += plan.waiting
            }
            deleteOnServer(plan.deleteInUniHub.mapValues { (_, planned) -> planned.map(::row) })

            // Merged in UniHub: the phone's changes to a merged-away contact
            // go to the contact it was merged into, then the copy goes. These
            // deletions come from UniHub and never wait for an answer.
            for ((planned, survivor) in plan.intoSurvivor) {
                intoSurvivor(row(planned), remote.getValue(survivor))
                batch.flushIfFull()
            }
            // Deleted or merged away in UniHub: gone from the phone too.
            for (planned in plan.removeFromPhone.filter { !it.deleted }) {
                val phoneRow = row(planned)
                batch.checked(listOf(assertUnchanged(account, phoneRow), deleteRow(account, phoneRow.id)))
                result.stats.numDeletes++
                batch.flushIfFull()
            }
            for (planned in plan.merge) {
                merge(row(planned), remote.getValue(planned.source!!), link = false)
                batch.flushIfFull()
            }

            // New on the phone (or deleted in UniHub after the phone changed
            // it): the same person in UniHub is joined, anyone else is added.
            // A contact is recognised by its numbers and addresses, and also as
            // it was sent, so a creation whose answer was lost is not repeated.
            remote.values.forEach(::index)
            for (planned in plan.unlinked) {
                val phoneRow = row(planned)
                val card = phoneRow.full.card
                val sent = card.forServer()
                val match = (card.identity() + sent.identity()).firstNotNullOfOrNull { identities[it] }?.let { remote[it] }
                when {
                    // Nothing that makes a contact for UniHub (only an address, say): it stays the phone's own.
                    !sent.hasIdentity -> if (phoneRow.owner == null) batch += updateRow(account, phoneRow.id) { put(RawContacts.SYNC4, user) }
                    match != null -> merge(phoneRow, match, link = true)
                    else -> create(phoneRow, sent)
                }
                batch.flushIfFull()
            }

            // New in UniHub.
            for (contact in remote.values) {
                if (contact.id in covered || !contact.card.forPhone().hasIdentity) continue
                insertRow(contact)
                batch.flushIfFull()
            }
            batch.flush()
            val photos = Photos(server, user, account, provider, remote).run()
            return "to UniHub $created added, $updated changed, $deleted deleted; $photos"
        }

        private fun index(contact: ServerContact) = contact.card.identity().forEach { identities.putIfAbsent(it, contact.id) }

        /** Merges one phone contact with its UniHub contact and writes what changed on each side. */
        private fun merge(row: Row, contact: ServerContact, link: Boolean) {
            covered += contact.id
            val phone = row.full
            val bases = if (link) ContactState(ContactCard()) to ContactState(ContactCard()) else row.fullBases(contact)
            // Without the last sync's state (a damaged record) UniHub's version wins.
            val merged = if (bases == null) MergedContact(contact.card.forPhone(), contact.card)
            else ContactMerge.merge(phone.card, bases.first.card, contact.card, bases.second.card)
            val phoneChanges = !ContactPhone.same(merged.phone, phone.card)
            val serverChanges = !ContactPhone.same(merged.server, contact.card)
            if (!link && !phoneChanges && !serverChanges && row.owner == user && row.format == FORMAT_FULL && bases != null &&
                bases.second.version == contact.version && ContactPhone.same(bases.first.card, phone.card) && ContactPhone.same(bases.second.card, contact.card)
            ) return

            // The phone first, and only if nobody edited the contact since it
            // was read; the server after, with the version it was merged with.
            // Should the server's write fail, the next sync finds the same
            // changes again.
            val phoneOps = ArrayList<ContentProviderOperation>()
            if (phoneChanges) {
                phoneOps += assertUnchanged(account, row)
                phoneOps += writeFullCard(account, row, merged.phone)
            }
            var saved = contact
            if (serverChanges) {
                if (phoneOps.isNotEmpty() && !batch.applyAlone(phoneOps)) return
                phoneOps.clear()
                saved = server.saveFull(contact, merged.server) ?: run { result.stats.numSkippedEntries++; return }
                remote[saved.id] = saved
                index(saved)
                updated++
            }
            // The photos keep their state of the last sync; the photo pass moves them.
            val state = updateRow(account, row.id) { link(saved, merged.phone, bases?.first?.photo.orEmpty(), bases?.second?.photo.orEmpty()) }
            if (phoneOps.isEmpty()) batch += state else if (!batch.applyAlone(phoneOps + state)) return
            if (phoneChanges) result.stats.numUpdates++
        }

        /** A contact new on the phone becomes a new UniHub contact. */
        private fun create(row: Row, card: ContactCard) {
            val saved = server.saveFull(null, card) ?: run { result.stats.numSkippedEntries++; return }
            remote[saved.id] = saved
            index(saved)
            covered += saved.id
            created++
            // At once: a later failure in this sync must not lose the link.
            batch += updateRow(account, row.id) { link(saved, row.full.card, "", saved.photo) }
            batch.flush()
        }

        /**
         * A phone contact whose UniHub contact was merged into [survivor]
         * after the phone changed it: the phone's changes since the last sync
         * are applied to the survivor, then the copy leaves the phone (the
         * survivor's own copy brings the result).
         */
        private fun intoSurvivor(row: Row, survivor: ServerContact) {
            val phone = row.full.card
            val base = row.fullBases(null)?.first?.card
            val merged = if (base == null) ContactMerge.merge(phone, ContactCard(), survivor.card, ContactCard())
            else ContactMerge.merge(phone, base, survivor.card, survivor.card)
            if (!ContactPhone.same(merged.server, survivor.card)) {
                val saved = server.saveFull(survivor, merged.server) ?: run { result.stats.numSkippedEntries++; return }
                remote[saved.id] = saved
                updated++
            }
            batch.checked(listOf(assertUnchanged(account, row), deleteRow(account, row.id)))
            result.stats.numDeletes++
        }

        /** Undoes a deletion on the phone, with UniHub's changes since. */
        private fun restore(row: Row, contact: ServerContact) {
            covered += contact.id
            val phone = row.full
            val bases = row.fullBases(contact)
            val merged = bases?.let { ContactMerge.merge(phone.card, phone.card, contact.card, it.second.card) } ?: MergedContact(contact.card.forPhone(), contact.card)
            val ops = arrayListOf(assertUnchanged(account, row), updateRow(account, row.id) { put(RawContacts.DELETED, 0) })
            ops += writeFullCard(account, row, merged.phone)
            ops += updateRow(account, row.id) { link(contact, merged.phone, bases?.first?.photo.orEmpty(), bases?.second?.photo.orEmpty()) }
            if (batch.applyAlone(ops)) result.stats.numInserts++
        }

        private fun deleteOnServer(deletions: Map<String, List<Row>>) {
            for ((id, rows) in deletions) {
                val contact = remote.getValue(id)
                // Changed in UniHub since it was listed: it comes back instead.
                if (!server.unchanged(contact)) {
                    rows.forEach { restore(it, contact) }
                    continue
                }
                if (!server.delete(contact.id)) {
                    covered += contact.id
                    result.stats.numSkippedEntries++
                    continue
                }
                remote.remove(contact.id)
                deleted++
                rows.forEach { batch += deleteRow(account, it.id) }
                batch.flushIfFull()
            }
        }

        private fun insertRow(contact: ServerContact) {
            val first = batch.size
            batch += ContentProviderOperation.newInsert(syncUri(RawContacts.CONTENT_URI, account))
                .withValue(RawContacts.ACCOUNT_NAME, account.name)
                .withValue(RawContacts.ACCOUNT_TYPE, account.type)
                .withValue(RawContacts.STARRED, if (contact.card.favorite) 1 else 0)
                .withValues(ContentValues().apply { link(contact, contact.card.forPhone(), "", "") })
                .build()
            for (data in ContactPhone.rows(contact.card)) {
                batch += ContentProviderOperation.newInsert(syncUri(ContactsContract.Data.CONTENT_URI, account))
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, first)
                    .withValues(dataValues(data, withMime = true)).build()
            }
            covered += contact.id
            result.stats.numInserts++
        }

        // A phone contact's link to its UniHub contact and the state both sides had after this sync.
        private fun ContentValues.link(contact: ServerContact, phone: ContactCard, phonePhoto: String, serverPhoto: String) {
            put(RawContacts.SOURCE_ID, contact.id)
            put(RawContacts.SYNC1, FORMAT_FULL)
            put(RawContacts.SYNC2, ContactState(phone.forPhone(), phonePhoto).encode())
            put(RawContacts.SYNC3, ContactState(contact.card.withoutIds(), serverPhoto, contact.version).encode())
            put(RawContacts.SYNC4, user)
            put(RawContacts.DIRTY, 0)
        }
    }

    /**
     * Contact photos, after the contacts themselves: a picture changed on one
     * side since the last sync goes to the other (UniHub's when both
     * changed). At most MAX_PHOTO_TRANSFERS per sync and none on a metered
     * network; the rest follow on later syncs. Each side's state records the
     * photo as that side holds it after the transfer (Android scales and
     * recompresses a picture, UniHub converts one), so that is no change.
     */
    private class Photos(
        val server: Server,
        val user: String,
        val account: Account,
        val provider: ContentProviderClient,
        val remote: Map<String, ServerContact>,
    ) {
        fun run(): String {
            val metered = server.context.getSystemService(ConnectivityManager::class.java)?.isActiveNetworkMetered ?: true
            var moved = 0
            var waiting = 0
            for (row in readRows(account, provider)) {
                if (row.deleted || row.owner != user || row.format != FORMAT_FULL) continue
                val contact = row.source?.let { remote[it] } ?: continue
                val phoneState = row.phoneState ?: continue
                val serverState = row.serverState ?: continue
                val phone = row.full
                val serverChanged = contact.photo != serverState.photo
                val phoneChanged = phone.photo != phoneState.photo
                if (!serverChanged && !phoneChanged) continue
                if (metered || moved >= MAX_PHOTO_TRANSFERS) { waiting++; continue }
                server.current.check()
                val done = if (serverChanged) download(row, phone, contact, phoneState, serverState) else upload(row, phone, contact, phoneState, serverState)
                if (done) moved++
            }
            return "$moved photos moved" + when {
                waiting == 0 -> ""
                metered -> ", $waiting wait for an unmetered network"
                else -> ", $waiting follow next time"
            }
        }

        // UniHub's picture (or its removal) onto the phone.
        private fun download(row: Row, phone: PhoneContact, contact: ServerContact, phoneState: ContactState, serverState: ContactState): Boolean {
            val ops = arrayListOf(assertUnchanged(account, row))
            val data = syncUri(ContactsContract.Data.CONTENT_URI, account)
            if (contact.photo.isEmpty()) {
                phone.photoRow?.let { ops += ContentProviderOperation.newDelete(data).withSelection("${ContactsContract.Data._ID} = ?", arrayOf(it.toString())).build() }
            } else {
                val bytes = server.photo(contact) ?: return false
                val existing = phone.photoRow
                ops += if (existing != null) ContentProviderOperation.newUpdate(data)
                    .withSelection("${ContactsContract.Data._ID} = ?", arrayOf(existing.toString())).withValue(Photo.PHOTO, bytes).build()
                else ContentProviderOperation.newInsert(data).withValue(ContactsContract.Data.RAW_CONTACT_ID, row.id)
                    .withValue(ContactsContract.Data.MIMETYPE, Photo.CONTENT_ITEM_TYPE).withValue(Photo.PHOTO, bytes).build()
            }
            if (!Batch(provider, server.current).applyAlone(ops)) return false
            val now = photoIdentity(row.id)
            Batch(provider, server.current).applyAlone(listOf(updateRow(account, row.id) {
                put(RawContacts.SYNC2, phoneState.copy(photo = now).encode())
                put(RawContacts.SYNC3, serverState.copy(photo = contact.photo).encode())
                put(RawContacts.DIRTY, 0)
            }))
            return true
        }

        // The phone's picture (or its removal) to UniHub.
        private fun upload(row: Row, phone: PhoneContact, contact: ServerContact, phoneState: ContactState, serverState: ContactState): Boolean {
            val bytes = if (phone.photo.isEmpty()) null else picture(row) ?: return false
            val saved = server.setPhoto(contact, bytes) ?: return false
            // The photo write counts as a change of the contact: its version is
            // the next one, unless someone else changed it meanwhile; then the
            // next sync merges that.
            val version = if (serverState.version != null && saved.version == serverState.version + 1) saved.version else serverState.version
            Batch(provider, server.current).applyAlone(listOf(updateRow(account, row.id) {
                put(RawContacts.SYNC2, phoneState.copy(photo = phone.photo).encode())
                put(RawContacts.SYNC3, serverState.copy(photo = saved.photo, version = version).encode())
                put(RawContacts.DIRTY, 0)
            }))
            return true
        }

        // The phone's display photo, else the thumbnail it holds.
        private fun picture(row: Row): ByteArray? {
            val uri = syncUri(Uri.withAppendedPath(ContentUris.withAppendedId(RawContacts.CONTENT_URI, row.id), RawContacts.DisplayPhoto.CONTENT_DIRECTORY), account)
            try {
                provider.openAssetFile(uri, "r")?.use { file ->
                    file.createInputStream().use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            if (output.size() > MAX_PHOTO_UPLOAD) return null
                        }
                        if (output.size() > 0) return output.toByteArray()
                    }
                }
            } catch (_: FileNotFoundException) {
                // Only a thumbnail.
            }
            return photoRow(row.id)?.second
        }

        private fun photoIdentity(raw: Long): String = photoRow(raw)?.let { ContactPhone.photoIdentity(it.first, it.second) }.orEmpty()

        // The photo row's file id and thumbnail.
        private fun photoRow(raw: Long): Pair<String?, ByteArray?>? = provider.query(
            syncUri(ContactsContract.Data.CONTENT_URI, account),
            arrayOf(Photo.PHOTO_FILE_ID, Photo.PHOTO),
            "${ContactsContract.Data.RAW_CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
            arrayOf(raw.toString(), Photo.CONTENT_ITEM_TYPE),
            null,
        )?.use { c -> if (c.moveToFirst()) (if (c.isNull(0)) null else c.getLong(0).toString()) to (if (c.isNull(1)) null else c.getBlob(1)) else null }
    }

    // ── The phone's side ───────────────────────────────────────────────
    // A phone contact (raw contact) of the UniHub account keeps its UniHub
    // contact's ID in SOURCE_ID and the state of both sides after the last
    // sync in SYNC2 (phone) and SYNC3 (server), so a sync can tell who
    // changed what. SYNC4 is the UniHub user it belongs to. SYNC1 tells the
    // format: "3" the full model (ContactState), "2" the 3+3 fields
    // (LegacyState); copies written by 0.22.0 and 0.22.1 have only a hash of
    // the server's contact there.

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
        val format: String?,
        private val sync2: String?,
        private val sync3: String?,
        val owner: String?,
    ) {
        val data = ArrayList<PhoneData>()
        var starred = false

        // ── As the 3+3 sync sees it ──
        var nameRow: Long? = null
        var first = ""
        var last = ""
        var orgRow: Long? = null
        var company = ""
        var title = ""
        val phones = ArrayList<Pair<Long, String>>()
        val emails = ArrayList<Pair<Long, String>>()
        // Anything the 3+3 fields do not hold: a photo, an address, a middle
        // name, a label, a department, a second name or company.
        var own = false

        private val legacyPhoneState by lazy { LegacyState.decode(sync2) }
        private val legacyServerState by lazy { LegacyState.decodeServer(sync3) }
        val serverPrint get() = legacyServerState?.second

        fun card() = LegacyCard(first, last, phones.map { it.second }, emails.map { it.second }, company, title)

        // 0.22.0 and 0.22.1 wrote read-only copies of the server's contact:
        // while that contact has not changed, both sides were the same.
        val legacy get() = legacyServerState == null && format != null && format.length == 64
        private fun legacyBase(contact: ServerContact) = contact.legacy.takeIf { LegacyState.hash(it) == format }

        fun phoneBase(contact: ServerContact): LegacyCard? = if (legacy) legacyBase(contact) else legacyPhoneState
        fun serverBase(contact: ServerContact): LegacyCard? = if (legacy) legacyBase(contact) else legacyServerState?.first

        /** Whether the phone changed it since the last sync. A 0.22.0 copy was read-only. */
        fun changedOnPhone(): Boolean = !legacy && legacyPhoneState?.sameAs(card()) != true

        /** Holds nothing beyond its UniHub contact, so removing it loses nothing. */
        fun isCopy(): Boolean = if (format == FORMAT_FULL) !full.phoneOnly && !changedOnPhoneFull()
        else !own && !changedOnPhone() && (legacy || legacyServerState?.first?.sameAs(card()) == true)

        // ── As the full model sees it ──
        val full by lazy { ContactPhone.read(data, starred) }
        val phoneState by lazy { if (format == FORMAT_FULL) ContactState.decode(sync2) else null }
        val serverState by lazy { if (format == FORMAT_FULL) ContactState.decode(sync3) else null }

        /**
         * Both sides' states of the last sync for the full model. A contact the
         * 3+3 sync linked starts from its six fields (ContactState.upgrade); a
         * 0.22.0 copy from the contact it copied, while unchanged.
         */
        fun fullBases(contact: ServerContact?): Pair<ContactState, ContactState>? {
            if (format == FORMAT_FULL) return phoneState?.let { phone -> serverState?.let { phone to it } }
            if (legacy) return contact?.let(::legacyBase)?.let { ContactState.upgrade(it, it) }
            val phone = legacyPhoneState ?: return null
            val server = legacyServerState?.first ?: return null
            return ContactState.upgrade(phone, server)
        }

        /** Whether the phone changed it since the last sync (the 3+3 fields for a contact that sync linked). */
        fun changedOnPhoneFull(): Boolean {
            if (format != FORMAT_FULL) return changedOnPhone()
            val state = phoneState ?: return true
            return !ContactPhone.same(state.card, full.card) || state.photo != full.photo
        }
    }

    // Through RawContactsEntity: unlike the Data view, it shows a sync
    // adapter the data of contacts deleted on the phone, which a restore needs.
    private fun readRows(account: Account, provider: ContentProviderClient): List<Row> {
        val rows = LinkedHashMap<Long, Row>()
        val columns = (1..15).map { "data$it" }
        provider.query(
            syncUri(ContactsContract.RawContactsEntity.CONTENT_URI, account),
            arrayOf(
                RawContacts._ID, RawContacts.SOURCE_ID, RawContacts.DELETED, RawContacts.VERSION,
                RawContacts.SYNC1, RawContacts.SYNC2, RawContacts.SYNC3, RawContacts.SYNC4,
                ContactsContract.RawContactsEntity.DATA_ID, ContactsContract.Data.MIMETYPE, ContactsContract.Data.IS_PRIMARY,
            ) + columns,
            "${RawContacts.ACCOUNT_NAME} = ? AND ${RawContacts.ACCOUNT_TYPE} = ?",
            arrayOf(account.name, account.type),
            "${RawContacts._ID}, ${ContactsContract.RawContactsEntity.DATA_ID}",
        )?.use { c ->
            while (c.moveToNext()) {
                val raw = c.getLong(0)
                val row = rows.getOrPut(raw) {
                    Row(raw, c.getString(1), c.getInt(2) != 0, c.getString(3), c.getString(4), c.getString(5), c.getString(6), c.getString(7))
                }
                if (c.isNull(8)) continue
                // DATA15 holds a photo's thumbnail as a blob.
                val picture = if (c.getType(25) == Cursor.FIELD_TYPE_BLOB) c.getBlob(25) else null
                val values = HashMap<String, String?>()
                columns.forEachIndexed { index, name -> if (index != 14 || picture == null) values[name] = c.getString(11 + index) }
                values["is_primary"] = c.getString(10)
                row.data += PhoneData(c.getLong(8), c.getString(9), values, picture)
            }
        }
        provider.query(
            syncUri(RawContacts.CONTENT_URI, account),
            arrayOf(RawContacts._ID, RawContacts.STARRED),
            "${RawContacts.ACCOUNT_NAME} = ? AND ${RawContacts.ACCOUNT_TYPE} = ?",
            arrayOf(account.name, account.type),
            null,
        )?.use { c -> while (c.moveToNext()) rows[c.getLong(0)]?.starred = c.getInt(1) != 0 }
        rows.values.forEach(::readLegacy)
        return rows.values.toList()
    }

    // What the 3+3 sync shares of a phone contact, and whether it holds more.
    private fun readLegacy(row: Row) {
        val shared = setOf(StructuredName.CONTENT_ITEM_TYPE, Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE, Organization.CONTENT_ITEM_TYPE)
        for (data in row.data) {
            fun text(n: Int) = data.columns["data$n"]?.trim()?.take(MAX_VALUE).orEmpty()
            val id = data.id ?: continue
            when (data.mime) {
                // GIVEN_NAME is data2, FAMILY_NAME data3; prefix, middle, suffix and phonetic parts data4 to data9.
                StructuredName.CONTENT_ITEM_TYPE -> if (row.nameRow == null) {
                    row.nameRow = id; row.first = text(2); row.last = text(3)
                    if ((4..9).any { text(it).isNotEmpty() }) row.own = true
                } else row.own = true
                // A label other than the one the sync gives (TYPE data2, LABEL data3) is the phone's own.
                Phone.CONTENT_ITEM_TYPE -> text(1).takeIf { it.isNotEmpty() }?.let {
                    row.phones += id to it
                    if (text(2) != Phone.TYPE_MOBILE.toString() || text(3).isNotEmpty()) row.own = true
                }
                Email.CONTENT_ITEM_TYPE -> text(1).takeIf { it.isNotEmpty() }?.let {
                    row.emails += id to it
                    if (text(2) != Email.TYPE_OTHER.toString() || text(3).isNotEmpty()) row.own = true
                }
                // COMPANY is data1, TITLE data4; type, label, department and the rest are the phone's own.
                Organization.CONTENT_ITEM_TYPE -> if (row.orgRow == null) {
                    row.orgRow = id; row.company = text(1); row.title = text(4)
                    if (text(2) != Organization.TYPE_WORK.toString() || text(3).isNotEmpty() || (5..9).any { text(it).isNotEmpty() }) row.own = true
                } else row.own = true
                // Group memberships are the contacts app's bookkeeping, and an
                // empty row (a photo row without a picture) holds nothing.
                else -> if (data.mime !in shared && data.mime != ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE &&
                    ((1..9).any { text(it).isNotEmpty() } || data.columns["data14"] != null || data.columns["data15"] != null || data.picture != null)
                ) row.own = true
            }
        }
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
     * Turns the phone contact into [card] (3+3 fields), touching only what
     * differs: labels the person chose, other numbers' order and everything
     * those fields do not hold stay as they are.
     */
    private fun writeLegacyCard(account: Account, row: Row, card: LegacyCard): List<ContentProviderOperation> = buildList {
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
            // The type the person chose stays; a new row is a work one.
            if (existing != null) add(update(existing, organization.apply { remove(Organization.TYPE) }))
            else if (card.company.isNotEmpty() || card.title.isNotEmpty()) add(insert(organization))
        }
        fun entries(have: List<Pair<Long, String>>, want: List<String>, key: (String) -> String, values: (String) -> ContentValues) {
            val wanted = want.map(key).toSet()
            val present = have.map { key(it.second) }.toSet()
            have.filter { key(it.second) !in wanted }.forEach { add(delete(it.first)) }
            want.filter { key(it) !in present }.distinctBy(key).forEach { add(insert(values(it))) }
        }
        entries(row.phones, card.phones, LegacyCard::phoneKey, ::phoneValues)
        entries(row.emails, card.emails, LegacyCard::emailKey, ::emailValues)
    }

    /** Turns the phone contact into [card] (the full model): ContactPhone.changes as provider operations. */
    private fun writeFullCard(account: Account, row: Row, card: ContactCard): List<ContentProviderOperation> {
        val data = syncUri(ContactsContract.Data.CONTENT_URI, account)
        return ContactPhone.changes(row.full, card).map { change ->
            when (change) {
                is PhoneChange.Insert -> ContentProviderOperation.newInsert(data).withValue(ContactsContract.Data.RAW_CONTACT_ID, row.id)
                    .withValues(dataValues(change.data, withMime = true)).build()
                is PhoneChange.Update -> ContentProviderOperation.newUpdate(data)
                    .withSelection("${ContactsContract.Data._ID} = ?", arrayOf(change.id.toString()))
                    .withValues(dataValues(PhoneData(change.id, "", change.columns), withMime = false)).build()
                is PhoneChange.Delete -> ContentProviderOperation.newDelete(data)
                    .withSelection("${ContactsContract.Data._ID} = ?", arrayOf(change.id.toString())).build()
                is PhoneChange.Starred -> updateRow(account, row.id) { put(RawContacts.STARRED, if (change.starred) 1 else 0) }
            }
        }
    }

    // A data row's columns; types, the primary flag and an Im protocol are numbers.
    private fun dataValues(data: PhoneData, withMime: Boolean) = ContentValues().apply {
        if (withMime) put(ContactsContract.Data.MIMETYPE, data.mime)
        for ((column, value) in data.columns) {
            val number = column == "data2" || column == ContactsContract.Data.IS_PRIMARY || (column == Im.PROTOCOL && data.mime == Im.CONTENT_ITEM_TYPE)
            when {
                value == null -> putNull(column)
                number && value.toIntOrNull() != null -> put(column, value.toInt())
                else -> put(column, value)
            }
        }
    }

    private fun legacyDataRows(card: LegacyCard): List<ContentValues> = buildList {
        if (card.first.isNotEmpty() || card.last.isNotEmpty()) add(nameValues(card))
        card.phones.forEach { add(phoneValues(it)) }
        card.emails.forEach { add(emailValues(it)) }
        if (card.company.isNotEmpty() || card.title.isNotEmpty()) add(organizationValues(card))
    }

    private fun data(mime: String, fill: ContentValues.() -> Unit) =
        ContentValues().apply { put(ContactsContract.Data.MIMETYPE, mime); fill() }

    // Android puts the display name together from the parts.
    private fun nameValues(card: LegacyCard) = data(StructuredName.CONTENT_ITEM_TYPE) {
        put(StructuredName.GIVEN_NAME, card.first.ifEmpty { null })
        put(StructuredName.FAMILY_NAME, card.last.ifEmpty { null })
    }

    // UniHub's vCard export up to 0.25 called every number a mobile number.
    private fun phoneValues(number: String) = data(Phone.CONTENT_ITEM_TYPE) { put(Phone.NUMBER, number); put(Phone.TYPE, Phone.TYPE_MOBILE) }
    private fun emailValues(address: String) = data(Email.CONTENT_ITEM_TYPE) { put(Email.ADDRESS, address); put(Email.TYPE, Email.TYPE_OTHER) }
    private fun organizationValues(card: LegacyCard) = data(Organization.CONTENT_ITEM_TYPE) {
        put(Organization.COMPANY, card.company.ifEmpty { null })
        put(Organization.TITLE, card.title.ifEmpty { null })
        put(Organization.TYPE, Organization.TYPE_WORK)
    }

    /** Operations applied in transactions of up to BATCH; a contact's rows always share one. */
    private class Batch(val provider: ContentProviderClient, val current: Current?) {
        private val ops = ArrayList<ContentProviderOperation>()
        // Groups starting with an assertUnchanged(): one that fails is left out, the rest apply.
        private val checked = ArrayList<List<ContentProviderOperation>>()
        val size get() = ops.size

        operator fun plusAssign(op: ContentProviderOperation) { ops += op }

        fun checked(group: List<ContentProviderOperation>) { checked += group }

        fun flushIfFull() { if (ops.size >= BATCH || checked.size >= BATCH / 2) flush() }

        fun flush() {
            if (ops.isNotEmpty()) {
                current?.check()
                provider.applyBatch(ArrayList(ops))
                ops.clear()
            }
            if (checked.isNotEmpty()) {
                current?.check()
                try {
                    provider.applyBatch(ArrayList(checked.flatten()))
                } catch (_: OperationApplicationException) {
                    checked.forEach { applyAlone(it) }
                }
                checked.clear()
            }
        }

        /** One contact's changes on their own; false if the contact changed meanwhile (the next sync sees the edit). */
        fun applyAlone(contactOps: List<ContentProviderOperation>): Boolean {
            if (ops.isNotEmpty()) {
                current?.check()
                provider.applyBatch(ArrayList(ops))
                ops.clear()
            }
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
