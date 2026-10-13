package app.xvi.note;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** A 4×1 bar: the notebook, then the 随手记, 今日记 and 问青藜 windows. */
public class QuickBarWidget extends AppWidgetProvider {
    private static final int[] BUTTONS = {
        R.id.quick_bar_app, R.id.quick_bar_clip, R.id.quick_bar_journal, R.id.quick_bar_qingli,
    };
    private static final Class<?>[] TARGETS = {
        MainActivity.class, ClipCaptureActivity.class, JournalWindowActivity.class, AssistantWindowActivity.class,
    };

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews view = new RemoteViews(context.getPackageName(), R.layout.quick_bar);
            for (int i = 0; i < BUTTONS.length; i++)
                view.setOnClickPendingIntent(BUTTONS[i], PendingIntent.getActivity(context, id * BUTTONS.length + i,
                    intent(context, TARGETS[i]), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            manager.updateAppWidget(id, view);
        }
    }

    private static Intent intent(Context context, Class<?> target) {
        Intent intent = new Intent(context, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // Bring back the running notebook like its launcher icon does.
        if (target == MainActivity.class)
            intent.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        return intent;
    }
}
