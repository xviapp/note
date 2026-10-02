package app.xvi.note;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.UUID;

/** Bounded, backpressured writes to one user-chosen document. */
@CapacitorPlugin(name = "NoteArchive")
public class NoteArchivePlugin extends Plugin {
    private OutputStream output;
    private Uri destination;
    private String token;
    private boolean opening;

    @PluginMethod
    public synchronized void begin(PluginCall call) {
        if (opening || output != null) { call.reject("请先完成当前备份。"); return; }
        opening = true;
        String name = call.getString("name", "页间备份.zip").replaceAll("[/\\\\\\p{Cntrl}]", "_");
        try {
            startActivityForResult(call, new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/zip").putExtra(Intent.EXTRA_TITLE, name.substring(0, Math.min(name.length(), 200))), "chosen");
        } catch (RuntimeException error) { opening = false; call.reject("无法选择备份位置。", error); }
    }
    @ActivityCallback
    private synchronized void chosen(PluginCall call, ActivityResult result) {
        opening = false;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true)); return;
        }
        destination = result.getData().getData();
        try {
            output = getContext().getContentResolver().openOutputStream(destination, "w");
            if (output == null) throw new java.io.IOException();
            token = UUID.randomUUID().toString();
            call.resolve(new JSObject().put("cancelled", false).put("id", token));
        } catch (Exception error) { discard(); call.reject("无法写入备份文件。", error); }
    }
    private boolean valid(PluginCall call) {
        if (token != null && token.equals(call.getString("id")) && output != null) return true;
        call.reject("备份文件已关闭。"); return false;
    }
    @PluginMethod
    public synchronized void write(PluginCall call) {
        if (!valid(call)) return;
        String data = call.getString("data", "");
        if (data.length() > 262144) { discard(); call.reject("备份数据块过大。"); return; }
        try { output.write(Base64.decode(data, Base64.NO_WRAP)); call.resolve(); }
        catch (Exception error) { discard(); call.reject("备份写入失败，请检查剩余空间。", error); }
    }
    @PluginMethod
    public synchronized void finish(PluginCall call) {
        if (!valid(call)) return;
        try { output.close(); output = null; destination = null; token = null; call.resolve(); }
        catch (Exception error) { discard(); call.reject("备份未能保存，请重试。", error); }
    }
    @PluginMethod
    public synchronized void abort(PluginCall call) {
        if (token != null && token.equals(call.getString("id"))) discard();
        call.resolve();
    }
    private void discard() {
        try { if (output != null) output.close(); } catch (Exception ignored) { }
        try { if (destination != null) DocumentsContract.deleteDocument(getContext().getContentResolver(), destination); } catch (Exception ignored) { }
        output = null; destination = null; token = null;
    }
    @Override
    protected synchronized void handleOnDestroy() { discard(); }
}
