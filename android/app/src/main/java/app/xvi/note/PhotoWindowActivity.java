package app.xvi.note;

/** 随手拍 after the camera: the page adds the photos in CameraInbox to today's
 * journal entry without a card; it shows one only when it cannot (signed out,
 * no journal). */
public class PhotoWindowActivity extends PageWindowActivity {
    @Override
    String kind() {
        return "photo";
    }

    @Override
    int maxHeightDp() {
        return 0;
    }

    @Override
    boolean showsCard() {
        return false;
    }

    @Override
    String title() {
        return "随手拍";
    }

    @Override
    String detail() {
        return null;
    }
}
