package net.meowops.purrlor;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
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
    private static final String ACTION_MUTE = "net.meowops.purrlor.CALL_MUTE";
    private static final String ACTION_LEAVE = "net.meowops.purrlor.CALL_LEAVE";
    private static final String ACTION_STATE = "net.meowops.purrlor.CALL_STATE";
    private static final String EXTRA_MUTED = "muted";
    private boolean muted;
    private boolean foreground;

    /** Updates the Mute / Unmute button. Only while the service runs: it never starts it. */
    static void setMuted(Context context, boolean muted) {
        if (!running) return;
        context.startService(new Intent(context, CallService.class).setAction(ACTION_STATE).putExtra(EXTRA_MUTED, muted));
    }

    private static volatile boolean running;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    private PendingIntent action(String name) {
        return PendingIntent.getService(this, 0, new Intent(this, CallService.class).setAction(name),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent == null ? null : intent.getAction();
        if (ACTION_MUTE.equals(act)) {
            PurrlorActivity.callAction("mute");
            return START_NOT_STICKY;
        }
        if (ACTION_LEAVE.equals(act)) {
            PurrlorActivity.callAction("leave");
            return START_NOT_STICKY;
        }
        if (ACTION_STATE.equals(act)) {
            boolean now = intent.getBooleanExtra(EXTRA_MUTED, false);
            if (now == muted || !foreground) return START_NOT_STICKY;
            muted = now;
            getSystemService(android.app.NotificationManager.class).notify(ID, build());
            return START_NOT_STICKY;
        }
        Notifier.createChannels(this);
        Notification notification = build();
        int type = 0;
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
        }
        try {
            ServiceCompat.startForeground(this, ID, notification, type);
            foreground = true;
        } catch (RuntimeException e) {
            // Not allowed to start right now (for instance without the microphone permission): no service, call still works on screen.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification build() {
        Intent open = new Intent(this, PurrlorActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, Notifier.CHANNEL_CALL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.callOngoing))
                .setContentText(getString(R.string.callTapToReturn))
                .setContentIntent(pending)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .addAction(0, getString(muted ? R.string.callUnmute : R.string.callMute), action(ACTION_MUTE))
                .addAction(0, getString(R.string.callLeave), action(ACTION_LEAVE))
                .build();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
