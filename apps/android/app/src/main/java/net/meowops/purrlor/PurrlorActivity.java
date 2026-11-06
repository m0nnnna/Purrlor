package net.meowops.purrlor;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * Purrlor in its own window: the chosen server (Server.java) in a WebView, with the bridge
 * (NativeBridge) that gives the page notifications while the app is closed and background calls.
 * Asks for a server first if none is chosen yet.
 */
public class PurrlorActivity extends Activity {
    /** Set by ServerActivity: a server was just chosen, so open it. */
    static final String EXTRA_SERVER_CHOSEN = "net.meowops.purrlor.SERVER_CHOSEN";
    private static final String SHORTCUT_CHANGE_SERVER = "change-server";
    private static final int REQ_PERMISSIONS = 10;
    private static final int REQ_FILES = 11;
    private static final int REQ_NOTIFICATIONS = 12;

    @Nullable private static PurrlorActivity sCurrent;

    private WebView web;
    private String host;
    @Nullable private PermissionRequest pendingWebPermission;
    @Nullable private ValueCallback<Uri[]> fileCallback;

    /** The push endpoint changed: tell the page, if it's on screen. */
    /** A button on the call notification was pressed ("mute" or "leave"). */
    static void callAction(String action) {
        PurrlorActivity activity = sCurrent;
        if (activity != null) activity.runOnUiThread(() -> activity.fire("purrlor-call-action", "{\"action\":" + org.json.JSONObject.quote(action) + "}"));
    }

    static void pushChanged() {
        PurrlorActivity activity = sCurrent;
        if (activity != null) activity.runOnUiThread(() -> activity.fire("purrlor-native-push", "{}"));
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        host = Server.get(this);
        if (host == null) {
            startActivity(new Intent(this, ServerActivity.class));
            finish();
            return;
        }
        sCurrent = this;
        Notifier.createChannels(this);
        addChangeServerShortcut();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.background));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // Keep the page clear of the status bar, the navigation bar and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new NativeBridge(this), "PurrlorNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        if (savedInstanceState == null || web.getUrl() == null) web.loadUrl(launchUrl(getIntent()).toString());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web == null) return;
        String room = intent.getStringExtra(Notifier.EXTRA_ROOM);
        if (intent.getBooleanExtra(EXTRA_SERVER_CHOSEN, false)) {
            host = Server.get(this);
            web.loadUrl(Server.home(host).toString());
        } else if (room != null) {
            fire("purrlor-open-room", "{\"roomId\":" + org.json.JSONObject.quote(room) + "}");
        } else if (intent.getData() != null || intent.getAction() != null && intent.getAction().equals(Intent.ACTION_SEND)) {
            web.loadUrl(launchUrl(intent).toString());
        }
    }

    /** Where this launch goes: a tapped notification's room, a link to the server, shared text, or home. */
    private Uri launchUrl(Intent intent) {
        Uri home = Server.home(host);
        String room = intent.getStringExtra(Notifier.EXTRA_ROOM);
        if (room != null) return home.buildUpon().appendQueryParameter("openRoom", room).build();
        Uri link = intent.getData();
        if (link != null && "https".equals(link.getScheme()) && host.equals(link.getAuthority())) return link;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri.Builder builder = home.buildUpon();
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (text != null) builder.appendQueryParameter("share_text", text);
            if (title != null) builder.appendQueryParameter("share_title", title);
            return builder.build();
        }
        return home;
    }

    /** Runs a window event in the page. `detail` is JSON. */
    private void fire(String name, String detail) {
        if (web == null) return;
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('" + name + "',{detail:" + detail + "}))", null);
    }

    /** The page asked for notifications: the permission first (Android 13), then an endpoint. */
    void enablePush() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
            return;
        }
        NativePush.register(this);
        fire("purrlor-native-push", "{}");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_NOTIFICATIONS) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) NativePush.register(this);
            fire("purrlor-native-push", "{}");
        } else if (requestCode == REQ_PERMISSIONS && pendingWebPermission != null) {
            PermissionRequest request = pendingWebPermission;
            pendingWebPermission = null;
            List<String> granted = new ArrayList<>();
            for (String resource : request.getResources()) {
                String needed = androidPermission(resource);
                if (needed != null && checkSelfPermission(needed) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            }
            if (granted.isEmpty()) request.deny();
            else request.grant(granted.toArray(new String[0]));
        }
    }

    @Nullable
    private static String androidPermission(String webResource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(webResource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(webResource)) return Manifest.permission.CAMERA;
        return null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || fileCallback == null) return;
        fileCallback.onReceiveValue(resultCode == RESULT_OK ? WebChromeClient.FileChooserParams.parseResult(resultCode, data) : null);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        fire("purrlor-native-push", "{}");
    }

    @Override
    protected void onPause() {
        // The page keeps running for a call (CallService); WebView.onPause would stop its timers.
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (sCurrent == this) sCurrent = null;
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }

    /** Long-pressing the app icon offers Change server. */
    private void addChangeServerShortcut() {
        Intent intent = new Intent(this, ServerActivity.class).setAction(Intent.ACTION_VIEW);
        ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(this, SHORTCUT_CHANGE_SERVER)
                .setShortLabel(getString(R.string.changeServer))
                .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
                .setIntent(intent)
                .build();
        try {
            ShortcutManagerCompat.pushDynamicShortcut(this, shortcut);
        } catch (RuntimeException ignored) {
            // A launcher without shortcuts, or too many.
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("https".equals(url.getScheme()) && host.equals(url.getAuthority())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
                // Nothing on the phone opens it.
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            view.setVisibility(View.VISIBLE);
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // Only the chosen server's own pages may ask for the microphone and camera.
            if (!host.equals(request.getOrigin().getAuthority())) {
                request.deny();
                return;
            }
            List<String> missing = new ArrayList<>();
            for (String resource : request.getResources()) {
                String needed = androidPermission(resource);
                if (needed != null && checkSelfPermission(needed) != PackageManager.PERMISSION_GRANTED && !missing.contains(needed)) missing.add(needed);
            }
            if (missing.isEmpty()) {
                List<String> ok = new ArrayList<>();
                for (String resource : request.getResources()) if (androidPermission(resource) != null) ok.add(resource);
                if (ok.isEmpty()) request.deny();
                else request.grant(ok.toArray(new String[0]));
                return;
            }
            pendingWebPermission = request;
            requestPermissions(missing.toArray(new String[0]), REQ_PERMISSIONS);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }
}
