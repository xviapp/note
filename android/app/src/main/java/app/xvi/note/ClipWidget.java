package app.xvi.note;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** A single capture action; never starts the notebook activity. */
public class ClipWidget extends AppWidgetProvider {
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews view = new RemoteViews(context.getPackageName(), R.layout.clip_widget);
            Intent intent = new Intent(context, ClipCaptureActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            view.setOnClickPendingIntent(R.id.clip_widget, PendingIntent.getActivity(context, id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            manager.updateAppWidget(id, view);
        }
    }
}
