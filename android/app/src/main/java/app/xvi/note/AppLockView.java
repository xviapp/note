package app.xvi.note;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** The lock over the notebook: the PIN's dots, a number pad, the fingerprint
 * and 忘记 PIN. Opaque, so nothing of the page shows through. */
// Built in code by MainActivity only, never inflated from a layout.
@SuppressLint("ViewConstructor")
final class AppLockView extends FrameLayout {
    interface Host {
        void unlocked();

        void forgot();
    }

    private final Activity activity;
    private final AppLock lock;
    private final Host host;
    private final WindowTheme theme;
    private final ExecutorService checker = Executors.newSingleThreadExecutor();
    private final StringBuilder typed = new StringBuilder();
    private final LinearLayout dots;
    private final TextView message;
    private final LinearLayout pad, keys, body;
    private final ScrollView pin;
    private final Drawable pinBackground, fingerprintBackground;
    private final AppLockFingerprint fingerprint;
    private boolean checking;

    AppLockView(Activity activity, AppLock lock, Host host) {
        super(activity);
        this.activity = activity;
        this.lock = lock;
        this.host = host;
        theme = WindowTheme.of(activity);
        fingerprint = new AppLockFingerprint(new AppLockFingerprint.Host() {
            @Override public boolean available() { return canPromptFingerprint(); }
            @Override public void schedule(Runnable request) {
                // Wait for window focus before opening the system prompt.
                postDelayed(request, 150);
            }
            @Override public void unschedule(Runnable request) { removeCallbacks(request); }
            @Override public Runnable authenticate(Consumer<Boolean> completed) {
                return AppLock.authenticate(activity, "解锁页间", "使用 PIN", completed)::cancel;
            }
            @Override public void showPin(boolean visible) { AppLockView.this.showPin(visible); }
            @Override public void unlocked() { host.unlocked(); }
        });
        pinBackground = new ColorDrawable(theme.surface);
        fingerprintBackground = new ContextThemeWrapper(activity, WindowTheme.splashStyle(activity))
            .getDrawable(R.drawable.app_lock_splash);
        setBackground(pinBackground);
        setClickable(true);
        setFocusable(true);
        // The mark, title and dots above the pad, or beside it on a phone held sideways.
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        keys = new LinearLayout(activity);
        keys.setOrientation(LinearLayout.VERTICAL);
        keys.setGravity(Gravity.CENTER_HORIZONTAL);
        body = new LinearLayout(activity);
        body.setGravity(Gravity.CENTER);
        body.addView(column);
        body.addView(keys);

        ImageView mark = new ImageView(activity);
        mark.setImageResource(R.mipmap.ic_launcher_round);
        mark.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        column.addView(mark, new LinearLayout.LayoutParams(dp(64), dp(64)));
        TextView title = WindowTheme.text(activity, "输入 PIN", 17, theme.ink, true);
        column.addView(title, margins(-2, 20));

        dots = new LinearLayout(activity);
        dots.setGravity(Gravity.CENTER);
        for (int i = 0; i < lock.pinLength(); i++) {
            View dot = new View(activity);
            LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(dp(12), dp(12));
            size.setMargins(dp(7), 0, dp(7), 0);
            dots.addView(dot, size);
        }
        dots.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        column.addView(dots, margins(-2, 22));

        message = WindowTheme.text(activity, "", 13, theme.muted, false);
        message.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        column.addView(message, margins(-2, 14));

        pad = new LinearLayout(activity);
        pad.setOrientation(LinearLayout.VERTICAL);
        String[] labels = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "finger", "0", "delete"};
        for (int row = 0; row < 4; row++) {
            LinearLayout line = new LinearLayout(activity);
            for (int col = 0; col < 3; col++) line.addView(key(labels[row * 3 + col]), keySize());
            pad.addView(line);
        }
        keys.addView(pad, new LinearLayout.LayoutParams(-2, -2));

        TextView forgot = WindowTheme.text(activity, "忘记 PIN？", 14, theme.muted, false);
        forgot.setPadding(dp(16), 0, dp(16), 0);
        forgot.setHeight(dp(48));
        forgot.setOnClickListener(view -> confirmForgot());
        keys.addView(forgot, margins(-2, 12));
        arrange();

        // Centered when it fits; scrolls on a short screen (a phone held sideways).
        pin = new ScrollView(activity);
        pin.setFillViewport(true);
        FrameLayout centered = new FrameLayout(activity);
        centered.setPadding(0, dp(24), 0, dp(24));
        centered.addView(body, new LayoutParams(-2, -2, Gravity.CENTER));
        pin.addView(centered, new LayoutParams(-1, -2));
        addView(pin, new LayoutParams(-1, -1));
        ViewCompat.setOnApplyWindowInsetsListener(this, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        showTyped();
        refreshWait();
        // Hide the pad before the first frame, including the wait for window focus.
        showPin(!canPromptFingerprint());
    }

    private int dp(float value) {
        return WindowTheme.dp(activity, value);
    }

