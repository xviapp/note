package app.xvi.note;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The floating windows (随手记, 今日记, 青藜) drawn natively in the saved theme:
 * --scrim, --surface, --surface-raised, --surface-subtle, --ink, --muted, --line, --line-strong, --button-bg,
 * --button-ink and --danger of src/family-tokens.css and src/themes.css, and the card and
 * header of the share window's sheet (src/share.css). */
final class WindowTheme {
    final int scrim, surface, raised, subtle, ink, muted, line, lineStrong, button, buttonInk, danger;

    private WindowTheme(int scrim, int surface, int raised, int subtle, int ink, int muted, int line, int lineStrong, int button, int buttonInk, int danger) {
        this.scrim = scrim; this.surface = surface; this.raised = raised; this.subtle = subtle; this.ink = ink; this.muted = muted;
        this.line = line; this.lineStrong = lineStrong; this.button = button; this.buttonInk = buttonInk; this.danger = danger;
    }

    static WindowTheme of(Context context) {
        String theme = context.getSharedPreferences("note-appearance", Context.MODE_PRIVATE).getString("theme", "system");
        if ("starry".equals(theme))
            return new WindowTheme(0xB304081A, 0xFF20263B, 0xFF282F47, 0xFF282F47, 0xFFE4E5EF, 0xFFB4BDD2, 0xFF363F59, 0xFF636D8C, 0xFFC4C3E8, 0xFF2C2D49, 0xFFFFB0BF);
        boolean dark = "dark".equals(theme) || ("system".equals(theme)
            && (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        if (dark)
            return new WindowTheme(0xB8000000, 0xFF242220, 0xFF302D29, 0xFF211F1D, 0xFFEEE7DD, 0xFFB9AFA2, 0xFF47413A, 0xFF8E8274, 0xFFB1D0AE, 0xFF233929, 0xFFF3A3A8);
        return new WindowTheme(0x7A282019, 0xFFFFF8EF, 0xFFFFFCF7, 0xFFF0E1CF, 0xFF352E28, 0xFF706357, 0xFFDDCCB7, 0xFF887461, 0xFF426B55, 0xFFFFFFFF, 0xFFA84F4D);
    }

    static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    /** Text as the page sets it: a size and the page's line-height of 1.57. */
    static TextView text(Context context, String value, float size, int color, boolean strong) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        view.setSingleLine(true);
        view.setIncludeFontPadding(false);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setHeight(Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, size * 1.57f,
            context.getResources().getDisplayMetrics())));
        if (strong) view.setTypeface(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? Typeface.create(Typeface.DEFAULT, 600, false) : Typeface.DEFAULT_BOLD);
        return view;
    }

    /** .page-window .share-window-sheet: --surface-raised, a --line border, --radius-panel. */
    LinearLayout card(Context context) {
        return card(context, raised);
    }

    LinearLayout card(Context context, int color) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 20), dp(context, 18), dp(context, 20), dp(context, 18));
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setStroke(Math.max(1, dp(context, 1)), line);
        background.setCornerRadius(dp(context, 20));
        card.setBackground(background);
        return card;
    }

    /** .share-window-header: the title, the line under it (with the calendar of
     * 今日记 when {@code calendar}), and the close button. */
    LinearLayout header(Context context, String title, String detail, boolean calendar, View.OnClickListener close) {
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout heading = new LinearLayout(context);
        heading.setOrientation(LinearLayout.VERTICAL);
        heading.addView(text(context, title, 17, ink, true));
        if (detail != null) {
            LinearLayout line = new LinearLayout(context);
            line.setGravity(Gravity.CENTER_VERTICAL);
            if (calendar) {
                ImageView icon = new ImageView(context);
                icon.setImageResource(R.drawable.window_calendar);
                icon.setImageTintList(ColorStateList.valueOf(muted));
                LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(dp(context, 13), dp(context, 13));
                size.setMarginEnd(dp(context, 5));
                line.addView(icon, size);
            }
            line.addView(text(context, detail, 12, muted, false));
            LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(-2, -2);
            gap.topMargin = dp(context, 3);
            heading.addView(line, gap);
        }
        LinearLayout.LayoutParams grow = new LinearLayout.LayoutParams(0, -2, 1);
        grow.setMarginEnd(dp(context, 10));
        row.addView(heading, grow);
        // .icon-button: 40px, or --family-touch (48px) up to 760px wide (src/shell.css).
        android.util.DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        int size = metrics.widthPixels / metrics.density <= 760 ? 48 : 40;
        ImageButton button = new ImageButton(context);
        button.setImageResource(R.drawable.window_close);
        button.setImageTintList(ColorStateList.valueOf(muted));
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        int inset = dp(context, (size - 18) / 2f);
        button.setPadding(inset, inset, inset, inset);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setContentDescription("关闭");
        button.setOnClickListener(close);
        row.addView(button, new LinearLayout.LayoutParams(dp(context, size), dp(context, size)));
        return row;
    }
}
