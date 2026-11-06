package net.meowops.purrlor;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.webkit.JavascriptInterface;

/** `window.PurrlorNative`: what the web client may ask of the app (apps/web/src/matrix/nativeApp.ts). */
final class NativeBridge {
    private final PurrlorActivity activity;

    NativeBridge(PurrlorActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String pushState() {
        return NativePush.stateJson(activity);
    }

    @JavascriptInterface
    public void enablePush() {
        activity.runOnUiThread(activity::enablePush);
    }

    @JavascriptInterface
    public void disablePush() {
        NativePush.unregister(activity);
    }

    @JavascriptInterface
    public void testNotification() {
        Notifier.show(activity, "Purrlor", activity.getString(R.string.testNotification), null, "test");
    }

    @JavascriptInterface
    public void callActive(boolean active) {
        Context app = activity.getApplicationContext();
        Intent service = new Intent(app, CallService.class);
        if (active) {
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(service);
            else app.startService(service);
        } else {
            app.stopService(service);
        }
    }
}
