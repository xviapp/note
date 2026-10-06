package app.xvi.note;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.function.Consumer;

@CapacitorPlugin(name = "NoteProxy")
public class NoteProxyPlugin extends Plugin {
    private NoteProxyNetwork network;
    private final Consumer<JSObject> changed = state -> notifyListeners("status", state);
    @Override public void load() {
        network = NoteProxyNetwork.get(getContext());
        network.observe(changed);
    }
    @PluginMethod public void prepare(PluginCall call) { network.prepare(call::resolve); }
    @PluginMethod public void getStatus(PluginCall call) { network.status(call::resolve); }
    @PluginMethod public void setEnabled(PluginCall call) { network.setEnabled(call.getBoolean("enabled", false), call::resolve); }
    @PluginMethod public void retry(PluginCall call) { network.setEnabled(true, call::resolve); }
    @PluginMethod public void getInfo(PluginCall call) {
        call.resolve(new JSObject().put("sourceVersion", com.v2ray.ang.BuildConfig.SOURCE_VERSION)
            .put("sourceCommit", com.v2ray.ang.BuildConfig.SOURCE_COMMIT)
            .put("coreVersion", com.v2ray.ang.core.CoreNativeManager.INSTANCE.getLibVersion()));
    }
    @PluginMethod public void openLicenses(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().startActivity(new Intent(getActivity(), com.v2ray.ang.embedded.LicenseActivity.class));
            call.resolve();
        });
    }
    @PluginMethod public void openConfiguration(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().startActivity(new Intent(getActivity(), com.v2ray.ang.ui.main.MainActivity.class));
            call.resolve();
        });
    }
    @Override protected void handleOnDestroy() {
        network.unobserve(changed);
        super.handleOnDestroy();
    }
}
