package app.xvi.note;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.util.Base64;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** The optional PIN (and fingerprint) asked for when the notebook opens. Only
 * MainActivity is locked: 随手记, 今日记, 青藜 and the share window are not. The
 * PIN never leaves this device; only a salted PBKDF2 hash is kept. */
final class AppLock {
    private static final String PREFS = "note-app-lock";
    // How long the notebook may stay out of sight before it locks again.
    static final long[] TIMEOUTS = {0, 60_000, 300_000, 1_800_000};
    static final long DEFAULT_TIMEOUT = 60_000;
    private static final int ITERATIONS = 100_000;
    // Wrong PINs before each further one makes the next wait: 30 s, doubling up to 15 min.
    static final int FREE_ATTEMPTS = 5;
    static final long FIRST_WAIT = 30_000, LONGEST_WAIT = 15 * 60_000;

    enum Result { OK, WRONG, WAIT }

    private final SharedPreferences prefs;

    AppLock(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    boolean enabled() {
        return prefs.contains("hash");
    }

    int pinLength() {
        return prefs.getInt("length", 0);
    }

    boolean biometric() {
        return enabled() && prefs.getBoolean("biometric", false);
    }

    long timeout() {
        long value = prefs.getLong("timeout", DEFAULT_TIMEOUT);
        return validTimeout(value) ? value : DEFAULT_TIMEOUT;
    }

    static boolean validPin(String pin) {
        return pin != null && pin.matches("[0-9]{4,6}");
    }

    static boolean validTimeout(long value) {
        for (long timeout : TIMEOUTS) if (timeout == value) return true;
        return false;
    }

    /** Sets (or replaces) the PIN; the fingerprint and timeout choices stay. */
    void setPin(String pin) throws GeneralSecurityException {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        prefs.edit().putString("salt", Base64.encodeToString(salt, Base64.NO_WRAP))
            .putString("hash", Base64.encodeToString(hash(pin, salt), Base64.NO_WRAP))
            .putInt("length", pin.length()).remove("failures").remove("waitUntil").commit();
    }

    void setBiometric(boolean enabled) {
        prefs.edit().putBoolean("biometric", enabled).commit();
    }

    void setTimeout(long timeout) {
        prefs.edit().putLong("timeout", timeout).commit();
    }

    void clear() {
        prefs.edit().clear().commit();
    }

    /** How long until another PIN may be tried; 0 when it may be now. */
    long waitMillis(long now) {
        long until = prefs.getLong("waitUntil", 0);
        // A clock set back must not extend the wait past its longest.
        return until <= now ? 0 : Math.min(until - now, LONGEST_WAIT);
    }

    /** Checks a PIN, counting wrong ones toward the next wait. Slow: call off the UI thread. */
    synchronized Result check(String pin, long now) {
        if (waitMillis(now) > 0) return Result.WAIT;
        String salt = prefs.getString("salt", null), stored = prefs.getString("hash", null);
        boolean right;
        try {
            right = salt != null && stored != null && validPin(pin) && MessageDigest.isEqual(
                Base64.decode(stored, Base64.NO_WRAP), hash(pin, Base64.decode(salt, Base64.NO_WRAP)));
        } catch (GeneralSecurityException | IllegalArgumentException error) {
            right = false;
        }
        if (right) {
            prefs.edit().remove("failures").remove("waitUntil").commit();
            return Result.OK;
        }
        int failures = prefs.getInt("failures", 0) + 1;
        long wait = waitAfter(failures);
        SharedPreferences.Editor edit = prefs.edit().putInt("failures", failures);
        if (wait > 0) edit.putLong("waitUntil", now + wait);
        edit.commit();
        return Result.WRONG;
    }

    /** The wait imposed after this many wrong PINs in a row. */
    static long waitAfter(int failures) {
        if (failures < FREE_ATTEMPTS) return 0;
        return Math.min(FIRST_WAIT << Math.min(failures - FREE_ATTEMPTS, 10), LONGEST_WAIT);
    }

    static byte[] hash(String pin, byte[] salt) throws GeneralSecurityException {
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, ITERATIONS, 256);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } finally {
            spec.clearPassword();
        }
    }

    /** "请 30 秒后再试" for a wait still running. */
    static String waitMessage(long millis) {
        long seconds = (millis + 999) / 1000;
        return seconds < 60 ? "请 " + seconds + " 秒后再试" : "请 " + ((seconds + 59) / 60) + " 分钟后再试";
    }

    /** Fingerprints (class 3 biometrics) enrolled and usable; Android 11 and later. */
    static boolean biometricAvailable(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false;
        BiometricManager manager = context.getSystemService(BiometricManager.class);
        return manager != null && manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            == BiometricManager.BIOMETRIC_SUCCESS;
    }

    /** Shows the system fingerprint prompt; {@code done} gets whether it succeeded. */
    static CancellationSignal authenticate(Activity activity, String title, String fallback,
                                           java.util.function.Consumer<Boolean> done) {
        CancellationSignal cancel = new CancellationSignal();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            done.accept(false);
            return cancel;
        }
        java.util.concurrent.Executor main = activity.getMainExecutor();
        BiometricPrompt prompt = new BiometricPrompt.Builder(activity).setTitle(title)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButton(fallback, main, (dialog, which) -> done.accept(false)).build();
        prompt.authenticate(cancel, main, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                done.accept(true);
            }

            @Override
            public void onAuthenticationError(int code, CharSequence message) {
                done.accept(false);
            }
        });
        return cancel;
    }
}
