package io.github.mrksrus.unihub

import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract.RawContacts
import android.util.Base64

/**
 * Debug builds only (tools/e2e/android/contacts.test.mjs): sets a phone
 * contact's photo the way a contacts app does, which adb cannot do.
 *
 *   adb shell am broadcast -n io.github.mrksrus.unihub/.TestContactPhoto --el raw <raw contact> --es jpeg <base64>
 */
class TestContactPhoto : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val raw = intent.getLongExtra("raw", -1L).takeIf { it > 0 } ?: return
        val bytes = Base64.decode(intent.getStringExtra("jpeg") ?: return, Base64.DEFAULT)
        val uri = Uri.withAppendedPath(ContentUris.withAppendedId(RawContacts.CONTENT_URI, raw), RawContacts.DisplayPhoto.CONTENT_DIRECTORY)
        val pending = goAsync()
        Thread {
            try {
                context.contentResolver.openAssetFileDescriptor(uri, "rw")?.use { file -> file.createOutputStream().use { it.write(bytes) } }
            } finally {
                pending.finish()
            }
        }.start()
    }
}
