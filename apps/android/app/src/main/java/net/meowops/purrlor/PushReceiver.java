package net.meowops.purrlor;

import android.content.Context;

import androidx.annotation.NonNull;

import org.unifiedpush.android.connector.MessagingReceiver;

/** What the phone's UnifiedPush distributor tells the app, even when it is closed. */
public class PushReceiver extends MessagingReceiver {
    @Override
    public void onNewEndpoint(@NonNull Context context, @NonNull String endpoint, @NonNull String instance) {
        NativePush.setEndpoint(context, endpoint);
        PurrlorActivity.pushChanged();
    }

    @Override
    public void onMessage(@NonNull Context context, @NonNull byte[] message, @NonNull String instance) {
        Notifier.showPush(context, message);
    }

    @Override
    public void onRegistrationFailed(@NonNull Context context, @NonNull String instance) {
        NativePush.setEndpoint(context, "");
        PurrlorActivity.pushChanged();
    }

    @Override
    public void onUnregistered(@NonNull Context context, @NonNull String instance) {
        NativePush.setEndpoint(context, "");
        PurrlorActivity.pushChanged();
    }
}
