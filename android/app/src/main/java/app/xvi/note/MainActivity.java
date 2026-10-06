package app.xvi.note;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.core.graphics.ColorUtils;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends NoteBridgeActivity {
    private static final String APPEARANCE_PREFS = "note-appearance";
    // Longest the splash waits for the UI; past this the page's own loading shows.
    private static final long BOOT_TIMEOUT_MS = 5000;
    private ColorDrawable themeBackground;
    private volatile boolean booting = true;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Hold the splash until the UI reports its first screen, so the mark
        // stays put instead of giving way to the page's smaller loading logo.
        SplashScreen.installSplashScreen(this).setKeepOnScreenCondition(() -> booting);
        new Handler(Looper.getMainLooper()).postDelayed(this::finishBoot, BOOT_TIMEOUT_MS);
        registerNotePlugins();
        config = ServerConfig.load(this);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // The first WebView frame precedes the JS bridge/theme callback. Prime
        // every native surface now so the splash never reveals a light canvas.
        restoreThemeBackground();
        installWebView();
        if (savedInstanceState == null) receiveShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receiveShare(intent);
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
    }

    @Override
    void setThemeBackground(int color, String preference) {
        // Save the preference, not its resolved color: system appearance may
        // change while the process is stopped.
        getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).edit()
            .putString("theme", preference).apply();
        applyThemeBackground(color);
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
