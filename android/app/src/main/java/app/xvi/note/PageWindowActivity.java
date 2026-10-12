package app.xvi.note;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.getcapacitor.JSObject;
import java.time.LocalDate;

/** A floating window over whatever app is open, opened from a launcher
 * shortcut: window.html shows one tool (今日记 or 青藜) without the notebook. */
abstract class PageWindowActivity extends NoteBridgeActivity {
    // Longest the native card stands in for the page.
    private static final long BOOT_TIMEOUT_MS = 5000;
    private View placeholder;

    /** What window.html shows: "journal" or "assistant". */
    abstract String kind();

    /** The card's largest height in dp; its width is that of src/share.css and windowCard(). */
    abstract int maxHeightDp();

    /** The card's title and the line under it, as the page shows them. */
    abstract String title();

    abstract String detail();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerNotePlugins();
        config = ServerConfig.loadPage(this, "/window.html");
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // The page draws its own scrim and sheet; everything else shows the app below.
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);
        installWebView();
        showPlaceholder();
    }

    // The WebView takes a moment to start in a cold process. Until the page has
    // drawn its card (finishBoot), the same card is drawn natively, so the
    // window appears at once like the native 随手记 window.
    private void showPlaceholder() {
        String theme = getSharedPreferences("note-appearance", MODE_PRIVATE).getString("theme", "system");
        boolean starry = "starry".equals(theme);
        boolean dark = starry || "dark".equals(theme) || ("system".equals(theme)
            && (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        // --scrim, --surface-raised, --ink and --muted of src/family-tokens.css and themes.css.
        int scrim = starry ? 0xB304081A : dark ? 0xB8000000 : 0x7A282019;
        int raised = starry ? 0xFF282F47 : dark ? 0xFF302D29 : 0xFFFFFCF7;
        int ink = dark ? 0xFFECE6DB : 0xFF302D28;
        int muted = dark ? 0xFFAAA69F : 0xFF827A6E;
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        float dp = metrics.density;
        int width = Math.round(Math.min(560 * dp, metrics.widthPixels - 32 * dp));
        int height = Math.round(Math.min(maxHeightDp() * dp, metrics.heightPixels - 48 * dp));
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(scrim);
        overlay.setClickable(true);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(Math.round(20 * dp), Math.round(18 * dp), Math.round(20 * dp), Math.round(18 * dp));
        GradientDrawable background = new GradientDrawable();
        background.setColor(raised);
        background.setCornerRadius(20 * dp); // --radius-panel
        card.setBackground(background);
        TextView heading = new TextView(this);
        heading.setText(title());
        heading.setTextColor(ink);
        heading.setTextSize(17);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(heading);
        TextView sub = new TextView(this);
        sub.setText(detail());
        sub.setTextColor(muted);
        sub.setTextSize(12);
        sub.setPadding(0, Math.round(3 * dp), 0, 0);
        card.addView(sub);
        overlay.addView(card, new FrameLayout.LayoutParams(width, height, Gravity.CENTER));
        addContentView(overlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        placeholder = overlay;
        new Handler(Looper.getMainLooper()).postDelayed(this::finishBoot, BOOT_TIMEOUT_MS);
    }

    @Override
    void finishBoot() {
        runOnUiThread(() -> {
            View view = placeholder;
            placeholder = null;
            if (view == null) return;
            view.animate().alpha(0).setDuration(120).withEndAction(() -> ((ViewGroup) view.getParent()).removeView(view));
        });
    }

    /** Today as the page writes it: 2026年10月12日 星期一. */
    static String today() {
        LocalDate date = LocalDate.now();
        String[] days = {"一", "二", "三", "四", "五", "六", "日"};
        return date.getYear() + "年" + date.getMonthValue() + "月" + date.getDayOfMonth() + "日 星期"
            + days[date.getDayOfWeek().getValue() - 1];
    }

    // BridgeActivity switches to the opaque app theme after creating the window.
    @Override
    public void setTheme(int resid) {
        super.setTheme(R.style.ShareTheme);
    }

    @Override
    JSObject takeLaunch() {
        return new JSObject().put("action", kind());
    }

    @Override
    void hideWindow() {
        // Out of sight while the page finishes its request; it closes itself after.
        if (!moveTaskToBack(true)) finish();
    }

    @Override
    void closeWindow(String message, String path) {
        if (message != null) Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        if (path != null)
            startActivity(new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_OPEN)
                .putExtra(MainActivity.EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    @Override
    public void finish() {
        super.finish();
        overridePendingTransition(0, android.R.anim.fade_out);
    }

    // The page follows the saved theme itself; the window stays clear.
    @Override
    void setThemeBackground(int color, String preference) {}
}
