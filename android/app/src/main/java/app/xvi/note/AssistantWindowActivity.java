package app.xvi.note;

/** 问青藜: the global conversation as a floating card. */
public class AssistantWindowActivity extends PageWindowActivity {
    @Override
    String kind() {
        return "assistant";
    }

    @Override
    int maxHeightDp() {
        return 720;
    }

    @Override
    String title() {
        return "青藜";
    }

    @Override
    String detail() {
        return "全局对话";
    }
}
