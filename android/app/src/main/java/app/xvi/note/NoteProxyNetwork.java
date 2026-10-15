package app.xvi.note;

import android.app.NotificationManager;
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

import java.io.File;
import java.io.IOException;
import java.net.Proxy;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Routes the WebView and native requests through a user-configured external proxy. The proxy is
 * checked when traffic needs it (results are reused for a short while); while it does not answer,
 * traffic goes direct and the UI says so. A VPN can stand in for the proxy when the user allows it.
 */
final class NoteProxyNetwork {
    enum Route { OFF, VPN, CHECKING, PROXY, DIRECT }

    /** A request that can be run again over another route. */
    interface Request<T> { T run(Proxy proxy) throws IOException; }

    private static NoteProxyNetwork instance;

    static synchronized NoteProxyNetwork get(Context context) {
        if (instance == null) instance = new NoteProxyNetwork(context.getApplicationContext());
        return instance;
    }

    private static final String PREFERENCES = "note_proxy";
    private static final String ENABLED = "enabled";
    private static final String URL = "url";
    private static final String BYPASS_ON_VPN = "bypass_on_vpn";
    /** Renamed when the cleanup grows, so devices that ran an earlier one run it again. */
    private static final String LEGACY_CLEARED = "legacy_core_cleared_2";
    private static final long HEALTHY_FOR_MS = 60_000;
    private static final long FAILED_FOR_MS = 15_000;
    /** Longer than one probe, so a native caller gets the fresh answer. */
    private static final long WAIT_MS = 5_000;
    private static final String[] LOCAL_BYPASS = {
        "*.local", "*.lan", "*.home.arpa", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
        "169.254.0.0/16", "100.64.0.0/10", "fc00::/7", "fe80::/10",
    };

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService prober = Executors.newSingleThreadExecutor();
    private final SharedPreferences preferences;
    private final Set<Consumer<JSObject>> observers = new CopyOnWriteArraySet<>();

    // Main thread only, except where volatile.
    private boolean enabled;
    private boolean bypassOnVpn;
    private volatile ProxyAddress address;
    private volatile boolean vpnActive;
    private volatile Route route = Route.OFF;
    /** The last probe's answer: null before any, then whether the proxy answered. */
    private Boolean healthy;
    private String error = "";
    private long checkedAt;
    /** Bumped on every setting change so a probe of the old address is not believed. */
    private int generation;
    private boolean probing;
    private final List<Runnable> waiters = new ArrayList<>();
    /** Set once a WebView exists; a background job alone must not load WebView. */
    private boolean webViewAttached;
    /** The rule WebView was last given, "" for direct (as a new process starts). */
    private String appliedRule = "";
    private Network defaultNetwork;

    private NoteProxyNetwork(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        enabled = preferences.getBoolean(ENABLED, false);
        bypassOnVpn = preferences.getBoolean(BYPASS_ON_VPN, false);
        try { address = ProxyAddress.parse(preferences.getString(URL, "")); }
        catch (ProxyAddress.Invalid ignored) { address = null; }
        watchNetwork(context);
    }

