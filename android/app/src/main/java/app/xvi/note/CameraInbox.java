package app.xvi.note;

import android.content.Context;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Photos taken for 随手拍, kept in app storage until the page has queued them
 * for the journal. A photo the page could not take yet stays for the next time. */
final class CameraInbox {
    private static final String NAME = "[a-f0-9-]{36}\\.jpg";
    private CameraInbox() {}

    private static File root(Context context) {
        File root = new File(context.getFilesDir(), "camera");
        root.mkdirs();
        return root;
    }

    /** A new, empty file for the camera app to write. */
    static File create(Context context) {
        return new File(root(context), UUID.randomUUID() + ".jpg");
    }

    /** The photos waiting, oldest first; empty files are a capture that never finished. */
    static synchronized JSONArray list(Context context) throws Exception {
        File[] files = root(context).listFiles((dir, name) -> name.matches(NAME));
        JSONArray result = new JSONArray();
        if (files == null) return result;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        long now = System.currentTimeMillis();
        for (File file : files) {
            // A capture that never finished, or one abandoned for a week.
            if (file.length() == 0 ? now - file.lastModified() > 3600_000L : now - file.lastModified() > 7L * 86400000) {
                file.delete();
                continue;
            }
            if (file.length() == 0) continue;
            String id = file.getName().substring(0, 36);
            result.put(new JSONObject().put("id", id).put("path", "/__camera/" + id).put("takenAt", file.lastModified()));
        }
        return result;
    }

    static synchronized void discard(Context context, String id) {
        if (id != null && id.matches("[a-f0-9-]{36}")) new File(root(context), id + ".jpg").delete();
    }

    static WebResourceResponse open(Context context, String path) {
        if (path.matches("/__camera/[a-f0-9-]{36}")) {
            File file = new File(root(context), path.substring(10) + ".jpg");
            try {
                return new WebResourceResponse("image/jpeg", null, 200, "OK",
                    Map.of("Cache-Control", "no-store", "Content-Length", String.valueOf(file.length())), new FileInputStream(file));
            } catch (IOException ignored) { /* Gone: answered as missing. */ }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Map.of("Cache-Control", "no-store"),
            new ByteArrayInputStream(new byte[0]));
    }
}
