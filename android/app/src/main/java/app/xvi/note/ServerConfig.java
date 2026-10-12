package app.xvi.note;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.CapConfig;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/** The server this app talks to. The bundled UI is served at that HTTPS origin,
 * so its session, offline copies and local settings stay with each server. */
final class ServerConfig {
    private static final String PREFS = "note-server";
    private static final String HOST = "host";
    private static final String HOST_PATTERN =
        "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+";

    private ServerConfig() {}

    /** A host from what a person typed: a bare domain or an https URL of the site root. */
    static String normalize(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请输入服务器地址。");
        if (!value.contains("://")) value = "https://" + value;
        URI uri;
        try {
            uri = new URI(value);
        } catch (Exception error) {
            throw new IllegalArgumentException("服务器地址格式不正确。");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()))
            throw new IllegalArgumentException("服务器需要使用 https 地址。");
        String path = uri.getRawPath();
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
            || (path != null && !path.isEmpty() && !path.equals("/")))
            throw new IllegalArgumentException("只填写站点地址，例如 https://note.example.com。");
        if (uri.getPort() != -1 && uri.getPort() != 443)
            throw new IllegalArgumentException("服务器需要使用默认的 443 端口。");
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (!host.matches(HOST_PATTERN)) throw new IllegalArgumentException("服务器域名不正确。");
        return host;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject bundled(Context context) throws Exception {
        try (InputStream input = context.getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int count; (count = input.read(buffer)) != -1;) bytes.write(buffer, 0, count);
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    /** The host the app was built for. */
    static String defaultHost(Context context) {
        try {
            return bundled(context).getJSONObject("server").getString("hostname");
        } catch (Exception error) {
            throw new IllegalStateException("capacitor.config.json has no server hostname", error);
        }
    }

    /** Whether a server was chosen on this device (at first launch or in settings). */
    static boolean configured(Context context) {
        return prefs(context).contains(HOST);
    }

    static String host(Context context) {
        String saved = prefs(context).getString(HOST, null);
        return saved == null ? defaultHost(context) : saved;
    }

    static void save(Context context, String host) {
        prefs(context).edit().putString(HOST, host).commit();
    }

    /** Capacitor's bundled configuration with the chosen server as its hostname. */
    static CapConfig load(Context context) {
        try {
            JSONObject config = bundled(context);
            String host = host(context);
            if (host.equals(config.getJSONObject("server").getString("hostname")))
                return CapConfig.loadDefault(context);
            config.getJSONObject("server").put("hostname", host);
            File directory = new File(context.getNoBackupFilesDir(), "capacitor");
            if (!directory.isDirectory() && !directory.mkdirs())
                throw new IllegalStateException("Cannot create " + directory);
            try (FileOutputStream output = new FileOutputStream(new File(directory, "capacitor.config.json"))) {
                output.write(config.toString().getBytes(StandardCharsets.UTF_8));
            }
            return CapConfig.loadFromFile(context, directory.getAbsolutePath());
        } catch (Exception error) {
            // A broken saved file must not keep the app from opening its default server.
            return CapConfig.loadDefault(context);
        }
    }

    /** The configuration of a floating window (share, 今日记, 青藜): the chosen
     * server, started at its own page, drawn under the system bars so the page's
     * scrim covers the whole screen. */
    static CapConfig loadPage(Context context, String startPath) {
        try {
            JSONObject config = bundled(context);
            config.getJSONObject("server").put("hostname", host(context)).put("appStartPath", startPath);
            config.getJSONObject("plugins").getJSONObject("SystemBars").put("initialViewportFitValueHint", "cover");
            return new CapConfig(context.getAssets(), config);
        } catch (Exception error) {
            return load(context);
        }
    }
}
