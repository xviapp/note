package app.xvi.note;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.v2ray.ang.api.EmbeddedProxyController;
import com.v2ray.ang.api.Observation;
import com.v2ray.ang.api.ProxyNode;
import com.v2ray.ang.api.ProxyState;
import com.v2ray.ang.api.ProxySubscriptionSnapshot;

import java.net.Proxy;
import java.util.Locale;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Thin Capacitor adapter around the shared embedded proxy controller. */
final class NoteProxyNetwork {
    private static NoteProxyNetwork instance;

    static synchronized NoteProxyNetwork get(Context context) {
        if (instance == null) instance = new NoteProxyNetwork(context.getApplicationContext());
        return instance;
    }

    private final EmbeddedProxyController controller;

    private NoteProxyNetwork(Context context) {
        controller = EmbeddedProxyController.get(context, new WebViewRouting());
    }

    void prepare(Consumer<JSObject> done) { controller.prepare(state -> done.accept(toJs(state))); }

    Observation observe(Consumer<JSObject> observer) {
        return controller.observe(state -> observer.accept(toJs(state)));
    }

    void status(Consumer<JSObject> done) { controller.status(state -> done.accept(toJs(state))); }

    void setEnabled(boolean enabled, Consumer<JSObject> done) {
        controller.setEnabled(enabled, state -> done.accept(toJs(state)));
    }

    void retry(Consumer<JSObject> done) { controller.retry(state -> done.accept(toJs(state))); }

    void setBackgroundActive(boolean active) { controller.setBackgroundActive(active); }

    Proxy proxy() { return EmbeddedProxyController.networkProxy(); }

    void saveSubscription(String url, int updateIntervalMinutes, int testIntervalMinutes, Consumer<JSObject> done) {
        controller.setSubscription(url, updateIntervalMinutes, testIntervalMinutes, state -> done.accept(toJs(state)));
    }

    void updateSubscription(Consumer<JSObject> done) {
        controller.refreshSubscription(state -> done.accept(toJs(state)));
    }

    void selectNextNode(Consumer<JSObject> done) {
        controller.selectNextNode(state -> done.accept(toJs(state)));
    }

    void selectNode(int index, Consumer<JSObject> done) {
        controller.selectNode(index, state -> done.accept(toJs(state)));
    }

    void selectAutomatically(Consumer<JSObject> done) {
        controller.selectAutomatically(state -> done.accept(toJs(state)));
    }

    private static JSObject toJs(ProxyState state) {
        return new JSObject()
            .put("enabled", state.getEnabled())
            .put("phase", state.getPhase().name().toLowerCase(Locale.ROOT))
            .put("errorCode", state.getErrorCode())
            .put("retryAtMillis", state.getRetryAtMillis())
            .put("hasProfile", state.getHasProfile())
            .put("subscription", toJs(state.getSubscription()));
    }

    private static JSObject toJs(ProxySubscriptionSnapshot state) {
        JSONArray nodes = new JSONArray();
        for (ProxyNode node : state.getNodes()) {
            try {
                nodes.put(new JSONObject()
                    .put("id", node.getId())
                    .put("name", node.getName())
                    .put("type", node.getType())
                    .put("delayMillis", node.getDelayMillis())
                    .put("selected", node.isSelected()));
            } catch (JSONException error) {
                throw new IllegalStateException("Failed to encode proxy node", error);
            }
        }
        return new JSObject()
            .put("updating", state.isUpdating())
            .put("error", state.getError())
            .put("url", state.getUrl())
            .put("lastUpdated", state.getLastUpdated())
            .put("updateIntervalMinutes", state.getUpdateIntervalMinutes())
            .put("testIntervalMinutes", state.getTestIntervalMinutes())
            .put("testing", state.isTesting())
            .put("lastTested", state.getLastTested())
            .put("testError", state.getTestError())
            .put("manualIndex", state.getManualIndex())
            .put("fallback", state.isFallback())
            .put("nodes", nodes);
    }

    private static final class WebViewRouting implements EmbeddedProxyController.Routing {
        private final Handler main = new Handler(Looper.getMainLooper());

        @Override public boolean isSupported() {
            return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
        }

        @Override public void setProxy(int port, Runnable applied) {
            ProxyConfig config = new ProxyConfig.Builder()
                .addProxyRule("socks://127.0.0.1:" + port)
                .removeImplicitRules()
                .build();
            ProxyController.getInstance().setProxyOverride(config, main::post, applied);
        }

        @Override public void clearProxy(Runnable cleared) {
            ProxyController.getInstance().clearProxyOverride(main::post, cleared);
        }
    }
}
