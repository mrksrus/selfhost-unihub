package io.github.mrksrus.unihub

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
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
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Shows the signed-in user's UniHub contacts in the phone's own contacts, so
 * the Phone app, WhatsApp and others can show their names.
 *
 * The contacts belong to an Android account of this app ("UniHub", named after
 * the server), filled by a sync adapter (ContactsSyncService). The phone copy
 * is a read-only mirror: UniHub stays the only place to edit, and each sync
 * makes the phone match the server. It asks the server with the session of
 * the app's WebView, so no server change is needed and it signs in and out
 * with the app. Removing the account (Android settings, changing server,
 * uninstalling) removes its contacts from the phone.
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
    private const val MAX_BODY = 16 * 1024 * 1024
    // Values longer than this are cut; the server keeps 255 characters.
    private const val MAX_VALUE = 1000
    // Operations per transaction; a contact's rows always share one.
    private const val BATCH = 300
    // Changes when the mapping below changes, so every contact is rewritten.
    private const val FORMAT = "1"

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
    fun check(origin: String): Offer {
        val session = cookie(origin) ?: return Offer.SignedOut
        return try {
            val me = get(origin, "/api/auth/me?background=1", session)
            if (me.status == 401) return Offer.SignedOut
            if (me.status != 200) return Offer.Unavailable
            val page = get(origin, "/api/contacts?limit=1", session)
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
     * Makes the account's contacts match the server. A complete listing
     * replaces the phone's copy; a failed or partial one changes nothing.
     * Signing out, a session that ended, a disabled Contacts module or
     * another server empties it.
     */
    fun sync(context: Context, account: Account, provider: ContentProviderClient, result: SyncResult) {
        val manager = AccountManager.get(context)
        val origin = manager.getUserData(account, KEY_ORIGIN)
        if (origin == null || origin != ServerAddress.saved(context)) {
            clear(manager, account, provider, result, "the app is on another server")
            return
        }
        val session = cookie(origin)
        if (session == null) {
            clear(manager, account, provider, result, "signed out")
            return
        }
        val listing = try {
            fetch(origin, session)
        } catch (error: IOException) {
            Log.w(TAG, "Sync postponed: ${error.javaClass.simpleName}")
            result.stats.numIoExceptions++
            return
        } catch (_: org.json.JSONException) {
            Log.w(TAG, "Sync postponed: unexpected answer")
            result.stats.numParseExceptions++
            return
        }
        when (listing) {
            is Listing.Gone -> clear(manager, account, provider, result, listing.why)
            is Listing.Complete -> {
                if (manager.getUserData(account, KEY_USER) != listing.user) {
                    deleteAll(account, provider, result)
                    manager.setUserData(account, KEY_USER, listing.user)
                }
                makeVisible(account, provider)
                apply(account, provider, listing.contacts, result)
                Log.i(TAG, "Synced ${listing.contacts.size} contacts: ${result.stats.numInserts} added, ${result.stats.numUpdates} changed, ${result.stats.numDeletes} removed")
            }
        }
    }

    private fun clear(manager: AccountManager, account: Account, provider: ContentProviderClient, result: SyncResult, why: String) {
        deleteAll(account, provider, result)
        manager.setUserData(account, KEY_USER, null)
        Log.i(TAG, "Removed the contacts from the phone: $why")
    }

    private sealed interface Listing {
        class Complete(val user: String, val contacts: List<PhoneContact>) : Listing
        class Gone(val why: String) : Listing
    }

    private fun fetch(origin: String, session: String): Listing {
        val me = get(origin, "/api/auth/me?background=1", session)
        if (me.status == 401) return Listing.Gone("the session ended")
        me.expectOk()
        val user = JSONObject(me.body).getJSONObject("user").getString("id")
        val contacts = LinkedHashMap<String, PhoneContact>()
        var offset = 0
        while (true) {
            val page = get(origin, "/api/contacts?limit=$PAGE&offset=$offset", session)
            if (page.status == 401) return Listing.Gone("the session ended")
            if (page.status == 403 && page.json()?.optString("code") == "MODULE_DISABLED") return Listing.Gone("the Contacts module is off")
            page.expectOk()
            val json = JSONObject(page.body)
            val rows = json.getJSONArray("contacts")
            for (index in 0 until rows.length()) {
                PhoneContact.from(rows.getJSONObject(index))?.let { contacts[it.id] = it }
            }
            if (!json.optBoolean("has_more") || rows.length() == 0) break
            offset += rows.length()
            if (offset >= MAX_CONTACTS) throw IOException("More than $MAX_CONTACTS contacts")
        }
        return Listing.Complete(user, contacts.values.toList())
    }

    // ── The phone's side ───────────────────────────────────────────────

    private fun syncUri(uri: Uri, account: Account): Uri = uri.buildUpon()
        .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(RawContacts.ACCOUNT_NAME, account.name)
        .appendQueryParameter(RawContacts.ACCOUNT_TYPE, account.type)
        .build()

    private class Local(val id: Long, val hash: String?, val deleted: Boolean)

    private fun local(account: Account, provider: ContentProviderClient): Map<String?, List<Local>> {
        val rows = ArrayList<Pair<String?, Local>>()
        provider.query(
            syncUri(RawContacts.CONTENT_URI, account),
            arrayOf(RawContacts._ID, RawContacts.SOURCE_ID, RawContacts.SYNC1, RawContacts.DELETED),
            "${RawContacts.ACCOUNT_NAME} = ? AND ${RawContacts.ACCOUNT_TYPE} = ?",
            arrayOf(account.name, account.type),
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                rows += cursor.getString(1) to Local(cursor.getLong(0), cursor.getString(2), cursor.getInt(3) != 0)
            }
        }
        return rows.groupBy({ it.first }, { it.second })
    }

    private fun apply(account: Account, provider: ContentProviderClient, contacts: List<PhoneContact>, result: SyncResult) {
        val existing = local(account, provider)
        val wanted = contacts.associateBy { it.id }
        val ops = ArrayList<ContentProviderOperation>()
        fun flush() {
            if (ops.isEmpty()) return
            provider.applyBatch(ArrayList(ops))
            ops.clear()
        }
        fun deleteRaw(id: Long) {
            ops += ContentProviderOperation.newDelete(syncUri(RawContacts.CONTENT_URI, account))
                .withSelection("${RawContacts._ID} = ?", arrayOf(id.toString())).build()
        }

        // On the phone but not on the server, deleted on the phone, or a
        // duplicate of one source: removed (a deleted one comes back below).
        for ((source, rows) in existing) {
            val keep = if (source != null && source in wanted) rows.firstOrNull { !it.deleted } else null
            for (row in rows) if (row !== keep) {
                deleteRaw(row.id)
                result.stats.numDeletes++
                if (ops.size >= BATCH) flush()
            }
        }
        flush()

        for (contact in contacts) {
            val row = existing[contact.id]?.firstOrNull { !it.deleted }
            when {
                row == null -> {
                    val first = ops.size
                    ops += ContentProviderOperation.newInsert(syncUri(RawContacts.CONTENT_URI, account))
                        .withValue(RawContacts.ACCOUNT_NAME, account.name)
                        .withValue(RawContacts.ACCOUNT_TYPE, account.type)
                        .withValue(RawContacts.SOURCE_ID, contact.id)
                        .withValue(RawContacts.SYNC1, contact.hash)
                        .build()
                    for (values in contact.rows()) {
                        ops += ContentProviderOperation.newInsert(syncUri(ContactsContract.Data.CONTENT_URI, account))
                            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, first)
                            .withValues(values).build()
                    }
                    result.stats.numInserts++
                }
                row.hash != contact.hash -> {
                    ops += ContentProviderOperation.newDelete(syncUri(ContactsContract.Data.CONTENT_URI, account))
                        .withSelection("${ContactsContract.Data.RAW_CONTACT_ID} = ?", arrayOf(row.id.toString())).build()
                    for (values in contact.rows()) {
                        ops += ContentProviderOperation.newInsert(syncUri(ContactsContract.Data.CONTENT_URI, account))
                            .withValue(ContactsContract.Data.RAW_CONTACT_ID, row.id)
                            .withValues(values).build()
                    }
                    ops += ContentProviderOperation.newUpdate(syncUri(RawContacts.CONTENT_URI, account))
                        .withSelection("${RawContacts._ID} = ?", arrayOf(row.id.toString()))
                        .withValue(RawContacts.SYNC1, contact.hash)
                        .withValue(RawContacts.DIRTY, 0)
                        .build()
                    result.stats.numUpdates++
                }
            }
            if (ops.size >= BATCH) flush()
        }
        flush()
    }

    private fun deleteAll(account: Account, provider: ContentProviderClient, result: SyncResult) {
        result.stats.numDeletes += provider.delete(
            syncUri(RawContacts.CONTENT_URI, account),
            "${RawContacts.ACCOUNT_NAME} = ? AND ${RawContacts.ACCOUNT_TYPE} = ?",
            arrayOf(account.name, account.type),
        ).toLong()
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

    /**
     * What the phone gets of a contact: names, phone numbers, email addresses,
     * company and job title. Notes stay in UniHub, since every app allowed to
     * read the phone's contacts could read them.
     */
    class PhoneContact(
        val id: String,
        private val firstName: String,
        private val lastName: String,
        private val phones: List<String>,
        private val emails: List<String>,
        private val company: String,
        private val jobTitle: String,
    ) {
        val hash: String = MessageDigest.getInstance("SHA-256")
            .digest(JSONArray(listOf(FORMAT, firstName, lastName, JSONArray(phones), JSONArray(emails), company, jobTitle)).toString().toByteArray())
            .joinToString("") { "%02x".format(it) }

        fun rows(): List<ContentValues> = buildList {
            if (firstName.isNotEmpty() || lastName.isNotEmpty()) add(data(StructuredName.CONTENT_ITEM_TYPE) {
                put(StructuredName.GIVEN_NAME, firstName.ifEmpty { null })
                put(StructuredName.FAMILY_NAME, lastName.ifEmpty { null })
            })
            // UniHub's vCard export calls every number a mobile number.
            phones.forEach { number -> add(data(Phone.CONTENT_ITEM_TYPE) { put(Phone.NUMBER, number); put(Phone.TYPE, Phone.TYPE_MOBILE) }) }
            emails.forEach { address -> add(data(Email.CONTENT_ITEM_TYPE) { put(Email.ADDRESS, address); put(Email.TYPE, Email.TYPE_OTHER) }) }
            if (company.isNotEmpty() || jobTitle.isNotEmpty()) add(data(Organization.CONTENT_ITEM_TYPE) {
                put(Organization.COMPANY, company.ifEmpty { null })
                put(Organization.TITLE, jobTitle.ifEmpty { null })
                put(Organization.TYPE, Organization.TYPE_WORK)
            })
        }

        private fun data(mime: String, fill: ContentValues.() -> Unit) =
            ContentValues().apply { put(ContactsContract.Data.MIMETYPE, mime); fill() }

        companion object {
            private fun JSONObject.text(name: String): String =
                if (isNull(name)) "" else optString(name).trim().take(MAX_VALUE)

            /** Null for a contact with nothing a phone can show. */
            fun from(json: JSONObject): PhoneContact? {
                val id = json.text("id").takeIf { it.isNotEmpty() } ?: return null
                val contact = PhoneContact(
                    id,
                    json.text("first_name"),
                    json.text("last_name"),
                    listOf("phone", "phone2", "phone3").map { json.text(it) }.filter { it.isNotEmpty() }.distinct(),
                    listOf("email", "email2", "email3").map { json.text(it) }.filter { it.isNotEmpty() }.distinct(),
                    json.text("company"),
                    json.text("job_title"),
                )
                return contact.takeIf { it.rows().isNotEmpty() }
            }
        }
    }

    // ── The server ─────────────────────────────────────────────────────

    // The WebView's cookies for the server, including the session.
    private fun cookie(origin: String): String? =
        CookieManager.getInstance().getCookie(origin)?.takeIf { it.isNotBlank() }

    private class Response(val status: Int, val body: String) {
        fun json(): JSONObject? = try { JSONObject(body) } catch (_: org.json.JSONException) { null }
        fun expectOk() { if (status != 200) throw IOException("HTTP $status") }
    }

    private fun get(origin: String, path: String, session: String): Response {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Cookie", session)
        connection.setRequestProperty("X-Background-Sync", "1")
        connection.setRequestProperty("User-Agent", "UniHubAndroid/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        try {
            val status = connection.responseCode
            // The server extends a session in use and sends its cookie again;
            // the WebView keeps the new expiry.
            connection.headerFields["Set-Cookie"]?.let { cookies ->
                val manager = CookieManager.getInstance()
                cookies.forEach { manager.setCookie(origin, it) }
                manager.flush()
            }
            val stream = (if (status >= 400) connection.errorStream else connection.inputStream)
                ?: return Response(status, "")
            val body = stream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    if (output.size() > MAX_BODY) throw IOException("Answer too large")
                }
                output.toString(Charsets.UTF_8.name())
            }
            return Response(status, body)
        } finally {
            connection.disconnect()
        }
    }
}
