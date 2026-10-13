package app.xvi.note;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.v2ray.ang.api.EmbeddedProxyController;
import com.v2ray.ang.api.Observation;
import com.v2ray.ang.api.ProxyNode;
import com.v2ray.ang.api.ProxyPhase;
import com.v2ray.ang.api.ProxyState;
import com.v2ray.ang.api.ProxySubscriptionSnapshot;

import java.net.Proxy;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicReference;
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

    private static final String PREFERENCES = "note_proxy";
    private static final String BYPASS_ON_VPN = "bypass_on_vpn";

    private final EmbeddedProxyController controller;
    private final SharedPreferences preferences;
    private final ConnectivityManager connectivity;
    private final WebViewRouting routing = new WebViewRouting();
    /** Re-sends the last state to each observer when the VPN pause changes without a core event. */
    private final Set<Runnable> resend = new CopyOnWriteArraySet<>();
    private final ConnectivityManager.NetworkCallback vpnCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
            setVpnActive(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
        }

        @Override public void onLost(Network network) { setVpnActive(false); }
    };
    private volatile boolean bypassOnVpn;
    private volatile boolean vpnActive;
    private boolean watchingVpn;

    private NoteProxyNetwork(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        connectivity = context.getSystemService(ConnectivityManager.class);
        bypassOnVpn = preferences.getBoolean(BYPASS_ON_VPN, false);
        watchVpn();
        controller = EmbeddedProxyController.get(context, routing);
    }

    void prepare(Consumer<JSObject> done) { controller.prepare(state -> done.accept(toJs(state))); }

    Observation observe(Consumer<JSObject> observer) {
        AtomicReference<ProxyState> last = new AtomicReference<>();
        Runnable again = () -> {
            ProxyState state = last.get();
            if (state != null) observer.accept(toJs(state));
        };
        resend.add(again);
        Observation inner = controller.observe(state -> {
            last.set(state);
            observer.accept(toJs(state));
        });
        return () -> {
            resend.remove(again);
            inner.close();
        };
    }

    void setBypassOnVpn(boolean enabled, Consumer<JSObject> done) {
        preferences.edit().putBoolean(BYPASS_ON_VPN, enabled).apply();
        bypassOnVpn = enabled;
        watchVpn();
        routeChanged();
        status(done);
    }

    void status(Consumer<JSObject> done) { controller.status(state -> done.accept(toJs(state))); }

    void setEnabled(boolean enabled, Consumer<JSObject> done) {
        controller.setEnabled(enabled, state -> done.accept(toJs(state)));
    }

    void retry(Consumer<JSObject> done) { controller.retry(state -> done.accept(toJs(state))); }

    void setBackgroundActive(boolean active) { controller.setBackgroundActive(active); }

    /** The route for native downloads, direct while a VPN pauses the proxy like the WebView. */
    Proxy proxy() { return pausedByVpn() ? Proxy.NO_PROXY : EmbeddedProxyController.networkProxy(); }

    private boolean pausedByVpn() { return bypassOnVpn && vpnActive; }

    /**
     * Follows this app's default network while the switch is on, so a VPN that excludes note by
     * split tunnelling counts as off.
     */
    private synchronized void watchVpn() {
        if (connectivity == null) return;
        if (!bypassOnVpn) {
            vpnActive = false;
            if (watchingVpn) connectivity.unregisterNetworkCallback(vpnCallback);
            watchingVpn = false;
        } else if (!watchingVpn) {
            vpnActive = isVpn(connectivity.getNetworkCapabilities(connectivity.getActiveNetwork()));
            try {
                connectivity.registerDefaultNetworkCallback(vpnCallback);
                watchingVpn = true;
            } catch (RuntimeException ignored) {
                // Without callbacks the state read above stays in force until the switch changes.
            }
        }
    }

    private static boolean isVpn(NetworkCapabilities capabilities) {
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    private void setVpnActive(boolean active) {
        if (vpnActive == active) return;
        vpnActive = active;
        routeChanged();
    }

    private void routeChanged() {
        routing.apply(null);
        for (Runnable again : resend) again.run();
    }


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

    private JSObject toJs(ProxyState state) {
        return new JSObject()
            .put("enabled", state.getEnabled())
            .put("bypassOnVpn", bypassOnVpn)
            .put("pausedByVpn", state.getPhase() == ProxyPhase.RUNNING && pausedByVpn())
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

    /** Applies the core's port to the WebView unless a VPN pauses it; the core keeps running either way. */
    private final class WebViewRouting implements EmbeddedProxyController.Routing {
        private final Handler main = new Handler(Looper.getMainLooper());
        private int port;

        @Override public boolean isSupported() {
            return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
        }

        @Override public void setProxy(int port, Runnable applied) {
            synchronized (this) { this.port = port; }
            apply(applied);
        }

        @Override public void clearProxy(Runnable cleared) {
            synchronized (this) { port = 0; }
            apply(cleared);
        }

        synchronized void apply(Runnable done) {
            Runnable callback = done == null ? () -> {} : done;
            if (port > 0 && !pausedByVpn()) {
                ProxyConfig config = new ProxyConfig.Builder()
                    .addProxyRule("socks://127.0.0.1:" + port)
                    .removeImplicitRules()
                    .build();
                ProxyController.getInstance().setProxyOverride(config, main::post, callback);
            } else if (done != null || port > 0) {
                ProxyController.getInstance().clearProxyOverride(main::post, callback);
            }
        }
    }
}