    /** Removes what the embedded proxy core left behind before it was dropped; runs once. */
    static void clearLegacyCore(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        if (preferences.getBoolean(LEGACY_CLEARED, false)) return;
        new Thread(() -> {
            delete(new File(context.getFilesDir(), "mmkv"));
            delete(new File(context.getFilesDir(), "routing"));
            NotificationManager notifications = context.getSystemService(NotificationManager.class);
            if (notifications != null) notifications.deleteNotificationChannel("embedded-proxy");
            for (String name : new String[] { "androidx.work.workdb", "androidx.work.workdb-shm", "androidx.work.workdb-wal" })
                context.deleteDatabase(name);
            preferences.edit().putBoolean(LEGACY_CLEARED, true).apply();
        }, "note-proxy-cleanup").start();
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /**
     * Lets this network steer WebView once the bridge (and so a WebView) exists. The first route is
     * applied when the page prepares: an override set during onCreate stalls bundled assets.
     */
    void attachWebView() { main.post(() -> webViewAttached = true); }

    Runnable observe(Consumer<JSObject> observer) {
        observers.add(observer);
        main.post(() -> { if (observers.contains(observer)) observer.accept(toJs()); });
        return () -> observers.remove(observer);
    }

    void prepare(Consumer<JSObject> done) { check(false, done); }

    void status(Consumer<JSObject> done) { main.post(() -> done.accept(toJs())); }

    /** Checks the proxy if the last answer is old, or always when {@code force}, then routes. */
    void check(boolean force, Consumer<JSObject> done) {
        main.post(() -> ensure(force, () -> done.accept(toJs())));
    }

    void setEnabled(boolean value, Consumer<JSObject> done) {
        main.post(() -> {
            enabled = value;
            preferences.edit().putBoolean(ENABLED, value).apply();
            changed(done);
        });
    }

    /** Saves the address, or clears it when blank; throws {@link ProxyAddress.Invalid} otherwise. */
    void setUrl(String input, Consumer<JSObject> done) {
        ProxyAddress next = input == null || input.trim().isEmpty() ? null : ProxyAddress.parse(input);
        main.post(() -> {
            address = next;
            preferences.edit().putString(URL, next == null ? "" : next.url()).apply();
            changed(done);
        });
    }

    void setBypassOnVpn(boolean value, Consumer<JSObject> done) {
        main.post(() -> {
            bypassOnVpn = value;
            preferences.edit().putBoolean(BYPASS_ON_VPN, value).apply();
            changed(done);
        });
    }

    /** The current route for native clients, without checking. */
    Proxy proxy() {
        ProxyAddress target = address;
        return route == Route.PROXY && target != null ? target.proxy() : Proxy.NO_PROXY;
    }

    /** Checks the proxy if needed and returns the route to use; blocks, so never on the main thread. */
    Proxy awaitProxy(boolean force) {
        CountDownLatch latch = new CountDownLatch(1);
        main.post(() -> ensure(force, latch::countDown));
        try { latch.await(WAIT_MS, TimeUnit.MILLISECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        return proxy();
    }

    /**
     * Runs a request over the current route. When it cannot connect through the proxy and the
     * proxy turns out to be down, it runs once more directly; only pass requests safe to repeat.
     */
    <T> T call(Request<T> request) throws IOException {
        Proxy proxy = awaitProxy(false);
        try {
            return request.run(proxy);
        } catch (SocketException | SocketTimeoutException error) {
            if (proxy == Proxy.NO_PROXY) throw error;
            Proxy next = awaitProxy(true);
            if (next != Proxy.NO_PROXY) throw error;
            return request.run(next);
        }
    }

    private void changed(Consumer<JSObject> done) {
        generation++;
        healthy = null;
        error = "";
        checkedAt = 0;
        ensure(true, () -> done.accept(toJs()));
    }

    private Route desired() {
        if (!enabled || address == null) return Route.OFF;
        if (bypassOnVpn && vpnActive) return Route.VPN;
        if (healthy == null) return Route.CHECKING;
        return healthy ? Route.PROXY : Route.DIRECT;
    }

    /** Main thread. Probes when the proxy is in use and its answer is stale, then settles. */
    private void ensure(boolean force, Runnable done) {
        Route base = desired();
        boolean inUse = base != Route.OFF && base != Route.VPN;
        long age = System.currentTimeMillis() - checkedAt;
        boolean stale = healthy == null || age > (healthy ? HEALTHY_FOR_MS : FAILED_FOR_MS);
        if (!inUse || !(force || stale)) {
            settle(done);
            return;
        }
        if (done != null) waiters.add(done);
        if (probing) return;
        probing = true;
        int started = generation;
        ProxyAddress target = address;
        if (healthy == null) publish();
        prober.execute(() -> {
            String result = ProxyProbe.probe(target);
            main.post(() -> probed(started, result));
        });
    }

    private void probed(int started, String result) {
        probing = false;
        if (started != generation) {
            // The settings changed meanwhile; check what is configured now.
            ensure(true, null);
            return;
        }
        healthy = result.isEmpty();
        error = result;
        checkedAt = System.currentTimeMillis();
        settle(null);
    }

    /** Main thread. Applies the route, then answers everyone waiting; waits for a running probe. */
    private void settle(Runnable done) {
        if (done != null) waiters.add(done);
        if (probing) return;
        Route next = desired();
        route = next;
        ProxyAddress target = address;
        String rule = next == Route.PROXY && target != null ? target.url() : "";
        Runnable finish = () -> {
            List<Runnable> ready = new ArrayList<>(waiters);
            waiters.clear();
            for (Runnable waiter : ready) waiter.run();
            publish();
        };
        if (!webViewAttached || !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
            || rule.equals(appliedRule)) {
            finish.run();
            return;
        }
        appliedRule = rule;
        if (rule.isEmpty()) {
            ProxyController.getInstance().clearProxyOverride(main::post, finish);
        } else {
            ProxyConfig.Builder builder = new ProxyConfig.Builder().addProxyRule(rule);
            // Loopback stays direct by the implicit rules; the local network does too.
            for (String bypass : LOCAL_BYPASS) builder.addBypassRule(bypass);
            ProxyController.getInstance().setProxyOverride(builder.build(), main::post, finish);
        }
    }

    private void publish() {
        if (observers.isEmpty()) return;
        JSObject state = toJs();
        for (Consumer<JSObject> observer : observers) observer.accept(state);
    }

    private JSObject toJs() {
        ProxyAddress target = address;
        return new JSObject()
            .put("enabled", enabled)
            .put("url", target == null ? "" : target.url())
            .put("bypassOnVpn", bypassOnVpn)
            .put("route", desired().name().toLowerCase(Locale.ROOT))
            .put("checkedAt", checkedAt)
            .put("error", error);
    }

    /**
     * Follows this app's default network: a new network makes the last answer stale, and a VPN
     * (one that leaves note out by split tunnelling does not count) may stand in for the proxy.
     */
    private void watchNetwork(Context context) {
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        if (connectivity == null) return;
        Network active = connectivity.getActiveNetwork();
        defaultNetwork = active;
        vpnActive = isVpn(connectivity.getNetworkCapabilities(active));
        try {
            connectivity.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) {
                    if (network.equals(defaultNetwork)) return;
                    defaultNetwork = network;
                    networkChanged();
                }

                @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    boolean vpn = isVpn(capabilities);
                    if (vpn == vpnActive) return;
                    vpnActive = vpn;
                    networkChanged();
                }

                @Override public void onLost(Network network) {
                    defaultNetwork = null;
                    vpnActive = false;
                    networkChanged();
                }
            }, main);
        } catch (RuntimeException ignored) {
            // Without callbacks the state read above stays in force; answers still expire.
        }
    }

    private static boolean isVpn(NetworkCapabilities capabilities) {
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    private void networkChanged() {
        checkedAt = 0;
        ensure(true, null);
    }
}
