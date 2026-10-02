package app.xvi.note;

import android.content.Intent;
import android.graphics.drawable.ColorDrawable;
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
    private static final String APPEARANCE_PREFS = "note-appearance";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoteDevicePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // The first WebView frame precedes the JS bridge/theme callback. Prime
        // every native surface now so the splash never reveals a light canvas.
        String preference = getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE)
            .getString("theme", "system");
        int background = switch (preference) {
            case "light" -> R.color.note_surface_light;
            case "dark" -> R.color.note_surface_dark;
            case "starry" -> R.color.note_surface_starry;
            default -> R.color.note_surface;
        };
        applyThemeBackground(getColor(background));
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

    void setThemeBackground(int color, String preference) {
        // Save the preference, not its resolved color: system appearance may
        // change while the process is stopped.
        getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).edit()
            .putString("theme", preference).apply();
        applyThemeBackground(color);
    }

    private void applyThemeBackground(int color) {
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        getWindow().getDecorView().setBackgroundColor(color);
        bridge.getWebView().setBackgroundColor(color);
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