    private LinearLayout.LayoutParams margins(int width, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, -2);
        params.topMargin = dp(top);
        return params;
    }

    private boolean landscape() {
        return getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
    }

    private LinearLayout.LayoutParams keySize() {
        // Smaller keys sideways, so the pad fits the short side without scrolling.
        int size = landscape() ? 60 : 72;
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(size), dp(size));
        params.setMargins(dp(10), dp(landscape() ? 3 : 6), dp(10), dp(landscape() ? 3 : 6));
        return params;
    }

    // MainActivity handles rotation itself, so the lock rearranges in place.
    private void arrange() {
        boolean wide = landscape();
        body.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        LinearLayout.LayoutParams side = new LinearLayout.LayoutParams(-2, -2);
        if (wide) side.setMarginStart(dp(64));
        else side.topMargin = dp(18);
        keys.setLayoutParams(side);
        for (int row = 0; row < pad.getChildCount(); row++) {
            LinearLayout line = (LinearLayout) pad.getChildAt(row);
            for (int col = 0; col < line.getChildCount(); col++) line.getChildAt(col).setLayoutParams(keySize());
        }
    }

    @Override
    protected void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        arrange();
    }

    private GradientDrawable circle(int fill, int border) {
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(fill);
        if (border != 0) circle.setStroke(Math.max(1, dp(1)), border);
        return circle;
    }

    private View key(String key) {
        RippleDrawable ripple = new RippleDrawable(ColorStateList.valueOf(theme.line),
            key.length() == 1 ? circle(theme.raised, theme.line) : null, circle(0xFFFFFFFF, 0));
        if (key.length() == 1) {
            TextView digit = WindowTheme.text(activity, key, 24, theme.ink, false);
            digit.setHeight(dp(72));
            digit.setGravity(Gravity.CENTER);
            digit.setBackground(ripple);
            digit.setOnClickListener(view -> type(key));
            return digit;
        }
        ImageView icon = new ImageView(activity);
        // At its own 24dp in the middle of the key.
        icon.setScaleType(ImageView.ScaleType.CENTER);
        icon.setImageTintList(ColorStateList.valueOf(theme.muted));
        icon.setBackground(ripple);
        if (key.equals("delete")) {
            icon.setImageResource(R.drawable.window_delete);
            icon.setContentDescription("删除");
            icon.setOnClickListener(view -> {
                if (checking || typed.length() == 0) return;
                typed.setLength(typed.length() - 1);
                showTyped();
            });
        } else if (lock.biometric() && AppLock.biometricAvailable(activity)) {
            icon.setImageResource(R.drawable.window_fingerprint);
            icon.setContentDescription("用指纹解锁");
            icon.setOnClickListener(view -> fingerprint.request());
        } else icon.setVisibility(INVISIBLE);
        return icon;
    }

    private void type(String digit) {
        if (checking || lock.waitMillis(System.currentTimeMillis()) > 0 || typed.length() >= lock.pinLength()) return;
        typed.append(digit);
        message.setText("");
        showTyped();
        if (typed.length() < lock.pinLength()) return;
        checking = true;
        String pin = typed.toString();
        checker.execute(() -> {
            AppLock.Result result = lock.check(pin, System.currentTimeMillis());
            post(() -> {
                checking = false;
                if (result == AppLock.Result.OK) {
                    host.unlocked();
                    return;
                }
                typed.setLength(0);
                showTyped();
                performHapticFeedback(HapticFeedbackConstants.REJECT);
                dots.animate().translationX(dp(10)).setDuration(50).withEndAction(() ->
                    dots.animate().translationX(-dp(10)).setDuration(80).withEndAction(() ->
                        dots.animate().translationX(0).setDuration(50)));
                if (!refreshWait()) {
                    message.setTextColor(theme.danger);
                    message.setText("PIN 不正确");
                }
            });
        });
    }

    private void showTyped() {
        for (int i = 0; i < dots.getChildCount(); i++)
            dots.getChildAt(i).setBackground(i < typed.length()
                ? circle(theme.ink, theme.ink) : circle(0, theme.lineStrong));
        dots.setContentDescription("已输入 " + typed.length() + " 位");
    }

    // While wrong PINs make the pad wait, count down and keep it disabled.
    private boolean refreshWait() {
        long wait = lock.waitMillis(System.currentTimeMillis());
        pad.setAlpha(wait > 0 ? 0.4f : 1);
        if (wait <= 0) return false;
        message.setTextColor(theme.danger);
        message.setText("PIN 错误次数过多，" + AppLock.waitMessage(wait));
        postDelayed(() -> {
            if (isAttachedToWindow() && !refreshWait()) message.setText("");
        }, Math.min(wait, 1000));
        return true;
    }

    /** Offers the fingerprint once each time the lock comes into view. */
    void resumed() {
        fingerprint.resumed();
    }

    void paused() {
        fingerprint.paused();
    }

    void stopped() {
        fingerprint.stopped();
    }

    private boolean canPromptFingerprint() {
        return lock.biometric() && AppLock.biometricAvailable(activity);
    }

    private void showPin(boolean visible) {
        setBackground(visible ? pinBackground : fingerprintBackground);
        pin.setVisibility(visible ? VISIBLE : GONE);
    }

    boolean awaitingFingerprint() {
        return pin.getVisibility() == GONE;
    }

    private void confirmForgot() {
        new AlertDialog.Builder(activity)
            .setTitle("忘记 PIN？")
            .setMessage("将退出登录，并清除本机缓存和未发送的内容。笔记仍在服务器上，重新登录后可再设置 PIN。")
            .setNegativeButton("取消", null)
            .setPositiveButton("退出登录", (dialog, which) -> {
                message.setTextColor(theme.muted);
                message.setText("正在退出登录…");
                checking = true; // until the notebook signs out and removes the lock
                host.forgot();
            })
            .show();
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        fingerprint.stopped();
        checker.shutdown();
    }
}
