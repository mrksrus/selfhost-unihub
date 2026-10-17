package io.github.mrksrus.unihub

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.app.Service
import android.content.AbstractThreadedSyncAdapter
import android.content.ContentProviderClient
import android.content.Context
import android.content.Intent
import android.content.SyncResult
import android.os.Bundle
import android.os.IBinder
import android.provider.ContactsContract
import android.util.Log

/** Android runs the contact sync (ContactsSync) through this service. */
class ContactsSyncService : Service() {
    private val adapter by lazy { Adapter(applicationContext) }

    override fun onBind(intent: Intent?): IBinder = adapter.syncAdapterBinder

    private class Adapter(context: Context) : AbstractThreadedSyncAdapter(context, true, false) {
        override fun onPerformSync(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, result: SyncResult) {
            // Only Android's own contacts provider receives contacts.
            if (authority != ContactsContract.AUTHORITY || account.type != ContactsSync.ACCOUNT_TYPE) return
            try {
                ContactsSync.sync(context, account, extras, provider, result)
            } catch (_: SecurityException) {
                // The contacts permission was taken back in Android's settings.
                Log.w("UniHubContacts", "No contacts permission")
                result.databaseError = true
            } catch (error: Exception) {
                Log.w("UniHubContacts", "Sync failed: ${error.javaClass.simpleName}")
                result.databaseError = true
            }
        }
    }
}

/**
 * The "UniHub" account type in Android's settings. It holds no password: the
 * sync uses the app's own session. "Add account" there opens the app, which
 * asks before showing contacts on the phone.
 */
class AuthenticatorService : Service() {
    private val authenticator by lazy { Authenticator(this) }

    override fun onBind(intent: Intent?): IBinder? = authenticator.iBinder

    private class Authenticator(private val context: Context) : AbstractAccountAuthenticator(context) {
        override fun addAccount(
            response: AccountAuthenticatorResponse,
            accountType: String,
            authTokenType: String?,
            requiredFeatures: Array<out String>?,
            options: Bundle?,
        ): Bundle = Bundle().apply {
            putParcelable(AccountManager.KEY_INTENT, Intent(context, MainActivity::class.java)
                .setAction(MainActivity.ACTION_SHOW_CONTACTS)
                .putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, response))
        }

        override fun editProperties(response: AccountAuthenticatorResponse, accountType: String): Bundle? = null
        override fun confirmCredentials(response: AccountAuthenticatorResponse, account: Account, options: Bundle?): Bundle? = null
        override fun getAuthToken(response: AccountAuthenticatorResponse, account: Account, authTokenType: String, options: Bundle?): Bundle? = null
        override fun getAuthTokenLabel(authTokenType: String): String? = null
        override fun updateCredentials(response: AccountAuthenticatorResponse, account: Account, authTokenType: String?, options: Bundle?): Bundle? = null
        override fun hasFeatures(response: AccountAuthenticatorResponse, account: Account, features: Array<out String>): Bundle =
            Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false) }
    }
}
