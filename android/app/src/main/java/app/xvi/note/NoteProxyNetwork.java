package app.xvi.note;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.v2ray.ang.AppConfig;
import com.v2ray.ang.core.LauncherManager;
import com.v2ray.ang.embedded.EmbeddedProxy;
import com.v2ray.ang.service.CoreProxyOnlyService;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** Owns host network selection. Core liveness is acknowledged by the daemon, never inferred from a socket or node. */
final class NoteProxyNetwork {
    private static NoteProxyNetwork instance;
    static synchronized NoteProxyNetwork get(Context context) {
        if (instance == null) instance = new NoteProxyNetwork(context.getApplicationContext());
        return instance;
    }
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Consumer<JSObject>> observers = new ArrayList<>();
    private final List<Consumer<JSObject>> waiting = new ArrayList<>();
    private String phase = "off";
    private String message = "";
    private volatile int activePort;
    private int generation;
    private boolean initialized;
    private boolean suspended;
    private boolean applying;
    private long deadline;

    private NoteProxyNetwork(Context context) {
        this.context = context;
        ContextCompat.registerReceiver(context, new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                int key = intent.getIntExtra("key", 0);
                if (!EmbeddedProxy.isEnabled()) {
                    suspended = false;
                    selectDirect("off", "");
                } else if (key == AppConfig.MSG_STATE_START_FAILURE) {
                    fail(context.getString(R.string.proxy_start_failed));
                } else if (key == AppConfig.MSG_STATE_RUNNING || key == AppConfig.MSG_STATE_START_SUCCESS) {
                    if (!suspended) selectProxy(intent.getIntExtra("embeddedPort", 0));
                } else if (key == EmbeddedProxy.STATE_RELOADING) {
                    beginWaiting();
                } else if (key == AppConfig.MSG_STATE_STOP_SUCCESS && !phase.equals("starting") && !suspended) {
                    fail(context.getString(R.string.proxy_stopped));
                }
            }
        }, new IntentFilter(AppConfig.BROADCAST_ACTION_ACTIVITY), ContextCompat.RECEIVER_NOT_EXPORTED);
        main.postDelayed(this::heartbeat, 3000);
    }

    void prepare(Consumer<JSObject> done) {
        main.post(() -> {
            if (initialized && !applying && !phase.equals("starting")) { done.accept(snapshot()); return; }
            waiting.add(done);
            if (!initialized) {
                initialized = true;
                if (EmbeddedProxy.isEnabled()) start();
                else selectDirect("off", "");
            }
        });
    }
    void observe(Consumer<JSObject> observer) { main.post(() -> observers.add(observer)); }
    void unobserve(Consumer<JSObject> observer) { main.post(() -> observers.remove(observer)); }
    void status(Consumer<JSObject> done) { main.post(() -> done.accept(snapshot())); }
    void setEnabled(boolean enabled, Consumer<JSObject> done) {
        main.post(() -> {
            initialized = true;
            waiting.add(done);
            EmbeddedProxy.setEnabled(enabled);
            if (enabled) start();
            else {
                suspended = false;
                LauncherManager.INSTANCE.stopService(context);
                selectDirect("off", "");
            }
        });
    }
    private void beginWaiting() {
        suspended = false;
        deadline = android.os.SystemClock.elapsedRealtime() + 15000;
        phase = "starting";
        message = "";
        publish();
    }
    private void start() {
        beginWaiting();
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            fail(context.getString(R.string.proxy_webview_unsupported));
            return;
        }
        // Query an existing daemon first; two Activities must share one core and one port.
        query((running, port) -> {
            if (suspended || !EmbeddedProxy.isEnabled()) return;
            if (running) selectProxy(port);
            else if (!LauncherManager.startEmbedded(context)) fail(context.getString(R.string.proxy_start_failed));
        });
    }
    private interface DaemonResult { void accept(boolean running, int port); }
    private void query(DaemonResult result) {
        Intent intent = new Intent(AppConfig.BROADCAST_ACTION_SERVICE).setPackage(context.getPackageName());
        intent.putExtra("key", AppConfig.MSG_REGISTER_CLIENT);
        context.sendOrderedBroadcast(intent, null, new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent reply) {
                Bundle extras = getResultExtras(false);
                result.accept(getResultCode() == Activity.RESULT_OK, extras == null ? 0 : extras.getInt("embeddedPort", 0));
            }
        }, main, Activity.RESULT_CANCELED, null, null);
    }
    private void heartbeat() {
        if (initialized && EmbeddedProxy.isEnabled() && !suspended) {
            if (phase.equals("starting") && android.os.SystemClock.elapsedRealtime() >= deadline)
                fail(context.getString(R.string.proxy_start_failed));
            else query((running, port) -> {
                if (suspended || !EmbeddedProxy.isEnabled()) return;
                if (running) selectProxy(port);
                else if (phase.equals("running")) fail(context.getString(R.string.proxy_stopped));
            });
        }
        main.postDelayed(this::heartbeat, 3000);
    }
    private void selectProxy(int port) {
        if (port < 1024 || port > 65535) { fail(context.getString(R.string.proxy_start_failed)); return; }
        if (applying || (phase.equals("running") && activePort == port)) return;
        int token = ++generation;
        applying = true;
        ProxyConfig config = new ProxyConfig.Builder().addProxyRule("http://127.0.0.1:" + port)
            .removeImplicitRules().build();
        try {
            ProxyController.getInstance().setProxyOverride(config, main::post, () -> {
                if (token != generation) return;
                activePort = port;
                EmbeddedProxy.setRoutingPort(port);
                applying = false;
                phase = "running";
                message = "";
                publish();
                complete();
            });
        } catch (RuntimeException error) { fail(context.getString(R.string.proxy_start_failed)); }
    }
    private void fail(String reason) {
        suspended = true;
        // Stop a timed-out/failed core so late acknowledgements cannot restore routing without a retry.
        context.stopService(new Intent(context, CoreProxyOnlyService.class));
        selectDirect("failed", reason);
    }
    private void selectDirect(String nextPhase, String reason) {
        int token = ++generation;
        activePort = 0;
        EmbeddedProxy.setRoutingPort(0);
        applying = true;
        Runnable applied = () -> {
            if (token != generation) return;
            applying = false;
            phase = nextPhase;
            message = reason;
            publish();
            complete();
        };
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE))
            ProxyController.getInstance().clearProxyOverride(main::post, applied);
        else applied.run();
    }
    Proxy proxy() {
        int port = activePort;
        return port == 0 ? Proxy.NO_PROXY : new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", port));
    }
    private JSObject snapshot() {
        return new JSObject().put("enabled", EmbeddedProxy.isEnabled()).put("phase", phase)
            .put("message", message).put("hasProfile", EmbeddedProxy.hasProfile());
    }
    private void publish() { for (Consumer<JSObject> observer : new ArrayList<>(observers)) observer.accept(snapshot()); }
    private void complete() {
        List<Consumer<JSObject>> pending = new ArrayList<>(waiting);
        waiting.clear();
        for (Consumer<JSObject> done : pending) done.accept(snapshot());
    }
}
