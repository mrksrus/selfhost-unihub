package io.github.mrksrus.unihub

/**
 * The files a picker returned to a page's file input. A picker that allows
 * several files (the input has `multiple`) returns them in the intent's
 * ClipData, which FileChooserParams.parseResult ignores: it reads only the
 * intent's data, so nothing was attached. Kept free of Android classes so the
 * JVM tests can run it.
 */
object PickedFiles {
    /** All picked items without repeats, or null (cancel) when the picker returned none. */
    fun <T : Any> collect(resultOk: Boolean, single: T?, clip: List<T?>): List<T>? {
        if (!resultOk) return null
        return (listOfNotNull(single) + clip.filterNotNull()).distinct().ifEmpty { null }
    }
}
