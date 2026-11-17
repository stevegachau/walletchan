package com.walletchan.android

import java.net.URI
import java.net.URLEncoder
import java.util.Locale

/** Pure URL helpers (no android.* imports so they run in JVM unit tests). */
object UrlUtils {
    private val WALLET_SCHEMES = setOf("wc", "walletchan")
    private val SCHEME_RE = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):")
    private val IPV4_RE = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
    private val LABEL_RE = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    private val TLD_RE = Regex("^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$")

    fun schemeOf(url: String): String? =
        SCHEME_RE.find(url.trim())?.groupValues?.get(1)?.lowercase(Locale.ROOT)

    fun isHttpUrl(url: String): Boolean = schemeOf(url).let { it == "http" || it == "https" }

    /** `wc:` (WalletConnect pairing URIs) and `walletchan:` links are handed to the wallet shell. */
    fun isWalletDeepLink(url: String): Boolean = schemeOf(url) in WALLET_SCHEMES

    /**
     * Serialized web origin (`scheme://host[:port]`, default ports omitted) for
     * http(s) URLs, matching how Chromium serializes origins; null otherwise.
     */
    fun originOf(url: String): String? {
        val uri = try { URI(url.trim()) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.lowercase(Locale.ROOT) ?: return null
        val port = uri.port
        val defaultPort = if (scheme == "https") 443 else 80
        return if (port == -1 || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
    }

    fun isAppOrigin(url: String): Boolean = originOf(url) == AppConfig.APP_ORIGIN

    /** True for app-origin URLs the dApp WebView may load as subresources (extension scripts). */
    fun isDappAllowedAppAsset(url: String): Boolean {
        if (!isAppOrigin(url)) return false
        val path = try { URI(url).path } catch (_: Exception) { return false } ?: return false
        return path.startsWith("/static/js/") && !path.contains("..")
    }

    /**
     * Turns URL-bar input into something loadable:
     * - http(s) URLs are kept as-is;
     * - bare hosts (`uniswap.org`, `localhost:3000/x`, `10.0.0.2`) get `https://`
     *   (`http://` for localhost / IPs); `*.eth` names go through the eth.limo gateway;
     * - other schemes (`wc:`, `mailto:`, `intent:` …) are returned untouched for the caller to route;
     * - anything else becomes a DuckDuckGo search.
     * Returns null for blank input.
     */
    fun normalizeUserInput(raw: String): String? {
        val input = raw.trim()
        if (input.isEmpty()) return null
        if (isHttpUrl(input)) return input
        if (!input.any { it.isWhitespace() }) {
            hostLikeUrl(input)?.let { return it }
            // e.g. wc:..., mailto:..., ipfs://... — let the caller decide.
            if (schemeOf(input) != null) return input
        }
        return AppConfig.SEARCH_URL_PREFIX + URLEncoder.encode(input, "UTF-8")
    }

    private fun hostLikeUrl(input: String): String? {
        val end = input.indexOfAny(charArrayOf('/', '?', '#')).let { if (it == -1) input.length else it }
        val authority = input.substring(0, end)
        if (authority.isEmpty() || authority.contains('@')) return null
        val colon = authority.lastIndexOf(':')
        val host = (if (colon >= 0) authority.substring(0, colon) else authority).lowercase(Locale.ROOT)
        if (colon >= 0) {
            val port = authority.substring(colon + 1)
            if (port.isEmpty() || port.length > 5 || !port.all { it.isDigit() }) return null
        }
        val rest = input.substring(end)
        return when {
            host == "localhost" || IPV4_RE.matches(host) -> "http://$authority$rest"
            !isDomainName(host) -> null
            host.endsWith(".eth") -> "https://$host.limo" + (if (colon >= 0) authority.substring(colon) else "") + rest
            else -> "https://$authority$rest"
        }
    }

    private fun isDomainName(host: String): Boolean {
        val labels = host.split('.')
        if (labels.size < 2 || host.length > 253) return false
        if (!labels.all { LABEL_RE.matches(it) }) return false
        return TLD_RE.matches(labels.last())
    }
}
