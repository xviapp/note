package app.xvi.note;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import androidx.annotation.RequiresApi;
import org.json.JSONObject;

/** Content keys of encrypted notes kept for fingerprint unlocking. Each is sealed
 * with a Keystore key that only a strong fingerprint unlocks, once per use, and
 * that Android deletes when fingerprints are added. The wrapped key it was
 * unlocked from is kept beside it, so the page can tell a changed password.
 * Entries belong to the server host they were saved for. Android 11 and later. */
@RequiresApi(Build.VERSION_CODES.R)
final class FingerprintKeys {
    private static final String PREFS = "note-fingerprint-keys";
    private static final String ALIAS = "note-fingerprint-keys";

    interface Done {
        /** {@code error} is null on success; {@code cancelled} when the user chose the password. */
        void accept(String result, String error, boolean cancelled);
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final String host;

    FingerprintKeys(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        host = ServerConfig.host(context);
    }

    private String name(String id) {
        return host + "/" + id;
    }

    /** The saved key IDs with the wrapped key each was saved from. */
    List<String[]> list() {
        List<String[]> result = new ArrayList<>();
        String prefix = host + "/";
        for (String name : prefs.getAll().keySet()) {
            if (!name.startsWith(prefix)) continue;
            try {
                JSONObject entry = new JSONObject(prefs.getString(name, "{}"));
                result.add(new String[] {name.substring(prefix.length()), entry.getString("wrapped")});
            } catch (Exception ignored) { }
        }
        return result;
    }

    /** Removes one saved key, or every one for this server when {@code id} is null. */
    void remove(String id) {
        SharedPreferences.Editor edit = prefs.edit();
        if (id != null) edit.remove(name(id));
        else for (String name : prefs.getAll().keySet()) if (name.startsWith(host + "/")) edit.remove(name);
        edit.commit();
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            if (!create) return null;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }

    /** New fingerprints made the Keystore key unusable: drop it and everything sealed with it. */
    private void invalidated() {
        prefs.edit().clear().commit();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(ALIAS);
        } catch (Exception ignored) { }
    }

    /** Seals {@code raw} (base64) after a fingerprint, for {@code id} saved from {@code wrapped}. */
    void save(Activity activity, String id, String wrapped, String raw, Done done) {
        Cipher cipher;
        try {
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            try {
                cipher.init(Cipher.ENCRYPT_MODE, key(true));
            } catch (KeyPermanentlyInvalidatedException error) {
                invalidated();
                cipher.init(Cipher.ENCRYPT_MODE, key(true));
            }
        } catch (Exception error) {
            done.accept(null, "无法启用指纹解锁。", false);
            return;
        }
        authenticate(activity, "验证指纹以启用", "取消", cipher, (unlocked, cancelled) -> {
            if (unlocked == null) { done.accept(null, cancelled ? null : "指纹验证未通过。", cancelled); return; }
            try {
                byte[] sealed = unlocked.doFinal(Base64.decode(raw, Base64.NO_WRAP));
                prefs.edit().putString(name(id), new JSONObject().put("wrapped", wrapped)
                    .put("iv", Base64.encodeToString(unlocked.getIV(), Base64.NO_WRAP))
                    .put("data", Base64.encodeToString(sealed, Base64.NO_WRAP)).toString()).commit();
                done.accept("", null, false);
            } catch (Exception error) {
                done.accept(null, "无法启用指纹解锁。", false);
            }
        });
    }

    /** The key saved for {@code id} (base64), after a fingerprint. */
    void open(Activity activity, String id, Done done) {
        Cipher cipher;
        JSONObject entry;
        try {
            String saved = prefs.getString(name(id), null);
            SecretKey key = saved == null ? null : key(false);
            if (key == null) { done.accept(null, "未在本机启用指纹解锁，请输入密码。", false); return; }
            entry = new JSONObject(saved);
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key,
                new GCMParameterSpec(128, Base64.decode(entry.getString("iv"), Base64.NO_WRAP)));
        } catch (KeyPermanentlyInvalidatedException error) {
            invalidated();
            done.accept(null, "本机指纹有变动，请输入密码后重新启用指纹解锁。", false);
            return;
        } catch (Exception error) {
            done.accept(null, "无法使用指纹解锁，请输入密码。", false);
            return;
        }
        authenticate(activity, "用指纹解锁", "输入密码", cipher, (unlocked, cancelled) -> {
            if (unlocked == null) { done.accept(null, cancelled ? null : "指纹验证未通过。", cancelled); return; }
            try {
                byte[] raw = unlocked.doFinal(Base64.decode(entry.getString("data"), Base64.NO_WRAP));
                done.accept(Base64.encodeToString(raw, Base64.NO_WRAP), null, false);
            } catch (Exception error) {
                done.accept(null, "无法使用指纹解锁，请输入密码。", false);
            }
        });
    }

    private interface Unlocked {
        void accept(Cipher cipher, boolean cancelled);
    }

    private static void authenticate(Activity activity, String title, String fallback, Cipher cipher, Unlocked callback) {
        // The negative button and a cancellation error may both report one prompt.
        boolean[] finished = {false};
        Unlocked done = (unlocked, cancelled) -> {
            if (finished[0]) return;
            finished[0] = true;
            callback.accept(unlocked, cancelled);
        };
        java.util.concurrent.Executor main = activity.getMainExecutor();
        BiometricPrompt prompt = new BiometricPrompt.Builder(activity).setTitle(title)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButton(fallback, main, (dialog, which) -> done.accept(null, true)).build();
        prompt.authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(), main,
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    done.accept(result.getCryptoObject().getCipher(), false);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence message) {
                    done.accept(null, code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED
                        || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED);
                }
            });
    }
}
