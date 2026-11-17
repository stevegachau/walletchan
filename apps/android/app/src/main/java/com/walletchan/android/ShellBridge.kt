package com.walletchan.android

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONObject

/**
 * `WalletChanNative` — the main WebView's bridge (ARCHITECTURE.md "Native bridge").
 * Installed only for [AppConfig.APP_ORIGIN]; every message is a JSON string.
 */
class ShellBridge(
    private val host: Host,
    private val http: HttpBridge,
    private val appVersion: String,
    private val appVersionCode: Long,
    private val biometrics: BiometricUnlock,
    private val session: SessionStore = ProcessSessionStore,
) : WebViewCompat.WebMessageListener {

    interface Host {
        fun onShellReady()
        fun openExternal(url: String)
        fun openDapp(url: String?)
        fun showWallet()
        fun showDapp()
        fun toDapp(tabId: Int, payloadJson: String)
        fun closeDapp(tabId: Int)
        fun notify(id: String, title: String, message: String)
        fun backUnhandled()
        fun scanQr()
        fun wcSessions(count: Int)
        fun requestAttention(title: String, message: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private var shellProxy: JavaScriptReplyProxy? = null

    val isShellReady: Boolean get() = shellProxy != null

    @SuppressLint("RequiresFeature") // MainActivity checks WEB_MESSAGE_LISTENER before creating any WebView
    fun install(webView: WebView) {
        WebViewCompat.addWebMessageListener(webView, AppConfig.NATIVE_BRIDGE, setOf(AppConfig.APP_ORIGIN), this)
    }

    /** Forget the shell channel (main WebView reloaded / recreated). */
    fun reset() {
        shellProxy = null
        // A biometric result belongs to the document that asked; never hand it to a new one.
        biometrics.abandon()
    }

    /** Sends a message to the shell top frame. Returns false if the shell hasn't said hello yet. */
    fun sendToShell(msg: JSONObject): Boolean {
        val proxy = shellProxy ?: return false
        return post(proxy, msg.toString())
    }

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        // Belt and braces: the allowed-origin rule already restricts this.
        if (sourceOrigin.toString() != AppConfig.APP_ORIGIN) return
        val msg = try {
            JSONObject(message.data ?: return)
        } catch (e: Exception) {
            Log.w(AppConfig.LOG_TAG, "WalletChanNative: non-JSON message ignored")
            return
        }
        try {
            dispatch(msg, isMainFrame, replyProxy)
        } catch (e: Exception) {
            Log.e(AppConfig.LOG_TAG, "WalletChanNative: '${msg.optString("cmd")}' failed", e)
        }
    }

    private fun dispatch(msg: JSONObject, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        when (val cmd = msg.optString("cmd")) {
            "hello" -> {
                if (!isMainFrame) {
                    Log.w(AppConfig.LOG_TAG, "hello from a sub-frame ignored")
                    return
                }
                shellProxy = replyProxy
                // A (re)booted shell document: any prompt for the previous one is moot.
                biometrics.abandon()
                post(
                    replyProxy,
                    JSONObject()
                        .put("type", "hello")
                        .put("sdkInt", Build.VERSION.SDK_INT)
                        .put("appVersion", appVersion)
                        .put("appVersionCode", appVersionCode)
                        .put("debug", BuildConfig.DEBUG)
                        .put("freshProcess", session.takeFreshProcess())
                        .put("session", session.snapshotJson())
                        .toString(),
                )
                host.onShellReady()
            }
            "sessionStore" -> {
                if (!isMainFrame) {
                    Log.w(AppConfig.LOG_TAG, "sessionStore from a sub-frame ignored")
                    return
                }
                // Never log keys or values: this holds unlocked-session material.
                val result = session.apply(msg)
                if (result != SessionStore.Result.OK) {
                    Log.w(AppConfig.LOG_TAG, "sessionStore '${msg.optString("op")}' rejected: $result")
                }
            }
            in BiometricUnlock.COMMANDS -> {
                if (!isMainFrame) {
                    Log.w(AppConfig.LOG_TAG, "$cmd from a sub-frame ignored")
                    return
                }
                // Replies (an unlock carries the password) go only to the asking frame. Never logged.
                biometrics.handle(cmd, msg) { reply -> post(replyProxy, reply.toString()) }
            }
            "wcSessions" -> host.wcSessions(msg.optInt("count", 0).coerceIn(0, MAX_WC_SESSIONS))
            "requestAttention" -> host.requestAttention(
                msg.optString("title", "").take(MAX_TITLE_CHARS).ifBlank { "WalletChan" },
                msg.optString("message", "").take(MAX_MESSAGE_CHARS),
            )
            "http" -> http.execute(msg) { json -> main.post { post(replyProxy, json) } }
            "httpAbort" -> http.abort(msg.opt("id"))
            "openExternal" -> msg.optStringOrNull("url")?.let(host::openExternal)
            "openDapp" -> host.openDapp(msg.optStringOrNull("url"))
            "showWallet" -> host.showWallet()
            "showDapp" -> host.showDapp()
            "toDapp" -> host.toDapp(msg.optInt("tabId", -1), JsonUtils.valueToJson(msg.opt("payload")))
            "closeDapp" -> host.closeDapp(msg.optInt("tabId", -1))
            "notify" -> host.notify(
                msg.optStringOrNull("id") ?: "wc-${System.currentTimeMillis()}",
                msg.optString("title", "WalletChan"),
                msg.optString("message", ""),
            )
            "backUnhandled" -> host.backUnhandled()
            "scanQr" -> host.scanQr()
            "log" -> log(msg.optString("level", "info"), msg.optString("message", ""))
            else -> Log.w(AppConfig.LOG_TAG, "WalletChanNative: unknown cmd '$cmd'")
        }
    }

    private fun log(level: String, message: String) {
        when (level.lowercase()) {
            "error" -> Log.e(AppConfig.JS_LOG_TAG, message)
            "warn", "warning" -> Log.w(AppConfig.JS_LOG_TAG, message)
            "debug" -> Log.d(AppConfig.JS_LOG_TAG, message)
            else -> Log.i(AppConfig.JS_LOG_TAG, message)
        }
    }

    @SuppressLint("RequiresFeature") // see install()
    private fun post(proxy: JavaScriptReplyProxy, json: String): Boolean = try {
        proxy.postMessage(json)
        true
    } catch (e: Exception) {
        // The frame may be gone (reload/navigation); nothing to deliver to.
        Log.w(AppConfig.LOG_TAG, "postMessage to shell failed: ${e.message}")
        false
    }
}

private const val MAX_WC_SESSIONS = 999
private const val MAX_TITLE_CHARS = 200
private const val MAX_MESSAGE_CHARS = 1000

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key, "").ifEmpty { null }
