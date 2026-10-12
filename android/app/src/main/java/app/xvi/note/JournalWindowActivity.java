package app.xvi.note;

/** 今日记: a title, text and photos appended to today's journal entry. */
public class JournalWindowActivity extends PageWindowActivity {
    @Override
    String kind() {
        return "journal";
    }

    @Override
    int maxHeightDp() {
        return 460;
    }

    @Override
    String title() {
        return "今日记";
    }

    @Override
    String detail() {
        return today();
    }
}
