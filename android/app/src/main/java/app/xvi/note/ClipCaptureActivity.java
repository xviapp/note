package app.xvi.note;

import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A native capture window: no WebView, note list, or MainActivity. Opened by the
 * launcher shortcut, the quick bar widget and selected text. */
public class ClipCaptureActivity extends Activity {
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private boolean saving;
    private String captureId;
    private EditText input;
    private TextView error;
    private Button save;
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        captureId = state == null ? java.util.UUID.randomUUID().toString() : state.getString("captureId");
        // The card of 今日记 and 青藜 (WindowTheme), centered above the keyboard.
        // Touching the scrim does not close it, so a half-written clip is not lost.
        WindowTheme theme = WindowTheme.of(this);
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(theme.scrim);
        overlay.setClickable(true);
        LinearLayout content = theme.card(this);
        content.addView(theme.header(this, "随手记", null, false, view -> { if (!saving) finish(); }));
        input = new EditText(this); input.setId(R.id.clip_capture_text); input.setHint("记下此刻…");
        input.setTextColor(theme.ink); input.setHintTextColor(theme.muted);
        input.setTextSize(16); input.setGravity(Gravity.TOP); input.setMinLines(4); input.setMaxLines(9);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setBackground(box(theme.raised, theme.lineStrong));
        content.addView(input, spaced(-1));
        error = new TextView(this); error.setTextColor(theme.danger); error.setTextSize(13); error.setVisibility(View.GONE);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(error, spaced(-1));
        save = new Button(this); save.setText("保存"); save.setAllCaps(false); save.setTextSize(14);
        save.setTypeface(WindowTheme.text(this, "", 14, 0, true).getTypeface());
        save.setTextColor(theme.buttonInk); save.setBackground(box(theme.button, theme.button));
        save.setStateListAnimator(null); save.setMinHeight(dp(44)); save.setMinimumHeight(dp(44));
        save.setPadding(dp(16), dp(10), dp(16), dp(10));
        Drawable send = getDrawable(R.drawable.window_send).mutate();
        send.setBounds(0, 0, dp(15), dp(15)); send.setTint(theme.buttonInk);
        save.setCompoundDrawables(send, null, null, null); save.setCompoundDrawablePadding(dp(7));
        save.setOnClickListener(view -> save()); enableSave(false);
        LinearLayout.LayoutParams end = spaced(-2); end.gravity = Gravity.END;
        content.addView(save, end);
        overlay.addView(content, new FrameLayout.LayoutParams(
            Math.min(dp(560), getResources().getDisplayMetrics().widthPixels - dp(32)), -2, Gravity.CENTER));
        // Edge to edge: keep the card clear of the system bars and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(overlay, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { enableSave(!saving && !s.toString().trim().isEmpty()); }
            @Override public void afterTextChanged(Editable text) {}
        });
        setContentView(overlay);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (state != null) input.setText(state.getString("text", ""));
        else {
            // Text selected in another app ("存入随手记"), ready to save or add to.
            CharSequence selected = getIntent().getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            if (selected != null) { input.setText(selected.toString()); input.setSelection(input.length()); }
        }
        input.requestFocus();
    }
    // .button:disabled is the button at --family-disabled opacity.
    private void enableSave(boolean enabled) { save.setEnabled(enabled); save.setAlpha(enabled ? 1 : 0.4f); }
    private LinearLayout.LayoutParams spaced(int width) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, -2); params.topMargin = dp(14); return params;
    }
    // A text box or button: a 1px border and --radius-control.
    private GradientDrawable box(int fill, int border) {
        GradientDrawable box = new GradientDrawable(); box.setColor(fill);
        box.setStroke(Math.max(1, dp(1)), border); box.setCornerRadius(dp(10)); return box;
    }
    private void save() {
        if (saving) return;
        final String text;
        try { text = ClipText.checked(input.getText().toString()); }
        catch (IllegalArgumentException failure) { error.setText(failure.getMessage()); error.setVisibility(View.VISIBLE); return; }
        saving = true; input.setEnabled(false); enableSave(false);
        writer.execute(() -> {
            try {
                ClipInbox.add(this, captureId, text);
                // Closing only waits for durable local storage, never for a network request.
                try { ClipUploadJob.schedule(this); } catch (RuntimeException ignored) { /* Retry when the app next opens. */ }
                runOnUiThread(this::finish);
            } catch (Exception failure) {
                runOnUiThread(() -> {
                    saving = false; input.setEnabled(true); enableSave(true);
                    error.setText("未能保存，请重试。输入内容已保留。"); error.setVisibility(View.VISIBLE);
                });
            }
        });
    }
    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state); state.putString("text", input.getText().toString()); state.putString("captureId", captureId);
    }
    @Override public void onDestroy() { writer.shutdown(); super.onDestroy(); }
}
