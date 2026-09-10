package com.duospace.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FirebaseMessagingService for every DuoSpace push EXCEPT the two ringing-
 * call types (incoming_audio_call/incoming_video_call — those stay owned by
 * CallNotificationService.kt, which is registered alongside this one;
 * Android delivers each FCM message to every matching service).
 *
 * WHY THIS EXISTS: send-push (supabase/functions/_shared/fcm.ts) now sends
 * every Android push data-only — no top-level `android.notification` block,
 * for ANY type, not just calls. Root cause that fixed: with a
 * `notification` block present, the OS auto-displays its own bare
 * notification whenever the app is backgrounded, which (a) bypasses every
 * FirebaseMessagingService entirely so nothing here or in JS ever saw the
 * message, and (b) could double-post alongside a separately-triggered
 * local render, producing the duplicate/blank stacked notifications this
 * service replaces. Now this service is the ONLY thing that ever builds a
 * visible notification for a message/reaction/call-status/request push,
 * so it fires exactly once, every time, backgrounded or killed.
 *
 * WhatsApp-style behaviors implemented here that the previous default
 * auto-display never had:
 *  - BigTextStyle so a long message body isn't clipped to one line.
 *  - Real per-conversation grouping (NotificationCompat.setGroup +
 *    an actual InboxStyle summary built from the OS's own
 *    getActiveNotifications(), not Android's blank auto-generated summary
 *    row — see updateGroupSummary below).
 *  - setPublicVersion(): a redacted fallback ("New message", no body,
 *    sender name kept) that the OS shows instead of the real notification
 *    whenever the DEVICE's own "hide sensitive notification content on
 *    lock screen" setting is on. Message bodies from this app were never
 *    real plaintext to begin with (E2E — see src/lib/crypto.ts /
 *    the fix in 20260908090000_fix_push_preview_leak_and_call_status.sql),
 *    but this still gives every other field (senderName, unread badges,
 *    call outcomes) the same lock-screen privacy behavior WhatsApp has.
 */
class DuoSpaceMessagingService : FirebaseMessagingService() {

    companion object {
        // incoming_audio_call/incoming_video_call are intentionally absent —
        // CallNotificationService.kt owns those exclusively.
        private val CALL_STATUS_TYPES = setOf("missed_call", "call_ended", "call_rejected")
        private val MESSAGE_LIKE_TYPES = setOf(
            "chat_message", "image_message", "video_message", "audio_message",
            "file_message", "reply", "reaction", "mention", "group_message",
        )
        private const val RINGING_AUDIO = "incoming_audio_call"
        private const val RINGING_VIDEO = "incoming_video_call"
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val type = data["type"] ?: return
        if (type == RINGING_AUDIO || type == RINGING_VIDEO) return // CallNotificationService.kt's job
        if (type == "typing") return // ephemeral, realtime-only — never worth a tray notification
        NotificationChannels.createAll(this)
        showNotification(data, type)
    }

