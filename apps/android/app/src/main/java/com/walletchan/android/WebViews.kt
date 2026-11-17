package com.walletchan.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/** Shared WebView configuration. */
object WebViews {
    @SuppressLint("SetJavaScriptEnabled")
    fun applySecureDefaults(webView: WebView) {
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.setGeolocationEnabled(false)
        s.mediaPlaybackRequiresUserGesture = true
        s.javaScriptCanOpenWindowsAutomatically = false
        // window.open / target=_blank go through onCreateWindow and are re-routed.
        s.setSupportMultipleWindows(true)
        s.safeBrowsingEnabled = true
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            WebSettingsCompat.setSafeBrowsingEnabled(s, true)
        }
    }
}

/** Activity hooks needed by [AppChromeClient]. */
interface FileChooserHost {
    fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean
}

/**
 * Console → logcat, file chooser, popup re-routing, and deny-by-default for
 * device permissions (camera/mic/location) requested by web content.
 */
open class AppChromeClient(
    private val logTag: String,
    private val fileChooserHost: FileChooserHost,
    private val onPopupUrl: (url: String, userGesture: Boolean) -> Unit,
) : WebChromeClient() {

    override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
        val text = "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})"
        when (msg.messageLevel()) {
            ConsoleMessage.MessageLevel.ERROR -> Log.e(logTag, text)
            ConsoleMessage.MessageLevel.WARNING -> Log.w(logTag, text)
            ConsoleMessage.MessageLevel.DEBUG, ConsoleMessage.MessageLevel.TIP -> Log.d(logTag, text)
            else -> Log.i(logTag, text)
        }
        return true
    }

    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean = fileChooserHost.showFileChooser(filePathCallback, fileChooserParams)

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        PopupCatcher.capture(view.context, resultMsg) { url -> onPopupUrl(url, isUserGesture) }
        return true
    }

    override fun onPermissionRequest(request: PermissionRequest) {
        Log.i(logTag, "Denied web permission request ${request.resources.joinToString()} from ${request.origin}")
        request.deny()
    }

    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
        callback.invoke(origin, false, false)
    }
}

/**
 * window.open() needs a WebView to navigate. We hand WebView a throwaway one,
 * grab the first URL it tries to load, and destroy it.
 */
private object PopupCatcher {
    private const val ABANDON_AFTER_MS = 15_000L

    fun capture(context: Context, resultMsg: Message, onUrl: (String) -> Unit) {
        val temp = WebView(context)
        var done = false
        val handler = Handler(Looper.getMainLooper())
        fun finish(url: String?) {
            if (done) return
            done = true
            if (url != null) onUrl(url)
            handler.post { temp.stopLoading(); temp.destroy() }
        }
        temp.settings.javaScriptEnabled = false
        temp.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                finish(request.url.toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (url != null && url != "about:blank") finish(url)
            }
        }
        handler.postDelayed({ finish(null) }, ABANDON_AFTER_MS)
        (resultMsg.obj as WebView.WebViewTransport).webView = temp
        resultMsg.sendToTarget()
    }
}
