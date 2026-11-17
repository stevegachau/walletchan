package com.walletchan.android

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Starts/updates/stops [WalletConnectService] from the shell's
 * `{cmd:"wcSessions", count}`. Android 12+ refuses foreground-service starts while
 * the app is in the background (ForegroundServiceStartNotAllowedException); the
 * desired count is remembered and the start is retried on the next [onResume].
 * Main thread only.
 */
class WalletConnectKeepAlive(context: Context) {
    private val context: Context = context.applicationContext
    private var desiredCount = 0

    fun setCount(count: Int) {
        desiredCount = count.coerceAtLeast(0)
        when {
            desiredCount == 0 -> stopService()
            WalletConnectService.isRunning -> WalletConnectService.updateNotification(context, desiredCount)
            else -> start()
        }
    }

    /** Retries a start that was refused (or failed) while the app was in the background. */
    fun onResume() {
        if (desiredCount > 0 && !WalletConnectService.isRunning) start()
    }

    /** Re-posts the notification text (e.g. after POST_NOTIFICATIONS was granted). */
    fun refreshNotification() {
        if (desiredCount > 0 && WalletConnectService.isRunning) {
            WalletConnectService.updateNotification(context, desiredCount)
        }
    }

    /** Activity is going away: the WebView (and the relay connection) goes with it. */
    fun shutdown() {
        desiredCount = 0
        stopService()
    }

    private fun start() {
        val intent = Intent(context, WalletConnectService::class.java)
            .putExtra(WalletConnectService.EXTRA_COUNT, desiredCount)
        try {
            ContextCompat.startForegroundService(context, intent)
        } catch (e: IllegalStateException) {
            // ForegroundServiceStartNotAllowedException (API 31+) is an IllegalStateException.
            Log.i(AppConfig.LOG_TAG, "WalletConnect keep-alive start deferred until resume: ${e.javaClass.simpleName}")
        } catch (e: SecurityException) {
            Log.w(AppConfig.LOG_TAG, "WalletConnect keep-alive not allowed: ${e.message}")
        }
    }

    private fun stopService() {
        context.stopService(Intent(context, WalletConnectService::class.java))
    }
}
