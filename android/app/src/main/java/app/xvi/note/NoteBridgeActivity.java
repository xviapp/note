package app.xvi.note;

import android.content.Intent;
import android.net.Uri;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONObject;

/** What the notebook and the share window have in common: the NoteDevice plugin,
 * the share inbox, and the WebView's routing between local assets, /api and links. */
abstract class NoteBridgeActivity extends BridgeActivity {
    ShareInbox shareInbox;
    private final ExecutorService shareExecutor = Executors.newSingleThreadExecutor();
    // Set by the page while a note is open and the reader chose volume-key paging.
    private boolean volumeKeys;

    /** Registers plugins; call before super.onCreate. */
    void registerNotePlugins() {
        registerPlugin(NoteDevicePlugin.class);
        registerPlugin(NoteProxyPlugin.class);
        registerPlugin(NoteArchivePlugin.class);
    }

    /** Routes the WebView's requests; call once the bridge exists. */
    void installWebView() {
        shareInbox = ShareInbox.get(this);
        OriginPolicy policy = new OriginPolicy(bridge.getLocalUrl());
        CookieManager.getInstance().setAcceptThirdPartyCookies(bridge.getWebView(), false);
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (policy.sameOrigin(request.getUrl().toString()) && request.getUrl().getPath().startsWith("/__share/"))
                    return shareInbox.open(request.getUrl().getPath());
                // Let Chromium issue these requests itself: it keeps HttpOnly cookies,
                // request bodies, Range responses and streaming fetch intact.
                if (policy.isApi(request.getUrl().toString())) return null;
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (policy.isDocument(url)) return false;
                if (policy.isDownload(url)) dispatch("note:download", JSONObject.quote(url));
                else {
                    String failure = openExternal(request.getUrl());
                    if (failure != null) dispatch("note:notice", JSONObject.quote(failure));
                }
                return true;
            }
        });
    }

    /** Copies a share off the main thread, then tells the page; failures are toasted. */
    void receiveShare(Intent intent, Consumer<String> received, Runnable failed) {
        if (!ShareInbox.accepts(intent) || shareInbox == null) return;
        shareExecutor.execute(() -> {
            try {
                String id = shareInbox.receive(intent);
                runOnUiThread(() -> {
                    if (isDestroyed() || bridge == null) return;
                    received.accept(id);
                    bridge.getWebView().evaluateJavascript("window.dispatchEvent(new Event('note:share'))", null);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    Toast.makeText(this, error.getMessage() == null ? "无法读取分享内容。" : error.getMessage(), Toast.LENGTH_LONG).show();
                    failed.run();
                });
            }
        });
    }

    /** The share this page should show, or null while none is ready. */
    JSONObject pendingShare() throws Exception {
        return shareInbox.next();
    }

    /** What the page was opened for: a floating window's tool, or a page the
     * notebook should open (taken once); null when nothing is waiting. */
    com.getcapacitor.JSObject takeLaunch() {
        return null;
    }

    /** A floating window steps out of sight; the notebook has nothing to hide. */
    void hideWindow() {}

    /** A floating window closes, with a toast and/or opening the notebook at `path`. */
    void closeWindow(String message, String path) {}

    /** The share window's exit; the notebook has nothing to close. */
    void closeShare(boolean saved, boolean openApp) {}

    abstract void setThemeBackground(int color, String preference);

    void finishBoot() {}

    /** Opens a web or mail link in another app; returns why it could not, or null. */
    String openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"mailto".equals(scheme)) return null;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
            return null;
        } catch (android.content.ActivityNotFoundException error) {
            return "没有可打开此链接的应用";
        }
    }

    /** Fires a window event in the page; `detail` is a JSON literal or null. */
    void dispatch(String event, String detail) {
        if (bridge == null) return;
        bridge.getWebView().evaluateJavascript("window.dispatchEvent(new CustomEvent(" + JSONObject.quote(event)
            + (detail == null ? "" : ", {detail: " + detail + "}") + "))", null);
    }

    /** What the open note asks of the window: screen kept on, no screenshots, volume keys page. */
    void setWindowState(boolean keepAwake, boolean secure, boolean volumeKeys) {
        setWindowFlag(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON, keepAwake);
        setWindowFlag(WindowManager.LayoutParams.FLAG_SECURE, secure);
        this.volumeKeys = volumeKeys;
    }

    private void setWindowFlag(int flag, boolean enabled) {
        if (enabled) getWindow().addFlags(flag);
        else getWindow().clearFlags(flag);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (volumeKeys && bridge != null && (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP)) {
            // Both halves are consumed so the system shows no volume panel.
            if (event.getAction() == KeyEvent.ACTION_DOWN)
                dispatch("note:volume-key", code == KeyEvent.KEYCODE_VOLUME_DOWN ? "1" : "-1");
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onDestroy() {
        shareExecutor.shutdown();
        super.onDestroy();
    }
}
