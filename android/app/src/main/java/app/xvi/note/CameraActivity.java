package app.xvi.note;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;

/** 随手拍: the system camera writes a photo into CameraInbox, then the photo
 * window adds it to today's journal entry. No camera permission is needed. */
public class CameraActivity extends Activity {
    private static final int CAPTURE = 1;
    private String capture;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // Recreated while the camera was open: its result is still on the way.
        if (state != null) { capture = state.getString("capture"); return; }
        File file = CameraInbox.create(this);
        capture = file.getName();
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // EXTRA_OUTPUT alone does not grant the camera app access on every version.
        intent.setClipData(ClipData.newRawUri("", uri));
        try {
            file.createNewFile();
            startActivityForResult(intent, CAPTURE);
        } catch (ActivityNotFoundException | java.io.IOException error) {
            file.delete();
            Toast.makeText(this, "没有可用的相机应用", Toast.LENGTH_SHORT).show();
            finish();
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != CAPTURE) return;
        File file = capture == null ? null : new File(new File(getFilesDir(), "camera"), capture);
        if (result == RESULT_OK && file != null && file.length() > 0)
            startActivity(new Intent(this, PhotoWindowActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        else if (file != null) file.delete();
        finish();
    }

    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("capture", capture);
    }

    @Override public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }
}
