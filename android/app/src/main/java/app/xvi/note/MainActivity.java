package app.xvi.note;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import androidx.activity.OnBackPressedCallback;
import java.io.File;
import androidx.core.graphics.ColorUtils;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends NoteBridgeActivity {
    // A floating window hands over to the notebook at one of its pages.
    static final String ACTION_OPEN = "app.xvi.note.action.OPEN";
    static final String EXTRA_PATH = "path";
    private static final String APPEARANCE_PREFS = "note-appearance";
    // Camera photos for web file inputs are written here and never removed by Capacitor.
    private static final long CAPTURE_MAX_AGE_MS = 24L * 60 * 60 * 1000;
    // Longest the splash waits for the UI; past this the page's own loading shows.
    private static final long BOOT_TIMEOUT_MS = 5000;
    private ColorDrawable themeBackground;
    private volatile boolean booting = true;
    // A page a floating window asked for, kept until the notebook takes it.
    private String launch;
    // The app lock (AppLock): shown over the page while locked.
    private AppLock lock;
    private AppLockView lockView;
    private OnBackPressedCallback lockedBack;
    // A fingerprint prompt the page asked for while locked, with how to drop it.
    private Runnable afterUnlock, dropAfterUnlock;
    private long stoppedAt = -1;
    // A picker or camera this activity started; returning from it is not a return to the app.
    private boolean returningFromResult;
    // How long 忘记 PIN waits for the page to sign out before doing it alone.
    private static final long FORGOT_TIMEOUT_MS = 8000;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keep the actual splash behind the first fingerprint prompt, then
        // reveal the ready page or PIN without changing the waiting artwork.
        SplashScreen.installSplashScreen(this).setKeepOnScreenCondition(() ->
            booting || (lockView != null && lockView.awaitingFingerprint()));
        new Handler(Looper.getMainLooper()).postDelayed(this::finishBoot, BOOT_TIMEOUT_MS);
        registerNotePlugins();
        ServerConfig.keepPreviousDefault(this);
        config = ServerConfig.load(this);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // The first WebView frame precedes the JS bridge/theme callback. Prime
        // every native surface now so the splash never reveals a light canvas.
        restoreThemeBackground();
        installWebView();
        lock = new AppLock(this);
        lockedBack = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true);
            }
        };
        getOnBackPressedDispatcher().addCallback(this, lockedBack);
        appLockChanged();
        if (lock.enabled()) showLock();
        if (savedInstanceState == null) {
            receiveShare(getIntent());
            receiveLaunch(getIntent());
        }
        removeOldCaptures();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receiveShare(intent);
        if (receiveLaunch(intent)) dispatch("note:launch", null);
    }

    @Override
    public void onStart() {
        super.onStart();
        if (lock == null || stoppedAt < 0) return;
        long away = SystemClock.elapsedRealtime() - stoppedAt;
        // A picker or camera may take a while; past five minutes it counts as leaving.
        long allowed = returningFromResult ? Math.max(lock.timeout(), 5 * 60_000) : lock.timeout();
        stoppedAt = -1;
        returningFromResult = false;
        if (lock.enabled() && away >= allowed) showLock();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (lockView != null) lockView.resumed();
    }

    @Override
    public void onPause() {
        if (lockView != null) lockView.paused();
        super.onPause();
    }

    @Override
    public void onStop() {
        super.onStop();
        // The system prompt may pause the activity; only leaving the app cancels it.
        if (lockView != null) lockView.stopped();
        if (lock == null || isChangingConfigurations()) return;
        stoppedAt = SystemClock.elapsedRealtime();
        // Locked at once, so returning never shows the page first.
        if (lock.enabled() && lock.timeout() == 0 && !returningFromResult) showLock();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void startActivityForResult(Intent intent, int requestCode, Bundle options) {
        returningFromResult = true;
        super.startActivityForResult(intent, requestCode, options);
    }

    private void showLock() {
        if (lockView != null || bridge == null) return;
        android.view.View page = bridge.getWebView();
        page.clearFocus();
        InputMethodManager keyboard = getSystemService(InputMethodManager.class);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(page.getWindowToken(), 0);
        lockView = new AppLockView(this, lock, new AppLockView.Host() {
            @Override
            public void unlocked() {
                hideLock();
            }

            @Override
            public void forgot() {
                dispatch("note:app-lock-forgot", null);
                // A page that never answers (not loaded, or broken) is signed out here.
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (lockView != null) resetAppLock(() -> bridge.getWebView().reload());
                }, FORGOT_TIMEOUT_MS);
            }
        });
        addContentView(lockView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT));
        lockedBack.setEnabled(true);
    }

    private void hideLock() {
        if (lockView == null) return;
        ((ViewGroup) lockView.getParent()).removeView(lockView);
        lockView = null;
        lockedBack.setEnabled(false);
        Runnable waiting = afterUnlock;
        afterUnlock = dropAfterUnlock = null;
        // After the lock's own fingerprint prompt has gone.
        if (waiting != null) new Handler(Looper.getMainLooper()).postDelayed(waiting, 300);
    }

    @Override
    void whenUnlocked(Runnable action, Runnable replaced) {
        if (lockView == null) { action.run(); return; }
        if (dropAfterUnlock != null) dropAfterUnlock.run();
        afterUnlock = action;
        dropAfterUnlock = replaced;
    }

    // Recent apps shows no picture of the notebook while the app lock is on.
    @Override
    void appLockChanged() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(!lock.enabled());
    }

    /** 忘记 PIN, after the page has signed out: no session cookie, no waiting
     * 随手记 and no lock are left on this device. */
    @Override
    void resetAppLock(Runnable done) {
        runOnUiThread(() -> {
            try { ClipInbox.remove(this, ServerConfig.host(this), null); }
            catch (Exception ignored) { /* Nothing to clear, or already gone. */ }
            lock.clear();
            appLockChanged();
            CookieManager cookies = CookieManager.getInstance();
            cookies.removeAllCookies(removed -> {
                cookies.flush();
                hideLock();
                done.run();
            });
        });
    }

    private boolean receiveLaunch(Intent intent) {
        if (intent == null || !ACTION_OPEN.equals(intent.getAction())) return false;
        String path = intent.getStringExtra(EXTRA_PATH);
        if (path == null || !path.matches("/[A-Za-z0-9/_-]*")) return false;
        launch = path;
        return true;
    }

    @Override
    com.getcapacitor.JSObject takeLaunch() {
        if (launch == null) return null;
        com.getcapacitor.JSObject value = new com.getcapacitor.JSObject().put("action", "open").put("path", launch);
        launch = null;
        return value;
    }

    private void removeOldCaptures() {
        new Thread(() -> {
            File folder = getExternalFilesDir(android.os.Environment.DIRECTORY_PICTURES);
            File[] photos = folder == null ? null : folder.listFiles();
            if (photos == null) return;
            long cutoff = System.currentTimeMillis() - CAPTURE_MAX_AGE_MS;
            for (File photo : photos)
                if (photo.getName().startsWith("JPEG_") && photo.lastModified() < cutoff) photo.delete();
        }, "note-capture-cleanup").start();
    }

    // Shares open in ShareActivity; an older launcher shortcut or task may still
    // deliver one here, and the notebook's own import dialog then shows it.
    private void receiveShare(Intent intent) {
        receiveShare(intent, id -> {}, () -> {});
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // SystemBars reapplies the OS palette on configuration changes. Restore
        // the app's palette and contrast before the next frame, preserving insets.
        if (bridge != null) restoreThemeBackground();
    }

    private void restoreThemeBackground() {
        String preference = getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE)
            .getString("theme", "system");
        int background = switch (preference) {
            case "light" -> R.color.note_surface_light;
            case "dark" -> R.color.note_surface_dark;
            case "starry" -> R.color.note_surface_starry;
            default -> R.color.note_surface;
        };
        applyThemeBackground(getColor(background));
        updateSplashTheme();
    }

    // The system draws the next cold start's splash before any app code runs.
    // Android 13+ remembers a chosen splash theme, so it matches the app theme;
    // older versions keep the manifest theme, which follows the system.
    private void updateSplashTheme() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        getSplashScreen().setSplashScreenTheme(WindowTheme.splashStyle(this));
    }

    @Override
    void setThemeBackground(int color, String preference) {
        // Save the preference, not its resolved color: system appearance may
        // change while the process is stopped.
        getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).edit()
            .putString("theme", preference).apply();
        applyThemeBackground(color);
        updateSplashTheme();
    }

    private void applyThemeBackground(int color) {
        // Replacing the window drawable resets DecorView's system-bar padding.
        // Mutate the existing drawable after startup to preserve the viewport.
        if (themeBackground == null) {
            themeBackground = new ColorDrawable(color);
            getWindow().setBackgroundDrawable(themeBackground);
        } else themeBackground.setColor(color);
        getWindow().getDecorView().setBackgroundColor(color);
        bridge.getWebView().setBackgroundColor(color);
        // Keep icon contrast and background in one update. SystemBars.setStyle
        // also overwrites the decor background with the OS theme's color.
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(
            getWindow(), getWindow().getDecorView());
        boolean lightBackground = ColorUtils.calculateLuminance(color) > 0.5;
        bars.setAppearanceLightStatusBars(lightBackground);
        bars.setAppearanceLightNavigationBars(lightBackground);
    }

    @Override
    void finishBoot() {
        booting = false;
    }
}
