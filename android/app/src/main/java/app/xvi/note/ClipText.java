package app.xvi.note;

final class ClipText {
    static String checked(String text) {
        String value = text == null ? "" : text.replace("\r\n", "\n").replace('\r', '\n').trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请先输入内容。");
        if (value.length() > 10000) throw new IllegalArgumentException("每条最多 10000 个字。");
        return value;
    }
}
