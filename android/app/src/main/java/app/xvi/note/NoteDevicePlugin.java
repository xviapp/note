package app.xvi.note;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.CookieManager;
import android.widget.Toast;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;

@CapacitorPlugin(name = "NoteDevice")
public class NoteDevicePlugin extends Plugin {
    private volatile boolean saving;
    private static final long MAX_DOWNLOAD = 50L * 1024 * 1024;

    @PluginMethod
    public void setBackground(PluginCall call) {
        String color = call.getString("color", "");
        String preference = call.getString("preference", "system");
        if (!color.matches("#[0-9a-fA-F]{6}") || !preference.matches("system|light|dark|starry")) {
            call.reject("无效的主题颜色。");
            return;
        }
        getActivity().runOnUiThread(() -> {
            int value = Color.parseColor(color);
            // SystemBars handles insets; background and icon contrast are updated
            // together to follow the app even when Android uses another theme.
            ((MainActivity) getActivity()).setThemeBackground(value, preference);
            call.resolve();
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).openExternal(Uri.parse(url));
            call.resolve();
        });
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String message = call.getString("message", "操作未完成，请重试。");
        getActivity().runOnUiThread(() -> Toast.makeText(getContext(), message, Toast.LENGTH_LONG).show());
        call.resolve();
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        if (saving) {
            call.reject("请先完成上一次保存。");
            return;
        }
        String url = call.getString("url");
        String data = call.getString("data");
        if (url != null ? !new OriginPolicy(bridge.getLocalUrl()).isDownload(url)
                        : data == null || data.length() > 8 * 1024 * 1024) {
            call.reject("无法保存这个文件。");
            return;
        }
        saving = true;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mime", "application/octet-stream"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "页间文件").replaceAll("[/\\\\]", "_"));
        try {
            startActivityForResult(call, intent, "fileChosen");
        } catch (RuntimeException error) {
            saving = false;
            call.reject("无法打开文件保存窗口。", error);
        }
    }

    @ActivityCallback
    private void fileChosen(PluginCall call, ActivityResult result) {
        if (call == null) { saving = false; return; }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            saving = false;
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        Uri destination = result.getData().getData();
        if (destination == null) {
            saving = false;
            call.reject("未选择保存位置。");
            return;
        }
        String url = call.getString("url");
        String cookie = url == null ? null : CookieManager.getInstance().getCookie(url);
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                InputStream source;
                if (url != null) {
                    connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(15_000);
                    connection.setReadTimeout(60_000);
                    if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                    int status = connection.getResponseCode();
                    if (status != 200) throw new java.io.IOException(status == 401 ? "登录已失效，请重新登录。" : "文件下载失败，请重试。");
                    source = connection.getInputStream();
                } else source = new ByteArrayInputStream(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
                try (InputStream input = source;
                     OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                    if (output == null) throw new java.io.IOException("无法写入所选位置。");
                    byte[] buffer = new byte[32 * 1024];
                    long total = 0;
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        total += length;
                        if (total > MAX_DOWNLOAD) throw new java.io.IOException("文件超过 50 MiB。");
                        output.write(buffer, 0, length);
                    }
                }
                getActivity().runOnUiThread(() ->
                    Toast.makeText(getContext(), "已保存到所选位置", Toast.LENGTH_SHORT).show());
                call.resolve(new JSObject().put("cancelled", false));
            } catch (Exception error) {
                try { DocumentsContract.deleteDocument(getContext().getContentResolver(), destination); }
                catch (Exception ignored) { }
                call.reject(error.getMessage() == null ? "文件保存失败，请重试。" : error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
                saving = false;
            }
        }, "note-download").start();
    }
}
