package net.meowops.purrlor;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

import java.util.List;

/**
 * The app's side of UnifiedPush (https://unifiedpush.org): a distributor app on the phone (ntfy
 * and the like) gives Purrlor an endpoint address; the web client sends it to the push gateway
 * (docs/android.md), and the gateway posts each notification there, which wakes PushReceiver
 * even when the app is closed.
 */
final class NativePush {
    private static final String PREFS = "purrlor-push";
    private static final String KEY_ENDPOINT = "endpoint";
    private static final String INSTANCE = "default";

    private NativePush() {}

    static String endpoint(Context context) {
        return prefs(context).getString(KEY_ENDPOINT, "");
    }

    static void setEndpoint(Context context, String endpoint) {
        prefs(context).edit().putString(KEY_ENDPOINT, endpoint == null ? "" : endpoint).apply();
    }

    static int distributors(Context context) {
        List<String> found = UnifiedPush.getDistributors(context, new java.util.ArrayList<>());
        return found.size();
    }

    /** What the web client reads (nativeApp.ts, NativePushState). */
    static String stateJson(Context context) {
        JSONObject json = new JSONObject();
        try {
            json.put("endpoint", endpoint(context));
            json.put("distributors", distributors(context));
            json.put("allowed", Notifier.allowed(context));
        } catch (JSONException ignored) {
            // Plain values: cannot fail.
        }
        return json.toString();
    }

    /** Picks the phone's distributor (the only one, or the first) and asks it for an endpoint. */
    static boolean register(Context context) {
        String saved = UnifiedPush.getSavedDistributor(context);
        if (saved == null) {
            List<String> found = UnifiedPush.getDistributors(context, new java.util.ArrayList<>());
            if (found.isEmpty()) return false;
            UnifiedPush.saveDistributor(context, found.get(0));
        }
        UnifiedPush.registerApp(context, INSTANCE, new java.util.ArrayList<>(), null);
        return true;
    }

    static void unregister(Context context) {
        UnifiedPush.unregisterApp(context, INSTANCE);
        setEndpoint(context, "");
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
