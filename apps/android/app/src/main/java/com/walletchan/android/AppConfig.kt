package com.walletchan.android

/** Compile-time knobs and the constants shared with the JS runtime (see ARCHITECTURE.md). */
object AppConfig {
    const val APP_HOST = "appassets.androidplatform.net"
    const val APP_ORIGIN = "https://$APP_HOST"
    const val SHELL_URL = "$APP_ORIGIN/android/shell.html"

    /** Root of the packaged web runtime inside the APK's assets. */
    const val ASSET_ROOT = "www/"
    const val DAPP_INJECT_ASSET = "www/android/dapp-inject.js"

    const val NATIVE_BRIDGE = "WalletChanNative"
    const val DAPP_BRIDGE = "WalletChanDapp"

    const val FIRST_DAPP_TAB_ID = 1000
    const val SEARCH_URL_PREFIX = "https://duckduckgo.com/?q="

    /**
     * FLAG_SECURE blocks screenshots / screen recording and blanks the Recents
     * thumbnail, so seed phrases and keys can't leak through captures.
     * Flip to false to allow screenshots (e.g. for QA or store listings).
     */
    const val SECURE_SCREEN = true

    const val LOG_TAG = "WalletChan"
    const val JS_LOG_TAG = "WalletChanJS"
}
