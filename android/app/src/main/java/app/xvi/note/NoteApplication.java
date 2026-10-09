package app.xvi.note;

import android.app.Application;
import com.v2ray.ang.api.ProxyCore;

public final class NoteApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        ProxyCore.initialize(this, true);
    }
}