    private fun showNotification(data: Map<String, String>, type: String) {
        val title = data["title"] ?: "DuoSpace"
        val body = data["body"] ?: ""
        val channelId = data["channelId"] ?: NotificationChannels.SYSTEM
        val conversationId = data["conversationId"]
        // conversationId groups everything about one couple's chat/calls
        // together (messages + call log entries alike, matching how
        // WhatsApp stacks a chat's messages and its call-log lines under
        // the same thread). Types with no conversation (partner requests,
        // custom broadcasts) fall back to a stable per-type group so they
        // still stack sensibly with each other instead of each getting an
        // unnecessary solo "summary".
        val group = data["groupKey"] ?: conversationId ?: "duospace_group_$type"
        val isMessageLike = type in MESSAGE_LIKE_TYPES
        val isCallStatus = type in CALL_STATUS_TYPES

        // Stable-but-unique per-item id so distinct messages/calls stack
        // instead of one silently replacing another (the previous
        // `tag`-as-conversationId behavior on the old `android.notification`
        // block caused exactly that replacement). Falls back to a
        // type+timestamp composite for pushes with no natural id (e.g.
        // "custom").
        val itemKey = data["messageId"] ?: data["callId"] ?: data["relatedId"]
            ?: "$type:${data["timestamp"] ?: System.currentTimeMillis()}"
        val notificationId = itemKey.hashCode()

        val contentIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("pushType", type)
            putExtra("conversationId", conversationId)
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notificationId, contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, channelId)
            // FIX: was applicationInfo.icon (the full-color launcher icon).
            // Android strips color from status-bar/notification small icons
            // and renders only the alpha channel as a flat white silhouette —
            // a fully-opaque launcher icon has no usable alpha shape, so it
            // showed up as a blank white blob. ic_stat_duospace is a proper
            // mostly-transparent glyph generated for this purpose (see
            // native/android/res_notification_icon/, copied in by
            // scripts/patch-native-permissions.mjs).
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setGroup(group)
            .setWhen(parseTimestamp(data["timestamp"]))
            .setPriority(
                if (isCallStatus) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT,
            )
            // Message-like content is genuinely private (E2E chat content);
            // call-status/request lines ("Missed call from X", "New partner
            // request") are treated like WhatsApp treats its own call log —
            // visible on the lock screen same as a real phone's call log.
            .setVisibility(if (isMessageLike) NotificationCompat.VISIBILITY_PRIVATE else NotificationCompat.VISIBILITY_PUBLIC)

        if (isMessageLike) {
            // Redacted version the OS substitutes on the lock screen when
            // the device's own "hide sensitive content" setting is on.
            // Sender name stays (same as WhatsApp) — body never leaks.
            val publicVersion = NotificationCompat.Builder(this, channelId)
                .setSmallIcon(R.drawable.ic_stat_duospace)
                .setContentTitle(title)
                .setContentText("New message")
                .setGroup(group)
                .setAutoCancel(true)
                .build()
            builder.setPublicVersion(publicVersion)
        }

        NotificationManagerCompat.from(this).notify(notificationId, builder.build())
        updateGroupSummary(group, channelId)
    }

    private fun parseTimestamp(iso: String?): Long {
        if (iso.isNullOrBlank()) return System.currentTimeMillis()
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (e: Exception) {
            System.currentTimeMillis()
        }
    }

    /**
     * Replaces Android's own blank auto-generated group summary (exactly
     * what the "Call ended / [blank]" duplicate-looking row in the
     * notification shade was — two entries for one conversation, the
     * second an empty synthesized summary) with a real one: an InboxStyle
     * listing the most recent lines, built from the OS's own current
     * notification state via getActiveNotifications() — correct even
     * across process restarts, since it reads system truth rather than an
     * in-memory count. Only posted once a group actually has 2+ real
     * entries; a single notification needs no summary line at all.
     */
    private fun updateGroupSummary(group: String, channelId: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val active = try {
            manager.activeNotifications
        } catch (e: Exception) {
            return
        }
        val inGroup = active.filter {
            it.notification.group == group && (it.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0
        }
        if (inGroup.size < 2) return

        val inbox = NotificationCompat.InboxStyle().setSummaryText("DuoSpace")
        inGroup.sortedBy { it.postTime }.takeLast(5).forEach { sbn ->
            val extras = sbn.notification.extras
            val lineTitle = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val lineText = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            inbox.addLine(if (lineTitle.isNotBlank()) "$lineTitle: $lineText" else lineText)
        }

        val summary = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_stat_duospace)
            .setContentTitle("DuoSpace")
            .setContentText("${inGroup.size} new notifications")
            .setStyle(inbox)
            .setGroup(group)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(this).notify(group.hashCode(), summary)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Token persistence already owned by Capacitor's own service +
        // src/hooks/usePushNotifications.ts — nothing to do here.
    }
}
