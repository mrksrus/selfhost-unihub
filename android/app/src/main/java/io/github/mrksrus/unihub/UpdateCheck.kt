package io.github.mrksrus.unihub

/**
 * Whether a downloaded APK may be handed to Android's installer as UniHub's
 * update (AppUpdate), without Android classes so the JVM tests can run it.
 * Android itself refuses an update of this app signed with another key, but
 * not an unrelated app with its own package name: with the install
 * permission UniHub holds, a server that served one would install it.
 */
object UpdateCheck {
    /** What AppUpdate reads from an APK: signers are SHA-256 digests of the signing certificates. */
    data class Apk(val packageName: String, val versionCode: Long, val signers: Set<String>)

    enum class Refusal {
        /** Not an APK Android can read, or without signers. */
        UNREADABLE,
        /** Another app, or this app signed with another key. */
        NOT_UNIHUB,
        /** An older app than the installed one. */
        OLDER,
    }

    /**
     * Null when [update] is this app ([installed]) by the same signers in a
     * version not older than the installed one. The update must carry every
     * certificate of the installed app: its signer, or with a rotated key
     * the lineage that includes it.
     */
    fun refusal(installed: Apk, update: Apk?): Refusal? = when {
        update == null || update.signers.isEmpty() -> Refusal.UNREADABLE
        update.packageName != installed.packageName -> Refusal.NOT_UNIHUB
        installed.signers.isEmpty() || !update.signers.containsAll(installed.signers) -> Refusal.NOT_UNIHUB
        update.versionCode < installed.versionCode -> Refusal.OLDER
        else -> null
    }
}
