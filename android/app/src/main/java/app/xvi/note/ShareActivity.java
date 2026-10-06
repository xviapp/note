package app.xvi.note;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.widget.Toast;
import com.getcapacitor.CapConfig;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** The window a share opens in: share.html floating over the sending app. It
 * shows only its own share, and finishing it discards that share unless it was
 * handed to the notebook (for signing in). */
public class ShareActivity extends NoteBridgeActivity {
    private volatile String shareId;
    private boolean handedOver;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        config = shareConfig();
        registerNotePlugins();
        config = ServerConfig.load(this);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // The page draws its own scrim and sheet; everything else shows the app below.
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);
        installWebView();
        if (savedInstanceState != null) shareId = savedInstanceState.getString("share");
        if (shareId == null) receive(getIntent());
    }

    // BridgeActivity switches to the opaque app theme after creating the window.
    @Override
    public void setTheme(int resid) {
        super.setTheme(R.style.ShareTheme);
    }

    private CapConfig shareConfig() {
        try (InputStream input = getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int length; (length = input.read(buffer)) != -1; ) bytes.write(buffer, 0, length);
            JSONObject json = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            json.getJSONObject("server").put("appStartPath", "/share.html");
            // The page reaches under the system bars, so its scrim covers the whole screen.
            json.getJSONObject("plugins").getJSONObject("SystemBars").put("initialViewportFitValueHint", "cover");
            return new CapConfig(getAssets(), json);
        } catch (Exception error) {
            return CapConfig.loadDefault(this);
        }
    }

    private void receive(Intent intent) {
        receiveShare(intent, id -> shareId = id, this::finish);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // A second share while this one is open waits in the inbox for the notebook.
        if (ShareInbox.accepts(intent) && shareId != null)
            receiveShare(intent, id -> Toast.makeText(this, "已暂存，可在页间中继续保存。", Toast.LENGTH_SHORT).show(), () -> {});
    }

    @Override
    public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("share", shareId);
    }

    @Override
    JSONObject pendingShare() throws Exception {
        return shareInbox.get(shareId);
    }

    @Override
    void closeShare(boolean saved, boolean openApp) {
        runOnUiThread(() -> {
            if (saved) Toast.makeText(this, "已保存到页间", Toast.LENGTH_SHORT).show();
            if (openApp) {
                handedOver = true;
                startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }
            finish();
        });
    }

    @Override
    public void finish() {
        if (!handedOver && shareId != null) shareInbox.discard(shareId);
        super.finish();
        overridePendingTransition(0, android.R.anim.fade_out);
    }

    // The page follows the saved theme itself; the window stays clear.
    @Override
    void setThemeBackground(int color, String preference) {}
}
