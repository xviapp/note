package app.xvi.note;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Durable widget outbox. Device encryption is independent of the library key;
 * a locked library can therefore accept input without exposing it on disk. */
final class ClipInbox {
    private static final String ALIAS = "note-widget-clips";
    private static AtomicFile file(Context context) {
        return new AtomicFile(new File(context.getNoBackupFilesDir(), "widget-clips.json"));
    }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private static JSONArray read(Context context) throws Exception {
        AtomicFile file = file(context);
        if (!file.getBaseFile().exists()) return new JSONArray();
        JSONObject sealed = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(sealed.getString("iv"), Base64.NO_WRAP)));
        return new JSONArray(new String(cipher.doFinal(Base64.decode(sealed.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    private static void write(Context context, JSONArray items) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        JSONObject sealed = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(items.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        AtomicFile file = file(context);
        FileOutputStream output = file.startWrite();
        try {
            output.write(sealed.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
        } catch (Exception error) { file.failWrite(output); throw error; }
    }
    static synchronized void add(Context context, String id, String text) throws Exception {
        text = ClipText.checked(text);
        JSONArray items = read(context);
        for (int i = 0; i < items.length(); i++) if (id.equals(items.getJSONObject(i).getString("id"))) return;
        items.put(new JSONObject().put("id", id).put("text", text)
            .put("host", ServerConfig.host(context)).put("createdAt", System.currentTimeMillis()));
        write(context, items);
    }
    static synchronized JSONArray list(Context context, String host) throws Exception {
        JSONArray all = read(context), result = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.getJSONObject(i);
            if (host.equals(item.getString("host"))) result.put(item);
        }
        return result;
    }
    static synchronized void remove(Context context, String host, String id) throws Exception {
        JSONArray all = read(context), keep = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.getJSONObject(i);
            if (!host.equals(item.getString("host")) || (id != null && !id.equals(item.getString("id")))) keep.put(item);
        }
        write(context, keep);
    }
}
