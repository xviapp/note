package app.xvi.note;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoteDevicePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        OriginPolicy policy = new OriginPolicy(bridge.getLocalUrl());
        CookieManager.getInstance().setAcceptThirdPartyCookies(bridge.getWebView(), false);
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
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
}
