package app.xvi.note;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.v2ray.ang.api.EmbeddedProxyController;
import com.v2ray.ang.api.ProxyCore;
import com.v2ray.ang.api.ProxyInfo;
import com.v2ray.ang.api.Observation;

@CapacitorPlugin(name = "NoteProxy")
public class NoteProxyPlugin extends Plugin {
    private NoteProxyNetwork network;
    private Observation observation;

    @Override public void load() {
        network = NoteProxyNetwork.get(getContext());
        observation = network.observe(state -> notifyListeners("status", state));
    }
    @PluginMethod public void prepare(PluginCall call) { network.prepare(call::resolve); }
    @PluginMethod public void getStatus(PluginCall call) { network.status(call::resolve); }
    @PluginMethod public void setEnabled(PluginCall call) { network.setEnabled(call.getBoolean("enabled", false), call::resolve); }
    @PluginMethod public void retry(PluginCall call) { network.retry(call::resolve); }
    @PluginMethod public void saveSubscription(PluginCall call) {
        network.saveSubscription(call.getString("url", ""),
            call.getInt("updateIntervalMinutes", 1440), call.getInt("testIntervalMinutes", 5), call::resolve);
    }
    @PluginMethod public void updateSubscription(PluginCall call) { network.updateSubscription(call::resolve); }
    @PluginMethod public void selectNextNode(PluginCall call) { network.selectNextNode(call::resolve); }
    @PluginMethod public void getInfo(PluginCall call) {
        ProxyInfo info = ProxyCore.info();
        call.resolve(new JSObject().put("sourceVersion", info.sourceVersion)
            .put("sourceCommit", info.sourceCommit).put("coreVersion", info.coreVersion));
    }
    @Override protected void handleOnDestroy() {
        if (observation != null) observation.close();
        super.handleOnDestroy();
    }
}
