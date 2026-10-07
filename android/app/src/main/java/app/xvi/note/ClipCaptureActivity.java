package app.xvi.note;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A native capture window: no WebView, note list, or MainActivity. */
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
        setFinishOnTouchOutside(false);
        String theme = getSharedPreferences("note-appearance", MODE_PRIVATE).getString("theme", "system");
        boolean starry = "starry".equals(theme);
        boolean dark = starry || "dark".equals(theme) || ("system".equals(theme)
            && (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        int surface = getColor(starry ? R.color.note_surface_starry : dark ? R.color.note_surface_dark : R.color.note_surface_light);
        int ink = Color.parseColor(dark ? "#ECE6DB" : "#302D28");
        int accent = Color.parseColor(starry ? "#BBB6E4" : dark ? "#ACCAA4" : "#486557");
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(24), dp(20), dp(24), dp(16));
        GradientDrawable background = new GradientDrawable(); background.setColor(surface); background.setCornerRadius(dp(20));
        content.setBackground(background);
        TextView title = new TextView(this); title.setText("随手记"); title.setTextSize(22); title.setTextColor(ink);
        content.addView(title);
        input = new EditText(this); input.setId(R.id.clip_capture_text); input.setHint("记下此刻…");
        input.setTextColor(ink); input.setHintTextColor(dark ? 0xFFAAA69F : 0xFF827A6E);
        input.setTextSize(17); input.setGravity(Gravity.TOP); input.setMinLines(4); input.setMaxLines(9);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setPadding(0, dp(16), 0, dp(16)); input.setBackgroundColor(Color.TRANSPARENT);
        content.addView(input, new LinearLayout.LayoutParams(-1, -2));
        error = new TextView(this); error.setTextColor(dark ? 0xFFFFB4AB : 0xFFAE302A); error.setVisibility(View.GONE);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(error);
        LinearLayout actions = new LinearLayout(this); actions.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        Button cancel = new Button(this); cancel.setText("取消"); cancel.setTextColor(ink); cancel.setBackgroundTintList(android.content.res.ColorStateList.valueOf(surface));
        cancel.setOnClickListener(view -> { if (!saving) finish(); }); actions.addView(cancel);
        save = new Button(this); save.setText("保存"); save.setTextColor(dark ? surface : Color.WHITE);
        save.setBackgroundTintList(android.content.res.ColorStateList.valueOf(accent));
        save.setEnabled(false); save.setOnClickListener(view -> save()); actions.addView(save); content.addView(actions);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { save.setEnabled(!saving && !s.toString().trim().isEmpty()); }
            @Override public void afterTextChanged(Editable text) {}
        });
        setContentView(content);
        getWindow().setLayout(Math.min(dp(560), getResources().getDisplayMetrics().widthPixels - dp(32)), WindowManager.LayoutParams.WRAP_CONTENT);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (state != null) input.setText(state.getString("text", ""));
        input.requestFocus();
    }
    private void save() {
        if (saving) return;
        final String text;
        try { text = ClipText.checked(input.getText().toString()); }
        catch (IllegalArgumentException failure) { error.setText(failure.getMessage()); error.setVisibility(View.VISIBLE); return; }
        saving = true; input.setEnabled(false); save.setEnabled(false);
        writer.execute(() -> {
            try {
                ClipInbox.add(this, captureId, text);
                // Closing only waits for durable local storage, never for a network request.
                try { ClipUploadJob.schedule(this); } catch (RuntimeException ignored) { /* Retry when the app next opens. */ }
                runOnUiThread(this::finish);
            } catch (Exception failure) {
                runOnUiThread(() -> {
                    saving = false; input.setEnabled(true); save.setEnabled(true);
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
