package com.walletchan.android

import android.Manifest
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that runs while WalletConnect apps are connected
 * (`{cmd:"wcSessions", count}`). It does no work itself: its ongoing, silent
 * notification keeps the app process — and with it the main WebView's renderer,
 * bound RENDERER_PRIORITY_IMPORTANT and not waived when hidden — out of the
 * cached/frozen state, so the relay websocket stays up while the user is in
 * another app. Started and updated by [WalletConnectKeepAlive].
 */
class WalletConnectService : Service() {
    companion object {
        const val EXTRA_COUNT = "count"
        const val NOTIFICATION_ID = 0x5743 // "WC"

        /** True between a successful startForeground and onDestroy. Main thread only. */
        var isRunning = false
            private set

        fun buildNotification(context: Context, count: Int): Notification =
            NotificationCompat.Builder(context, Notifier.CONNECTION_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_wallet)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(context.resources.getQuantityString(R.plurals.wc_connected_apps, count, count))
                .setContentIntent(Notifier.openAppIntent(context))
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()

        /** Refreshes the text of the running service's notification (no restart needed). */
        fun updateNotification(context: Context, count: Int) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) return // the notification isn't shown anyway; the service keeps running
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, buildNotification(context, count))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val count = (intent?.getIntExtra(EXTRA_COUNT, 1) ?: 1).coerceAtLeast(1)
        Notifier.createChannels(this)
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(this, count), type)
            isRunning = true
        } catch (e: Exception) {
            Log.w(AppConfig.LOG_TAG, "WalletConnect keep-alive could not enter the foreground: ${e.message}")
            stopSelf()
        }
        // If the process dies the WebView (and its relay connection) is gone too:
        // nothing to restart on our own.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }
}
