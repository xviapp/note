package app.xvi.note;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.security.MessageDigest;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
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
    public void setSelectionToolbar(PluginCall call) {
        String owner = call.getString("owner");
        if (owner == null) { call.reject("缺少选文区域标识。"); return; }
        boolean enabled = call.getBoolean("enabled", false);
        getActivity().runOnUiThread(() -> {
            if (getBridge().getWebView() instanceof NoteWebView view) {
                view.setSelectionToolbar(owner, enabled);
                call.resolve();
            } else call.reject("当前版本不支持自定义选文菜单。");
        });
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isBlank()) { call.reject("请先选择要分享的文字。"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                getActivity().startActivity(Intent.createChooser(send, "分享选文"));
                call.resolve();
            } catch (android.content.ActivityNotFoundException error) {
                call.reject("没有可接收分享的应用。", error);
            } catch (Exception error) {
                call.reject("无法分享选文，请缩小选择范围后重试。", error);
            }
        });
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void getBuildInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),
                Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
            Signature[] certificates = Build.VERSION.SDK_INT >= 28
                ? info.signingInfo.getApkContentsSigners() : info.signatures;
            call.resolve(new JSObject().put("version", info.versionName)
                .put("build", Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode)
                .put("certificate", hex(MessageDigest.getInstance("SHA-256").digest(certificates[0].toByteArray()))));
        } catch (Exception error) { call.reject("无法读取安装版本。", error); }
    }

    @PluginMethod
    public void pendingWidgetClips(PluginCall call) {
        try {
            ClipUploadJob.schedule(getContext());
            call.resolve(new JSObject().put("items", ClipInbox.list(getContext(), ServerConfig.host(getContext()))));
        } catch (Exception error) { call.reject("无法读取待发送的随手记。", error); }
    }

    @PluginMethod
    public void sentWidgetClips(PluginCall call) {
        try { call.resolve(new JSObject().put("items", ClipInbox.history(getContext(), ServerConfig.host(getContext())))); }
        catch (Exception error) { call.reject("无法读取发送历史。", error); }
    }

    @PluginMethod
    public void markWidgetClipSent(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("缺少随手记标识。"); return; }
        try { ClipInbox.sent(getContext(), ServerConfig.host(getContext()), id, call.getBoolean("encrypted", false)); call.resolve(); }
        catch (Exception error) { call.reject("无法保存发送历史。", error); }
    }

    @PluginMethod
    public void removeWidgetClip(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("缺少随手记标识。"); return; }
        try { ClipInbox.remove(getContext(), ServerConfig.host(getContext()), id); call.resolve(); }
        catch (Exception error) { call.reject("无法更新待发送的随手记。", error); }
    }

    @PluginMethod
    public void clearWidgetClips(PluginCall call) {
        try { ClipInbox.remove(getContext(), ServerConfig.host(getContext()), null); call.resolve(); }
        catch (Exception error) { call.reject("无法清除待发送的随手记。", error); }
    }

    // The app lock (AppLock), set up in 设置 → 密码与设备.
    @PluginMethod
    public void appLockState(PluginCall call) {
        AppLock lock = new AppLock(getContext());
        call.resolve(new JSObject().put("enabled", lock.enabled()).put("pinLength", lock.pinLength())
            .put("biometric", lock.biometric()).put("biometricAvailable", AppLock.biometricAvailable(getContext()))
            .put("timeout", lock.timeout()));
    }

    // Changing or turning off the lock asks for the current PIN, with the lock screen's waits.
    private boolean confirmPin(AppLock lock, PluginCall call) {
        if (!lock.enabled()) return true;
        AppLock.Result result = lock.check(call.getString("current", ""), System.currentTimeMillis());
        if (result == AppLock.Result.OK) return true;
        long wait = lock.waitMillis(System.currentTimeMillis());
        call.reject(wait > 0 ? "PIN 错误次数过多，" + AppLock.waitMessage(wait) + "。" : "当前 PIN 不正确。");
        return false;
    }

    @PluginMethod
    public void appLockSetPin(PluginCall call) {
        AppLock lock = new AppLock(getContext());
        String pin = call.getString("pin", "");
        if (!AppLock.validPin(pin)) { call.reject("PIN 需为 4 到 6 位数字。"); return; }
        if (!confirmPin(lock, call)) return;
        try { lock.setPin(pin); }
        catch (Exception error) { call.reject("无法保存 PIN。", error); return; }
        getActivity().runOnUiThread(() -> host().appLockChanged());
        call.resolve();
    }

    @PluginMethod
    public void appLockDisable(PluginCall call) {
        AppLock lock = new AppLock(getContext());
        if (!confirmPin(lock, call)) return;
        lock.clear();
        getActivity().runOnUiThread(() -> host().appLockChanged());
        call.resolve();
    }

    @PluginMethod
    public void appLockSetBiometric(PluginCall call) {
        AppLock lock = new AppLock(getContext());
        boolean enabled = call.getBoolean("enabled", false);
        if (!lock.enabled()) { call.reject("请先设置 PIN。"); return; }
        if (!enabled) { lock.setBiometric(false); call.resolve(); return; }
        if (!AppLock.biometricAvailable(getContext())) { call.reject("未录入指纹，请先在系统设置中添加。"); return; }
        // Turned on only after a fingerprint has been accepted once.
        getActivity().runOnUiThread(() -> AppLock.authenticate(getActivity(), "验证指纹以启用", "取消", success -> {
            if (!success) { call.reject("未启用指纹解锁。"); return; }
            lock.setBiometric(true);
            call.resolve();
        }));
    }

    @PluginMethod
    public void appLockSetTimeout(PluginCall call) {
        // JSON keeps small numbers as Integer, which getLong() refuses.
        Object value = call.getData().opt("timeout");
        long timeout = value instanceof Number number ? number.longValue() : -1;
        if (!AppLock.validTimeout(timeout)) { call.reject("无效的上锁时间。"); return; }
        new AppLock(getContext()).setTimeout(timeout);
        call.resolve();
    }

    // Content keys of encrypted notes, unlocked here by fingerprint (FingerprintKeys).
    @PluginMethod
    public void fingerprintKeys(PluginCall call) {
        boolean available = AppLock.biometricAvailable(getContext());
        com.getcapacitor.JSArray keys = new com.getcapacitor.JSArray();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            for (String[] key : new FingerprintKeys(getContext()).list())
                keys.put(new JSObject().put("id", key[0]).put("wrapped", key[1]));
        call.resolve(new JSObject().put("available", available).put("keys", keys));
    }

    private void fingerprintDone(PluginCall call, String result, String error, boolean cancelled) {
        if (result != null) call.resolve(new JSObject().put("key", result).put("cancelled", false));
        else if (cancelled) call.resolve(new JSObject().put("cancelled", true));
        else call.reject(error);
    }

    @PluginMethod
    public void fingerprintKeySave(PluginCall call) {
        String id = call.getString("id"), wrapped = call.getString("wrapped"), key = call.getString("key");
        if (id == null || wrapped == null || key == null) { call.reject("缺少密钥。"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !AppLock.biometricAvailable(getContext())) {
            call.reject("未录入指纹，请先在系统设置中添加。");
            return;
        }
        getActivity().runOnUiThread(() -> new FingerprintKeys(getContext()).save(getActivity(), id, wrapped, key,
            (result, error, cancelled) -> fingerprintDone(call, result, error, cancelled)));
    }

    @PluginMethod
    public void fingerprintKeyOpen(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("缺少密钥。"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !AppLock.biometricAvailable(getContext())) {
            call.reject("指纹暂不可用，请输入密码。");
            return;
        }
        // Not over the app lock: the prompt waits until the notebook is unlocked.
        getActivity().runOnUiThread(() -> host().whenUnlocked(
            () -> new FingerprintKeys(getContext()).open(getActivity(), id,
                (result, error, cancelled) -> fingerprintDone(call, result, error, cancelled)),
            () -> call.resolve(new JSObject().put("cancelled", true))));
    }

    @PluginMethod
    public void fingerprintKeyRemove(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) new FingerprintKeys(getContext()).remove(call.getString("id"));
        call.resolve();
    }

    // 忘记 PIN: the page has signed out; remove the session cookie and the lock.
    @PluginMethod
    public void appLockReset(PluginCall call) {
        host().resetAppLock(call::resolve);
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        try { call.resolve(new JSObject().put("share", java.util.Objects.requireNonNullElse(
            host().pendingShare(), org.json.JSONObject.NULL))); }
        catch (Exception error) { call.reject("无法读取待导入内容。", error); }
    }

    @PluginMethod
    public void discardShare(PluginCall call) {
        host().shareInbox.discard(call.getString("id"));
        call.resolve();
    }

    @PluginMethod
    public void closeShare(PluginCall call) {
        host().closeShare(call.getBoolean("saved", false), call.getBoolean("openApp", false));
        call.resolve();
    }

    private NoteBridgeActivity host() {
        return (NoteBridgeActivity) getActivity();
    }

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
            host().setThemeBackground(value, preference);
            call.resolve();
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        getActivity().runOnUiThread(() -> {
            String failure = host().openExternal(Uri.parse(url));
            if (failure == null) call.resolve();
            else call.reject(failure);
        });
    }

    @PluginMethod
    public void setWindowState(PluginCall call) {
        boolean keepAwake = call.getBoolean("keepAwake", false);
        boolean secure = call.getBoolean("secure", false);
        boolean volumeKeys = call.getBoolean("volumeKeys", false);
        getActivity().runOnUiThread(() -> {
            host().setWindowState(keepAwake, secure, volumeKeys);
            call.resolve();
        });
    }

    @PluginMethod
    public void takeLaunch(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject launch = host().takeLaunch();
            call.resolve(launch == null ? new JSObject().put("action", org.json.JSONObject.NULL) : launch);
        });
    }

    @PluginMethod
    public void hideWindow(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            host().hideWindow();
            call.resolve();
        });
    }

    @PluginMethod
    public void closeWindow(PluginCall call) {
        String path = call.getString("path");
        if (path != null && !path.matches("/[A-Za-z0-9/_-]*")) { call.reject("无效的页面地址。"); return; }
        String message = call.getString("message");
        getActivity().runOnUiThread(() -> {
            host().closeWindow(message, path);
            call.resolve();
        });
    }

    @PluginMethod
    public void getServer(PluginCall call) {
        call.resolve(new JSObject().put("host", URI.create(bridge.getLocalUrl()).getHost())
            .put("defaultHost", ServerConfig.defaultHost(getContext()))
            .put("configured", ServerConfig.configured(getContext())));
    }

    /** Chooses the server; a different one restarts the app at its origin. */
    @PluginMethod
    public void setServer(PluginCall call) {
        String host;
        try {
            host = ServerConfig.normalize(call.getString("url"));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        boolean changed = !host.equalsIgnoreCase(URI.create(bridge.getLocalUrl()).getHost());
        ServerConfig.save(getContext(), host);
        call.resolve(new JSObject().put("host", host).put("restarting", changed));
        if (!changed) return;
        Activity activity = getActivity();
        CookieManager.getInstance().flush();
        activity.runOnUiThread(() -> {
            activity.startActivity(new Intent(activity, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            activity.finish();
        });
    }

    @PluginMethod
    public void finishBoot(PluginCall call) {
        host().finishBoot();
        call.resolve();
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        // View haptics need no VIBRATE permission and follow the system setting.
        getActivity().runOnUiThread(() -> {
            getBridge().getWebView().performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
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
        String checksum = call.getString("sha256");
        if (checksum != null && !checksum.matches("[a-f0-9]{64}")) { call.reject("无效的文件校验值。"); return; }
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
                    connection = NoteProxyNetwork.get(getContext()).call(proxy -> {
                        HttpURLConnection opened = (HttpURLConnection) URI.create(url).toURL().openConnection(proxy);
                        opened.setInstanceFollowRedirects(false);
                        opened.setConnectTimeout(15_000);
                        opened.setReadTimeout(60_000);
                        if (cookie != null) opened.setRequestProperty("Cookie", cookie);
                        try {
                            opened.getResponseCode();
                        } catch (java.io.IOException error) {
                            opened.disconnect();
                            throw error;
                        }
                        return opened;
                    });
                    int status = connection.getResponseCode();
                    if (status != 200) throw new java.io.IOException(status == 401 ? "登录已失效，请重新登录。" : "文件下载失败，请重试。");
                    source = connection.getInputStream();
                } else source = new ByteArrayInputStream(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long maximum = url != null && URI.create(url).getPath().startsWith("/api/app/android-release/")
                    ? 200L * 1024 * 1024 : MAX_DOWNLOAD;
                try (InputStream input = source;
                     OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                    if (output == null) throw new java.io.IOException("无法写入所选位置。");
                    byte[] buffer = new byte[32 * 1024];
                    long total = 0;
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        total += length;
                        if (total > maximum) throw new java.io.IOException("文件超过允许的大小。");
                        digest.update(buffer, 0, length);
                        output.write(buffer, 0, length);
                    }
                }
                String checksum = call.getString("sha256");
                if (checksum != null && !checksum.equals(hex(digest.digest())))
                    throw new java.io.IOException("文件校验失败，请重新下载。");
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
