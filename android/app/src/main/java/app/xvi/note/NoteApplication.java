package app.xvi.note;

import android.app.Application;

public final class NoteApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        NoteProxyNetwork.clearLegacyCore(this);
    }
}
