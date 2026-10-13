package app.xvi.note;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
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
        WindowTheme theme = WindowTheme.of(this);
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        float dp = metrics.density;
        int width = Math.round(Math.min(560 * dp, metrics.widthPixels - 32 * dp));
        int height = Math.round(Math.min(maxHeightDp() * dp, metrics.heightPixels - 48 * dp));
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(theme.scrim);
        overlay.setClickable(true);
        boolean journal = "journal".equals(kind());
        LinearLayout header = theme.header(this, title(), detail(), journal, view -> finish());
        LinearLayout card;
        if (journal) {
            card = theme.card(this);
            card.addView(header);
        } else {
            // 青藜's panel: the heading on --surface-subtle above a line, the conversation on --surface.
            card = theme.card(this, theme.surface);
            card.setPadding(0, 0, 0, 0);
            card.setClipToOutline(true);
            header.setPadding(WindowTheme.dp(this, 20), WindowTheme.dp(this, 18), WindowTheme.dp(this, 20), WindowTheme.dp(this, 12));
            header.setBackgroundColor(theme.subtle);
            card.addView(header);
            View line = new View(this);
            line.setBackgroundColor(theme.line);
            card.addView(line, new LinearLayout.LayoutParams(-1, Math.max(1, WindowTheme.dp(this, 1))));
        }
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
