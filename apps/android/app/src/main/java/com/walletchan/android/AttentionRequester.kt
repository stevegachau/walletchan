package com.walletchan.android

import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * `{cmd:"requestAttention", title, message}`: a dApp request is waiting while the
 * user is elsewhere. Posts a heads-up notification only if MainActivity is still
 * not resumed [RECHECK_DELAY_MS] later, so a deep link that is already bringing
 * the app forward doesn't also ring. Cleared on resume. Main thread only.
 */
class AttentionRequester(
    private val notifier: Notifier,
    private val isResumed: () -> Boolean,
) {
    companion object {
        const val RECHECK_DELAY_MS = 700L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var pending: Pair<String, String>? = null
    private val recheck = Runnable {
        val (title, message) = pending ?: return@Runnable
        pending = null
        if (!isResumed() && !notifier.postAttention(title, message)) {
            Log.i(AppConfig.LOG_TAG, "Attention notification dropped: permission not granted")
        }
    }

    fun request(title: String, message: String) {
        if (isResumed()) return
        pending = title to message
        handler.removeCallbacks(recheck)
        handler.postDelayed(recheck, RECHECK_DELAY_MS)
    }

    fun onResume() {
        pending = null
        handler.removeCallbacks(recheck)
        notifier.cancelAttention()
    }

    fun destroy() {
        pending = null
        handler.removeCallbacks(recheck)
    }
}
