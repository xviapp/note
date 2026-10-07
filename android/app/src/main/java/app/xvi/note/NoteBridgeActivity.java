package app.xvi.note;

import android.content.Intent;
import android.net.Uri;
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
    /** What a launcher shortcut asked the page to open, until the page takes it. */
    volatile String launchAction;
    private final ExecutorService shareExecutor = Executors.newSingleThreadExecutor();

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
                if (policy.isDownload(url)) {
                    view.evaluateJavascript("window.dispatchEvent(new CustomEvent('note:download', {detail: "
                        + JSONObject.quote(url) + "}))", null);
                } else openExternal(request.getUrl());
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

    /** The share window's exit; the notebook has nothing to close. */
    void closeShare(boolean saved, boolean openApp) {}

    abstract void setThemeBackground(int color, String preference);

    void finishBoot() {}

    void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"mailto".equals(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (android.content.ActivityNotFoundException error) {
            Toast.makeText(this, "没有可打开此链接的应用", Toast.LENGTH_SHORT).show();
        }
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
