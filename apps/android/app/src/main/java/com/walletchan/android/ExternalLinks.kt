package com.walletchan.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.core.net.toUri

/** Hands URLs the app can't (or shouldn't) render itself to other apps, defensively. */
object ExternalLinks {
    private val BLOCKED_SCHEMES = setOf(
        "file", "content", "javascript", "data", "blob", "about", "chrome", "android-app",
        "filesystem", "jar",
    )

    /** `openExternal`: system browser / mail client only. */
    fun openInBrowser(activity: Activity, url: String): Boolean {
        val scheme = UrlUtils.schemeOf(url)
        if (scheme != "http" && scheme != "https" && scheme != "mailto") {
            Log.w(AppConfig.LOG_TAG, "openExternal refused for scheme $scheme")
            return false
        }
        return start(activity, Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
    }

    /**
     * Opens a non-http(s) link (e.g. `intent:`, `tg:`, `mailto:`, `market:`) in another app.
     * For `intent:` URIs the component/selector are stripped and the BROWSABLE category is
     * forced, like Chrome does; `browser_fallback_url` is passed to [onFallbackUrl].
     */
    fun launchNonHttp(activity: Activity, url: String, onFallbackUrl: (String) -> Unit): Boolean {
        val scheme = UrlUtils.schemeOf(url) ?: return false
        if (scheme in BLOCKED_SCHEMES || scheme == "http" || scheme == "https") return false
        if (scheme == "intent") {
            val intent = try {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            } catch (e: Exception) {
                Log.w(AppConfig.LOG_TAG, "Bad intent: URI", e)
                return false
            }
            intent.addCategory(Intent.CATEGORY_BROWSABLE)
            intent.component = null
            intent.selector = null
            intent.flags = intent.flags and (
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                ).inv()
            if (intent.data?.scheme?.lowercase() in BLOCKED_SCHEMES) return false
            if (start(activity, intent, toastOnFailure = false)) return true
            val fallback = intent.getStringExtra("browser_fallback_url")
            if (fallback != null && UrlUtils.isHttpUrl(fallback)) {
                onFallbackUrl(fallback)
                return true
            }
            val pkg = intent.`package`
            if (pkg != null && start(
                    activity,
                    Intent(Intent.ACTION_VIEW, ("market://details?id=" + Uri.encode(pkg)).toUri())
                        .addCategory(Intent.CATEGORY_BROWSABLE),
                    toastOnFailure = false,
                )
            ) return true
            toastNoApp(activity)
            return false
        }
        return start(activity, Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
    }

    private fun start(activity: Activity, intent: Intent, toastOnFailure: Boolean = true): Boolean = try {
        activity.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        if (toastOnFailure) toastNoApp(activity)
        false
    } catch (e: SecurityException) {
        Log.w(AppConfig.LOG_TAG, "Not allowed to start $intent", e)
        false
    }

    private fun toastNoApp(activity: Activity) {
        Toast.makeText(activity, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
    }
}
