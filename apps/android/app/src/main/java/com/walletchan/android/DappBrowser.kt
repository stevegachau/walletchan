package com.walletchan.android

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * In-app dApp browser: a second WebView with a native top bar, stacked above
 * the wallet WebView (ARCHITECTURE.md "dApp browser"). One tab at a time; each
 * session gets a fresh WebView and a new tabId.
 */
class DappBrowser(
    private val activity: AppCompatActivity,
    private val root: View,
    private val host: Host,
    private val fileChooserHost: FileChooserHost,
) {
    interface Host {
        /** Returns false if the shell isn't ready (message dropped). */
        fun sendToShell(msg: JSONObject): Boolean
        fun onWalletDeepLink(url: String)
        fun showWallet()
        fun onDappVisibilityChanged(visible: Boolean)
    }

    private val webContainer: FrameLayout = root.findViewById(R.id.dapp_web_container)
    private val urlField: EditText = root.findViewById(R.id.dapp_url)
    private val backButton: ImageButton = root.findViewById(R.id.dapp_back)
    private val reloadButton: ImageButton = root.findViewById(R.id.dapp_reload)
    private val progress: ProgressBar = root.findViewById(R.id.dapp_progress)

    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain(AppConfig.APP_HOST)
        .addPathHandler("/static/js/", WwwPathHandler(activity.assets, "static/js/"))
        .build()

    private val injectScript: String? by lazy {
        try {
            activity.assets.open(AppConfig.DAPP_INJECT_ASSET).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            Log.e(AppConfig.LOG_TAG, "${AppConfig.DAPP_INJECT_ASSET} missing; dApps will not see the wallet", e)
            null
        }
    }

    private var nextTabId = AppConfig.FIRST_DAPP_TAB_ID
    private var webView: WebView? = null
    private var replyProxy: JavaScriptReplyProxy? = null
    private var loading = false

    /** Current session's tab id, or null when no session is open. */
    var tabId: Int? = null
        private set

    /** Whether the shell has been told about this tab (first real navigation happened). */
    private var announced = false
    private var lastAnnounced: Triple<String, String, String>? = null

    val isVisible: Boolean get() = root.visibility == View.VISIBLE
    val hasSession: Boolean get() = webView != null

    init {
        root.findViewById<ImageButton>(R.id.dapp_close).setOnClickListener { closeSession() }
        root.findViewById<ImageButton>(R.id.dapp_wallet).setOnClickListener { host.showWallet() }
        backButton.setOnClickListener { goBack() }
        reloadButton.setOnClickListener {
            val wv = webView ?: return@setOnClickListener
            if (loading) wv.stopLoading() else wv.reload()
        }
        urlField.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                submitUrlField()
                true
            } else false
        }
        updateToolbar()
    }

    // ---- Public API (driven by MainActivity / shell commands) ----

    /** `openDapp`: show the browser and load [url] if given, else focus the URL field. */
    fun open(url: String?) {
        ensureSession()
        show()
        if (url.isNullOrBlank()) {
            focusUrlField()
        } else {
            navigate(url)
        }
    }

    fun show() {
        if (!hasSession) return
        if (isVisible) return
        root.visibility = View.VISIBLE
        host.onDappVisibilityChanged(true)
    }

    fun hide() {
        if (!isVisible) return
        hideKeyboard()
        urlField.clearFocus()
        root.visibility = View.GONE
        host.onDappVisibilityChanged(false)
    }

    /** Back inside the browser. Returns false when there is no history to go back to. */
    fun goBack(): Boolean {
        val wv = webView ?: return false
        if (!wv.canGoBack()) return false
        wv.goBack()
        return true
    }

    /** `toDapp`: deliver a payload to the current page's `WalletChanDapp` bridge. */
    @SuppressLint("RequiresFeature") // checked in MainActivity before any WebView exists
    fun deliver(targetTabId: Int, payloadJson: String) {
        if (targetTabId != tabId) {
            Log.w(AppConfig.LOG_TAG, "toDapp for stale tab $targetTabId (current $tabId) dropped")
            return
        }
        val proxy = replyProxy ?: run {
            Log.w(AppConfig.LOG_TAG, "toDapp before the page registered its bridge; dropped")
            return
        }
        try {
            proxy.postMessage(payloadJson)
        } catch (e: Exception) {
            Log.w(AppConfig.LOG_TAG, "toDapp postMessage failed: ${e.message}")
        }
    }

    /** Ends the session: destroys the WebView and reports `dappTabRemoved`. */
    fun closeSession() {
        val wv = webView ?: run { hide(); return }
        val closedTab = tabId
        hide()
        webView = null
        replyProxy = null
        tabId = null
        loading = false
        webContainer.removeView(wv)
        wv.stopLoading()
        wv.destroy()
        if (announced && closedTab != null) {
            host.sendToShell(JSONObject().put("type", "dappTabRemoved").put("tabId", closedTab))
        }
        announced = false
        lastAnnounced = null
        urlField.setText("")
        updateToolbar()
    }

    /** Re-announce state after the shell (re)loaded. */
    fun onShellReady() {
        host.sendToShell(JSONObject().put("type", "dappVisible").put("visible", isVisible))
        if (announced) {
            lastAnnounced = null
            announceTab()
        }
    }

    fun destroy() {
        webView?.let { webContainer.removeView(it); it.destroy() }
        webView = null
    }

    // ---- Session / WebView ----

    private fun ensureSession(): WebView {
        webView?.let { return it }
        val wv = createWebView()
        webView = wv
        tabId = nextTabId++
        announced = false
        lastAnnounced = null
        webContainer.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        updateToolbar()
        return wv
    }

    @SuppressLint("RequiresFeature") // feature support is checked in MainActivity before any WebView exists
    private fun createWebView(): WebView {
        val wv = WebView(activity)
        WebViews.applySecureDefaults(wv)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
        injectScript?.let { WebViewCompat.addDocumentStartJavaScript(wv, it, setOf("*")) }
        WebViewCompat.addWebMessageListener(wv, AppConfig.DAPP_BRIDGE, setOf("*"), DappListener())
        wv.webViewClient = DappClient()
        wv.webChromeClient = object : AppChromeClient(AppConfig.LOG_TAG + "-dapp", fileChooserHost, { url, gesture ->
            // Single tab: popups / target=_blank open in place.
            handleNavigation(url, isMainFrame = true, hasGesture = gesture)
        }) {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (view !== webView) return
                progress.progress = newProgress
                progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.INVISIBLE
            }

            override fun onReceivedTitle(view: WebView, title: String?) {
                if (view === webView) announceTab()
            }
        }
        wv.setDownloadListener { url, _, _, _, _ -> ExternalLinks.openInBrowser(activity, url) }
        return wv
    }

    private inner class DappListener : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            proxy: JavaScriptReplyProxy,
        ) {
            if (view !== webView || !isMainFrame) return
            val origin = sourceOrigin.toString()
            val pageUrl = view.url ?: return
            // origin/url come from native only, and must agree (drops messages racing a navigation).
            if (!UrlUtils.isHttpUrl(origin) || UrlUtils.originOf(pageUrl) != origin) {
                Log.w(AppConfig.LOG_TAG, "WalletChanDapp: origin mismatch ($origin vs $pageUrl); dropped")
                return
            }
            replyProxy = proxy
            val msg = try {
                JSONObject(message.data ?: return)
            } catch (_: Exception) {
                return
            }
            // A message without `message` just registers the page's reply channel.
            if (!msg.has("message")) return
            if (!announced) announceTab()
            host.sendToShell(
                JSONObject()
                    .put("type", "dappMessage")
                    .put("tabId", tabId)
                    .put("url", pageUrl)
                    .put("origin", origin)
                    .put("title", view.title ?: "")
                    .put("requestId", msg.opt("requestId") ?: JSONObject.NULL)
                    .put("message", msg.opt("message") ?: JSONObject.NULL),
            )
        }
    }

    private inner class DappClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url.toString()
            if (request.url.host != AppConfig.APP_HOST) return null
            // Only extension scripts are reachable from dApp pages; everything else on our origin is 404.
            if (!UrlUtils.isDappAllowedAppAsset(url)) {
                return WebResourceResponse(
                    "text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)),
                )
            }
            return assetLoader.shouldInterceptRequest(request.url)
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            !handleNavigation(request.url.toString(), request.isForMainFrame, request.hasGesture(), loadIt = false)

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view !== webView) return
            loading = true
            updateToolbar()
            if (url != null && UrlUtils.isAppOrigin(url)) {
                view.stopLoading()
                return
            }
            announceTab()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView) return
            loading = false
            updateToolbar()
            announceTab()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            if (view !== webView) return
            updateToolbar()
            announceTab()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(AppConfig.LOG_TAG, "dApp renderer gone (crash=${detail.didCrash()})")
            if (view === webView) closeSession() else view.destroy()
            return true
        }
    }

    /**
     * Routes a navigation. Returns true if the WebView should proceed with it itself
     * (only meaningful when [loadIt] is false, i.e. from shouldOverrideUrlLoading).
     */
    private fun handleNavigation(url: String, isMainFrame: Boolean, hasGesture: Boolean, loadIt: Boolean = true): Boolean {
        when {
            UrlUtils.isHttpUrl(url) -> {
                if (UrlUtils.isAppOrigin(url)) {
                    Log.w(AppConfig.LOG_TAG, "dApp navigation to the app origin blocked")
                    return false
                }
                if (loadIt) webView?.loadUrl(url)
                return true
            }
            UrlUtils.isWalletDeepLink(url) -> {
                if (isMainFrame || hasGesture) host.onWalletDeepLink(url)
                return false
            }
            url.startsWith("about:") || url.startsWith("data:") || url.startsWith("blob:") -> return !loadIt
            else -> {
                if (isMainFrame || hasGesture) {
                    ExternalLinks.launchNonHttp(activity, url) { fallback -> webView?.loadUrl(fallback) }
                }
                return false
            }
        }
    }

    private fun navigate(input: String) {
        val url = UrlUtils.normalizeUserInput(input) ?: return
        ensureSession()
        hideKeyboard()
        urlField.clearFocus()
        handleNavigation(url, isMainFrame = true, hasGesture = true)
    }

    private fun submitUrlField() = navigate(urlField.text.toString())

    private fun announceTab() {
        val wv = webView ?: return
        val id = tabId ?: return
        val url = wv.url ?: return
        if (!UrlUtils.isHttpUrl(url)) return
        val title = wv.title ?: ""
        val status = if (loading) "loading" else "complete"
        val state = Triple(url, title, status)
        if (state == lastAnnounced) return
        lastAnnounced = state
        announced = true
        host.sendToShell(
            JSONObject().put("type", "dappTab").put("tabId", id).put("url", url).put("title", title).put("status", status),
        )
    }

    private fun updateToolbar() {
        val wv = webView
        backButton.isEnabled = wv?.canGoBack() == true
        backButton.alpha = if (backButton.isEnabled) 1f else 0.4f
        reloadButton.setImageResource(if (loading) R.drawable.ic_close else R.drawable.ic_refresh)
        reloadButton.contentDescription = activity.getString(if (loading) R.string.dapp_stop else R.string.dapp_reload)
        if (!urlField.hasFocus()) {
            val url = wv?.url
            urlField.setText(if (url != null && UrlUtils.isHttpUrl(url)) url else "")
        }
    }

    private fun focusUrlField() {
        urlField.requestFocus()
        urlField.selectAll()
        urlField.post {
            activity.getSystemService(InputMethodManager::class.java)
                ?.showSoftInput(urlField, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun hideKeyboard() {
        activity.getSystemService(InputMethodManager::class.java)
            ?.hideSoftInputFromWindow(urlField.windowToken, 0)
    }
}
