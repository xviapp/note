package app.xvi.note;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NoteProxy")
public class NoteProxyPlugin extends Plugin {
    private NoteProxyNetwork network;
    private Runnable observation;

    @Override public void load() {
        network = NoteProxyNetwork.get(getContext());
        network.attachWebView();
        observation = network.observe(state -> notifyListeners("status", state));
    }
    @PluginMethod public void prepare(PluginCall call) { network.prepare(call::resolve); }
    @PluginMethod public void getStatus(PluginCall call) { network.status(call::resolve); }
    @PluginMethod public void check(PluginCall call) { network.check(call.getBoolean("force", false), call::resolve); }
    @PluginMethod public void setEnabled(PluginCall call) { network.setEnabled(call.getBoolean("enabled", false), call::resolve); }
    @PluginMethod public void setBypassOnVpn(PluginCall call) { network.setBypassOnVpn(call.getBoolean("enabled", false), call::resolve); }
    @PluginMethod public void setUrl(PluginCall call) {
        try {
            network.setUrl(call.getString("url", ""), call::resolve);
        } catch (ProxyAddress.Invalid error) {
            call.reject(error.getMessage(), error.getMessage());
        }
    }
    @Override protected void handleOnDestroy() {
        if (observation != null) observation.run();
        super.handleOnDestroy();
    }
}
