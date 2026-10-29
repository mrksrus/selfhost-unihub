package io.github.mrksrus.unihub

import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import java.io.FileNotFoundException

/**
 * Serves the copies FileActions makes (for other apps and for the page's file
 * input) and refuses one older than SharedFiles.MAX_AGE_MS, even before the
 * next cleanup deletes it.
 */
class FilesProvider : FileProvider() {
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val context = context ?: throw FileNotFoundException("No context")
        val file = FileActions.cachedFile(context, uri)
        if (file == null || !file.isFile || SharedFiles.stale(file.lastModified(), System.currentTimeMillis())) {
            throw FileNotFoundException("Expired or unknown file")
        }
        return super.openFile(uri, mode)
    }
}
