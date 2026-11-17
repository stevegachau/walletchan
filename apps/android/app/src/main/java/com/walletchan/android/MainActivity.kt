package com.walletchan.android

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

/**
 * Hosts the wallet (main WebView running the extension via the JS shell) and the
 * dApp browser in one FrameLayout. singleTask + configChanges keep both WebViews
 * (and therefore the wallet "service worker") alive across rotation, theme
 * changes, scanner round-trips and app switches. See ARCHITECTURE.md.
 */
class MainActivity : AppCompatActivity(), ShellBridge.Host, DappBrowser.Host, FileChooserHost {

    private var mainWebView: WebView? = null
    private lateinit var walletContainer: FrameLayout
    private lateinit var shellBridge: ShellBridge
    private lateinit var dapp: DappBrowser
    private lateinit var http: HttpBridge
    private lateinit var notifier: Notifier
    private var errorShown = false

    /** Deep links received before the shell said hello: (url, source). */
    private val pendingDeepLinks = ArrayDeque<Pair<String, String>>()
    private val pendingNotifications = ArrayDeque<Triple<String, String, String>>()
    private var notificationPermissionAsked = false
    private var qrInFlight = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(AppConfig.APP_HOST)
            .addPathHandler("/", WwwPathHandler(assets))
            .build()
    }

    // ---- Activity result launchers (registered before STARTED) ----

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val queued = pendingNotifications.toList()
            pendingNotifications.clear()
            if (granted) queued.forEach { (id, title, message) -> notifier.post(id, title, message) }
        }

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) launchScanner() else finishQr(null, "permission_denied")
        }

    private val scanner = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        when {
            result.contents != null -> finishQr(result.contents, null)
            result.originalIntent?.hasExtra(com.google.zxing.client.android.Intents.Scan.MISSING_CAMERA_PERMISSION) == true ->
                finishQr(null, "permission_denied")
            else -> finishQr(null, "cancelled")
        }
    }

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
            fileCallback = null
        }

    // ---- Lifecycle ----

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AppConfig.SECURE_SCREEN) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        }
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        setContentView(R.layout.activity_main)
        applyWindowInsets(findViewById(R.id.root))
        walletContainer = findViewById(R.id.wallet_container)

        onBackPressedDispatcher.addCallback(this) { handleBack() }

        val missing = missingWebViewFeatures()
        if (missing != null) {
            showWebViewError(missing)
            return
        }

        notifier = Notifier(this)
        http = HttpBridge(safeDefaultUserAgent())
        val packageInfo = packageManager.getPackageInfo(packageName, 0)
        shellBridge = ShellBridge(
            host = this,
            http = http,
            appVersion = packageInfo.versionName ?: "",
            appVersionCode = PackageInfoCompat.getLongVersionCode(packageInfo),
        )
        dapp = DappBrowser(this, findViewById(R.id.dapp_root), this, this)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        try {
            createMainWebView()
        } catch (e: Exception) {
            // e.g. WebView provider missing or being updated.
            Log.e(AppConfig.LOG_TAG, "Could not create WebView", e)
            showWebViewError(e.message ?: e.javaClass.simpleName)
            return
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!errorShown) handleIntent(intent)
    }

    override fun onDestroy() {
        if (!errorShown && ::dapp.isInitialized) {
            dapp.destroy()
            mainWebView?.let { walletContainer.removeView(it); it.destroy() }
            mainWebView = null
            http.shutdown()
        }
        super.onDestroy()
    }

    // Deliberately no onPause/onResume WebView handling: the wallet background runs in
    // the main WebView and must keep its timers; returning to the app never reloads.

    // ---- Main WebView ----

    private fun createMainWebView() {
        val wv = WebView(this)
        WebViews.applySecureDefaults(wv)
        wv.setBackgroundColor(ContextCompat.getColor(this, R.color.wc_background))
        // Keep the wallet renderer important even while covered by the dApp browser.
        wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        shellBridge.install(wv)
        wv.webViewClient = MainClient()
        wv.webChromeClient = AppChromeClient(AppConfig.JS_LOG_TAG, this) { url, _ -> routeFromWallet(url) }
        wv.setDownloadListener { url, _, _, _, _ -> if (UrlUtils.isHttpUrl(url)) ExternalLinks.openInBrowser(this, url) }
        walletContainer.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        mainWebView = wv
        wv.loadUrl(AppConfig.SHELL_URL)
    }

    private fun recreateMainWebView() {
        shellBridge.reset()
        mainWebView?.let { walletContainer.removeView(it); it.destroy() }
        mainWebView = null
        createMainWebView()
    }

    private inner class MainClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (UrlUtils.isAppOrigin(url)) return false
            if (!request.isForMainFrame) {
                // Sub-frames may load web content (CSP permitting) but never launch other schemes.
                return !UrlUtils.isHttpUrl(url)
            }
            // The wallet's top frame never leaves the app origin.
            routeFromWallet(url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url == null || url == "about:blank" || UrlUtils.isAppOrigin(url)) return
            // Navigations that bypassed shouldOverrideUrlLoading (e.g. form POSTs).
            Log.w(AppConfig.LOG_TAG, "Main WebView left the app origin ($url); restoring shell")
            view.stopLoading()
            shellBridge.reset()
            view.loadUrl(AppConfig.SHELL_URL)
            if (UrlUtils.isHttpUrl(url)) openDapp(url)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(AppConfig.LOG_TAG, "Wallet renderer gone (crash=${detail.didCrash()}); recreating")
            if (view === mainWebView) {
                dapp.closeSession()
                recreateMainWebView()
            } else {
                view.destroy()
            }
            return true
        }
    }

    /** Where links leaving the wallet go: web → dApp browser, wc:/walletchan: → shell, else other apps. */
    private fun routeFromWallet(url: String) {
        when {
            UrlUtils.isAppOrigin(url) -> Log.w(AppConfig.LOG_TAG, "Ignoring popup to app origin: $url")
            UrlUtils.isHttpUrl(url) -> openDapp(url)
            UrlUtils.isWalletDeepLink(url) -> deliverDeepLink(url, DEEP_LINK_SOURCE_WALLET)
            else -> ExternalLinks.launchNonHttp(this, url) { fallback -> openDapp(fallback) }
        }
    }

    // ---- ShellBridge.Host ----

    override fun onShellReady() {
        dapp.onShellReady()
        while (pendingDeepLinks.isNotEmpty()) {
            val (url, source) = pendingDeepLinks.removeFirst()
            sendDeepLink(url, source)
        }
    }

    override fun openExternal(url: String) {
        ExternalLinks.openInBrowser(this, url)
    }

    override fun openDapp(url: String?) {
        if (url != null && !UrlUtils.isHttpUrl(url)) {
            routeFromWallet(url)
            return
        }
        dapp.open(url)
    }

    override fun showWallet() {
        dapp.hide()
    }

    override fun showDapp() {
        dapp.show()
    }

    override fun toDapp(tabId: Int, payloadJson: String) {
        dapp.deliver(tabId, payloadJson)
    }

    override fun closeDapp(tabId: Int) {
        if (tabId == dapp.tabId) dapp.closeSession()
    }

    override fun notify(id: String, title: String, message: String) {
        if (notifier.hasPermission()) {
            notifier.post(id, title, message)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationPermissionAsked) {
            notificationPermissionAsked = true
            if (pendingNotifications.size < 20) pendingNotifications.addLast(Triple(id, title, message))
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            Log.i(AppConfig.LOG_TAG, "Notification '$id' dropped: permission not granted")
        }
    }

    override fun backUnhandled() {
        moveTaskToBack(true)
    }

    override fun scanQr() {
        if (qrInFlight) {
            sendQrResult(null, "busy")
            return
        }
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            sendQrResult(null, "no_camera")
            return
        }
        qrInFlight = true
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchScanner() {
        val options = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt(getString(R.string.qr_prompt))
            .setBeepEnabled(false)
            .setBarcodeImageEnabled(false)
            .setOrientationLocked(true)
            .setCaptureActivity(QrScanActivity::class.java)
        try {
            scanner.launch(options)
        } catch (e: ActivityNotFoundException) {
            finishQr(null, "cancelled")
        }
    }

    private fun finishQr(text: String?, error: String?) {
        qrInFlight = false
        sendQrResult(text, error)
    }

    private fun sendQrResult(text: String?, error: String?) {
        val msg = JSONObject().put("type", "qrResult").put("text", text ?: JSONObject.NULL)
        if (error != null) msg.put("error", error)
        if (!shellBridge.sendToShell(msg)) Log.w(AppConfig.LOG_TAG, "qrResult dropped: shell not ready")
    }

    // ---- DappBrowser.Host ----

    override fun sendToShell(msg: JSONObject): Boolean = shellBridge.sendToShell(msg)

    override fun onWalletDeepLink(url: String) = deliverDeepLink(url, DEEP_LINK_SOURCE_DAPP)

    override fun onDappVisibilityChanged(visible: Boolean) {
        // The wallet WebView stays VISIBLE underneath (so Chromium doesn't throttle the
        // background); just hide it from accessibility while covered.
        walletContainer.importantForAccessibility =
            if (visible) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        if (!visible) mainWebView?.requestFocus()
        shellBridge.sendToShell(JSONObject().put("type", "dappVisible").put("visible", visible))
    }

    // ---- FileChooserHost ----

    override fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        try {
            fileChooser.launch(params.createIntent())
        } catch (e: ActivityNotFoundException) {
            fileCallback = null
            callback.onReceiveValue(null)
        }
        return true
    }

    // ---- Back / deep links ----

    private fun handleBack() {
        when {
            errorShown -> finish()
            dapp.isVisible -> if (!dapp.goBack()) dapp.closeSession()
            !shellBridge.sendToShell(JSONObject().put("type", "back")) -> moveTaskToBack(true)
        }
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null || intent.action != Intent.ACTION_VIEW) return
        // Relaunch from Recents replays the original intent; don't re-pair an old link.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val url = intent.dataString ?: return
        // Opened by another app (e.g. a dApp in Chrome handing off a WalletConnect
        // request): the shell sends the user back there once the request is handled.
        if (UrlUtils.isWalletDeepLink(url)) deliverDeepLink(url, DEEP_LINK_SOURCE_EXTERNAL)
    }

    /**
     * `source` tells the shell who opened the link: "external" (another app via an
     * intent), "dapp" (the in-app dApp browser) or "wallet" (the wallet UI itself).
     */
    private fun deliverDeepLink(url: String, source: String) {
        if (shellBridge.isShellReady) {
            sendDeepLink(url, source)
        } else if (pendingDeepLinks.size < 10) {
            pendingDeepLinks.addLast(url to source)
        }
    }

    private fun sendDeepLink(url: String, source: String) {
        val msg = JSONObject().put("type", "deepLink").put("url", url).put("source", source)
        if (shellBridge.sendToShell(msg)) {
            showWallet()
        } else {
            pendingDeepLinks.addFirst(url to source)
        }
    }

    // ---- Window / errors ----

    private fun applyWindowInsets(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    /** Null when everything we need is available, else a human-readable reason. */
    private fun missingWebViewFeatures(): String? {
        val pkg = try {
            WebViewCompat.getCurrentWebViewPackage(this)
        } catch (e: Exception) {
            null
        } ?: return getString(R.string.webview_missing)
        val missing = listOf(WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)
            .filterNot { WebViewFeature.isFeatureSupported(it) }
        if (missing.isEmpty()) return null
        return getString(R.string.webview_outdated, pkg.packageName, pkg.versionName ?: "?", missing.joinToString())
    }

    private fun showWebViewError(details: String) {
        errorShown = true
        findViewById<View>(R.id.dapp_root).visibility = View.GONE
        walletContainer.visibility = View.GONE
        findViewById<View>(R.id.error_root).visibility = View.VISIBLE
        findViewById<android.widget.TextView>(R.id.error_details).text = details
        findViewById<View>(R.id.error_update_button).setOnClickListener {
            val market = Intent(Intent.ACTION_VIEW, "market://details?id=com.google.android.webview".toUri())
            try {
                startActivity(market)
            } catch (e: ActivityNotFoundException) {
                ExternalLinks.openInBrowser(
                    this,
                    "https://play.google.com/store/apps/details?id=com.google.android.webview",
                )
            }
        }
    }

    private fun safeDefaultUserAgent(): String? = try {
        WebSettings.getDefaultUserAgent(this)
    } catch (e: Exception) {
        null
    }
}

private const val DEEP_LINK_SOURCE_EXTERNAL = "external"
private const val DEEP_LINK_SOURCE_DAPP = "dapp"
private const val DEEP_LINK_SOURCE_WALLET = "wallet"
