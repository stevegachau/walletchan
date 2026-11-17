package com.walletchan.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Notifications for the `notify` (chrome.notifications) and `requestAttention`
 * bridge commands, plus the shared channels (the WalletConnect keep-alive
 * service builds its own notification on [CONNECTION_CHANNEL_ID]).
 */
class Notifier(private val context: Context) {
    companion object {
        const val CHANNEL_ID = "wallet_activity"
        const val REQUESTS_CHANNEL_ID = "requests"
        const val CONNECTION_CHANNEL_ID = "connection_status"

        private const val ATTENTION_TAG = "attention"
        private const val ATTENTION_ID = 1

        /** Idempotent; safe to call from any component before posting. */
        fun createChannels(context: Context) {
            val channels = listOf(
                NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = context.getString(R.string.notification_channel_description) },
                NotificationChannel(
                    REQUESTS_CHANNEL_ID,
                    context.getString(R.string.requests_channel_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = context.getString(R.string.requests_channel_description) },
                NotificationChannel(
                    CONNECTION_CHANNEL_ID,
                    context.getString(R.string.connection_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = context.getString(R.string.connection_channel_description)
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                },
            )
            context.getSystemService(NotificationManager::class.java).createNotificationChannels(channels)
        }

        /** Brings the existing singleTask MainActivity forward (never recreates it). */
        fun openAppIntent(context: Context): PendingIntent {
            val open = Intent(context, MainActivity::class.java)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(
                context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    }

    init {
        createChannels(context)
    }

    fun hasPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /** Returns false if notifications are not permitted. */
    fun post(id: String, title: String, message: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return false
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_wallet)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(openAppIntent(context))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(context).notify(id, 0, notification)
        return true
    }

    /**
     * Heads-up "come back to the wallet" notification for a pending dApp request.
     * A newer request replaces (and re-alerts) the previous one. Returns false if
     * notifications are not permitted.
     */
    fun postAttention(title: String, message: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return false
        val builder = NotificationCompat.Builder(context, REQUESTS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_wallet)
            .setContentTitle(title)
            .setContentIntent(openAppIntent(context))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
        if (message.isNotEmpty()) {
            builder.setContentText(message).setStyle(NotificationCompat.BigTextStyle().bigText(message))
        }
        NotificationManagerCompat.from(context).notify(ATTENTION_TAG, ATTENTION_ID, builder.build())
        return true
    }

    fun cancelAttention() {
        NotificationManagerCompat.from(context).cancel(ATTENTION_TAG, ATTENTION_ID)
    }
}
