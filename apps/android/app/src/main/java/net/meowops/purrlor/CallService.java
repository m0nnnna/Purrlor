package net.meowops.purrlor;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Runs while a voice call is going on (the page tells the app, nativeApp.ts reportCallActive), so
 * Android keeps the microphone and the connection alive when Purrlor leaves the screen. Its
 * notification brings the call back.
 */
public class CallService extends Service {
    private static final int ID = 2;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notifier.createChannels(this);
        Intent open = new Intent(this, PurrlorActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, Notifier.CHANNEL_CALL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.callOngoing))
                .setContentText(getString(R.string.callTapToReturn))
                .setContentIntent(pending)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .build();
        int type = 0;
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
        }
        try {
            ServiceCompat.startForeground(this, ID, notification, type);
        } catch (RuntimeException e) {
            // Not allowed to start right now (for instance without the microphone permission): no service, call still works on screen.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
