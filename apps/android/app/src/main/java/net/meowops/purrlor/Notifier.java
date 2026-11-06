package net.meowops.purrlor;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

/** Shows the notifications the gateway pushes, and opens the right room when one is tapped. */
final class Notifier {
    static final String CHANNEL_MESSAGES = "messages";
    static final String CHANNEL_CALL = "call";
    /** Extra on the launch intent: the Matrix room id to open. */
    static final String EXTRA_ROOM = "net.meowops.purrlor.ROOM";

    private Notifier() {}

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_MESSAGES,
                context.getString(R.string.channelMessages), NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_CALL,
                context.getString(R.string.channelCall), NotificationManager.IMPORTANCE_LOW));
    }

    static boolean allowed(Context context) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    /** The payload's fields: the gateway's {title, body, roomId, eventId, unreadCount, tag}. */
    static void showPush(Context context, byte[] message) {
        String title = "Purrlor";
        String body = "";
        String roomId = null;
        String tag = null;
        try {
            JSONObject json = new JSONObject(new String(message, java.nio.charset.StandardCharsets.UTF_8));
            title = json.optString("title", title);
            body = json.optString("body", "");
            roomId = json.optString("roomId", "");
            tag = json.optString("tag", "");
        } catch (Exception ignored) {
            // Not our JSON: show it as plain text.
            body = new String(message, java.nio.charset.StandardCharsets.UTF_8);
        }
        show(context, title, body, roomId, tag);
    }

    static void show(Context context, String title, String body, @Nullable String roomId, @Nullable String tag) {
        if (!allowed(context)) return;
        createChannels(context);
        Intent open = new Intent(context, PurrlorActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (roomId != null && !roomId.isEmpty()) open.putExtra(EXTRA_ROOM, roomId);
        String key = roomId != null && !roomId.isEmpty() ? roomId : (tag != null ? tag : "");
        int id = key.hashCode();
        PendingIntent pending = PendingIntent.getActivity(context, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build();
        try {
            NotificationManagerCompat.from(context).notify(key.isEmpty() ? "purrlor" : key, 1, notification);
        } catch (SecurityException ignored) {
            // The permission was taken away just now.
        }
    }
}
