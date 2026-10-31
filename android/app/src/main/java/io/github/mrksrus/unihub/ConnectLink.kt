package io.github.mrksrus.unihub

/** The question an "Open in app" link (unihub://connect) brings. */
object ConnectLink {
    /**
     * The server to ask about when the activity is created, or null. A new
     * start asks about the link's server. Android also recreates the activity
     * from its saved state, with the same starting intent: for a
     * configuration change an app cannot take itself, such as the theme
     * overlays a phone applies a minute or two after it starts (B-33), or
     * after ending the app in the background. That start asks again only
     * about a question still open, so an answered link is not asked twice.
     * The server already in use is never asked about.
     */
    fun toAsk(link: String?, recreated: Boolean, openQuestion: String?, saved: String?): String? =
        (if (recreated) openQuestion else link)?.takeIf { it != saved }
}
