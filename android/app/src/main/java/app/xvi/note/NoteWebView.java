package app.xvi.note;

import android.content.Context;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import com.getcapacitor.CapacitorWebView;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Keeps Chromium's selection handles while the page supplies reading actions. */
public class NoteWebView extends CapacitorWebView {
    private final Set<String> selectionOwners = new HashSet<>();
    private ActionMode selectionMode;

    public NoteWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    void setSelectionToolbar(String owner, boolean enabled) {
        boolean before = !selectionOwners.isEmpty();
        if (enabled) selectionOwners.add(owner);
        else selectionOwners.remove(owner);
        if (before != !selectionOwners.isEmpty() && selectionMode != null) selectionMode.invalidate();
    }

    void resetSelectionToolbar() {
        selectionOwners.clear();
        if (selectionMode != null) selectionMode.invalidate();
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        if (type != ActionMode.TYPE_FLOATING) return super.startActionMode(callback, type);
        return super.startActionMode(new ActionMode.Callback2() {
            private final List<MenuItem> hidden = new ArrayList<>();

            private void restoreItems() {
                for (MenuItem item : hidden) item.setVisible(true);
                hidden.clear();
            }

            private void hideItems(Menu menu) {
                if (selectionOwners.isEmpty()) return;
                for (int i = 0; i < menu.size(); i++) {
                    MenuItem item = menu.getItem(i);
                    if (item.isVisible()) {
                        hidden.add(item);
                        item.setVisible(false);
                    }
                }
            }

            @Override
            public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                boolean created = callback.onCreateActionMode(mode, menu);
                if (created) {
                    selectionMode = mode;
                    hideItems(menu);
                }
                return created;
            }

            @Override
            public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                // Chromium may reuse this mode when focus moves to an editor.
                boolean restored = !hidden.isEmpty();
                restoreItems();
                boolean changed = callback.onPrepareActionMode(mode, menu);
                // Keep the mode alive so Chromium retains the selection and handles.
                hideItems(menu);
                return changed || restored || !hidden.isEmpty();
            }

            @Override
            public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                return callback.onActionItemClicked(mode, item);
            }

            @Override
            public void onDestroyActionMode(ActionMode mode) {
                if (selectionMode == mode) selectionMode = null;
                callback.onDestroyActionMode(mode);
            }

            @Override
            public void onGetContentRect(ActionMode mode, View view, Rect rect) {
                if (callback instanceof ActionMode.Callback2 positioned)
                    positioned.onGetContentRect(mode, view, rect);
                else super.onGetContentRect(mode, view, rect);
            }
        }, type);
    }
}
