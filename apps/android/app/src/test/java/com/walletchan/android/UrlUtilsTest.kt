package com.walletchan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlUtilsTest {
    @Test
    fun keepsHttpUrls() {
        assertEquals("https://app.uniswap.org/swap", UrlUtils.normalizeUserInput("  https://app.uniswap.org/swap "))
        assertEquals("HTTP://example.com", UrlUtils.normalizeUserInput("HTTP://example.com"))
    }

    @Test
    fun bareDomainsGetHttps() {
        assertEquals("https://uniswap.org", UrlUtils.normalizeUserInput("uniswap.org"))
        assertEquals("https://app.aave.com/markets?x=1", UrlUtils.normalizeUserInput("app.aave.com/markets?x=1"))
        assertEquals("https://example.com:8443/a", UrlUtils.normalizeUserInput("example.com:8443/a"))
        assertEquals("https://xn--80ak6aa92e.com", UrlUtils.normalizeUserInput("xn--80ak6aa92e.com"))
    }

    @Test
    fun localhostAndIpsGetHttp() {
        assertEquals("http://localhost:3000/x", UrlUtils.normalizeUserInput("localhost:3000/x"))
        assertEquals("http://192.168.1.10:8545", UrlUtils.normalizeUserInput("192.168.1.10:8545"))
    }

    @Test
    fun ensNamesUseGateway() {
        assertEquals("https://vitalik.eth.limo", UrlUtils.normalizeUserInput("vitalik.eth"))
        assertEquals("https://app.vitalik.eth.limo/blog", UrlUtils.normalizeUserInput("app.vitalik.eth/blog"))
    }

    @Test
    fun searchTerms() {
        assertEquals("https://duckduckgo.com/?q=best+dex", UrlUtils.normalizeUserInput("best dex"))
        assertEquals("https://duckduckgo.com/?q=uniswap", UrlUtils.normalizeUserInput("uniswap"))
        assertEquals("https://duckduckgo.com/?q=a%26b%3Dc+d", UrlUtils.normalizeUserInput("a&b=c d"))
        assertEquals("https://duckduckgo.com/?q=foo.notatld1", UrlUtils.normalizeUserInput("foo.notatld1"))
        assertNull(UrlUtils.normalizeUserInput("   "))
    }

    @Test
    fun otherSchemesPassThrough() {
        val wc = "wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=abc"
        assertEquals(wc, UrlUtils.normalizeUserInput(wc))
        assertTrue(UrlUtils.isWalletDeepLink(wc))
        assertTrue(UrlUtils.isWalletDeepLink("walletchan://wc?uri=wc%3Aabc"))
        assertEquals("mailto:a@b.co", UrlUtils.normalizeUserInput("mailto:a@b.co"))
        assertFalse(UrlUtils.isWalletDeepLink("https://wc.example"))
    }

    @Test
    fun origins() {
        assertEquals("https://app.uniswap.org", UrlUtils.originOf("https://App.Uniswap.org/#/swap?x=1"))
        assertEquals("https://a.com", UrlUtils.originOf("https://a.com:443/x"))
        assertEquals("http://a.com:8080", UrlUtils.originOf("http://a.com:8080/x"))
        assertEquals("http://localhost", UrlUtils.originOf("http://localhost:80"))
        assertNull(UrlUtils.originOf("wc:abc@2"))
        assertNull(UrlUtils.originOf("data:text/html,hi"))
        assertTrue(UrlUtils.isAppOrigin("https://appassets.androidplatform.net/android/shell.html"))
        assertFalse(UrlUtils.isAppOrigin("http://appassets.androidplatform.net/android/shell.html"))
        assertFalse(UrlUtils.isAppOrigin("https://appassets.androidplatform.net.evil.com/"))
    }

    @Test
    fun dappMayOnlyReachStaticJs() {
        assertTrue(UrlUtils.isDappAllowedAppAsset("https://appassets.androidplatform.net/static/js/inpage.js"))
        assertFalse(UrlUtils.isDappAllowedAppAsset("https://appassets.androidplatform.net/android/shell.html"))
        assertFalse(UrlUtils.isDappAllowedAppAsset("https://appassets.androidplatform.net/static/js/../../index.html"))
        assertFalse(UrlUtils.isDappAllowedAppAsset("https://evil.com/static/js/inpage.js"))
    }

    @Test
    fun mimeTypes() {
        assertEquals("text/javascript", MimeTypes.forPath("static/js/background.js"))
        assertEquals("application/wasm", MimeTypes.forPath("a/b/prover.WASM"))
        assertEquals("application/octet-stream", MimeTypes.forPath("circuit.zkey"))
        assertEquals("text/html", MimeTypes.forPath("index.html"))
    }
}
