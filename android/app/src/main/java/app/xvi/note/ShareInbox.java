package app.xvi.note;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.WebResourceResponse;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

/** Copies granted content URIs while the sender's permission is alive. No path from
 * an external intent is ever used as a filesystem path or sent straight to the API. */
final class ShareInbox {
    private static ShareInbox instance;
    private final Context context;
    private final File root;
    /** One inbox per process: the notebook and the share window may both be open. */
    static synchronized ShareInbox get(Context context) {
        if (instance == null) instance = new ShareInbox(context);
        return instance;
    }
    private ShareInbox(Context context) {
        this.context = context.getApplicationContext();
        root = new File(context.getFilesDir(), "share-inbox");
        root.mkdirs();
    }
    static boolean accepts(Intent intent) {
        return intent != null && (Intent.ACTION_SEND.equals(intent.getAction())
            || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())
            || (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null
                && "content".equals(intent.getData().getScheme())));
    }
    private File[] entries() {
        File[] files = root.listFiles(File::isDirectory);
        if (files == null) return new File[0];
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        return files;
    }
    private void remove(File dir) {
        File[] files = dir.listFiles();
        if (files != null) for (File file : files) file.delete();
        dir.delete();
    }
    synchronized JSONObject next() throws Exception {
        for (File dir : entries()) {
            if (System.currentTimeMillis() - dir.lastModified() > 7L * 86400000) { remove(dir); continue; }
            File manifest = new File(dir, "share.json");
            if (manifest.isFile()) {
                try { return new JSONObject(new String(Files.readAllBytes(manifest.toPath()), StandardCharsets.UTF_8)); }
                catch (Exception ignored) { remove(dir); }
            } else remove(dir);
        }
        return null;
    }
    synchronized void discard(String id) {
        if (id != null && id.matches("[a-f0-9-]{36}")) remove(new File(root, id));
    }
    @SuppressWarnings("deprecation")
    /** The share received as `id`, or null once it has been saved or discarded. */
    synchronized JSONObject get(String id) throws Exception {
        if (id == null || !id.matches("[a-f0-9-]{36}")) return null;
        File manifest = new File(new File(root, id), "share.json");
        if (!manifest.isFile()) return null;
        return new JSONObject(new String(Files.readAllBytes(manifest.toPath()), StandardCharsets.UTF_8));
    }
    /** Copies the share and returns its id; a share that cannot be read is kept with its error. */
    synchronized String receive(Intent intent) throws Exception {
        next(); // Expire abandoned imports.
        if (entries().length >= 4) throw new IOException("请先处理页间中待导入的分享。");
        String id = UUID.randomUUID().toString();
        File dir = new File(root, id); dir.mkdirs();
        JSONObject result = new JSONObject().put("id", id);
        JSONArray files = new JSONArray();
        result.put("files", files);
        try {
            CharSequence supplied = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            String text = supplied == null ? "" : supplied.toString();
            if (text.length() > 1024 * 1024) throw new IOException("分享文字超过 1 MiB。");
            result.put("text", text);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            result.put("title", subject == null ? "" : subject.substring(0, Math.min(200, subject.length())));
            ArrayList<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Uri> suppliedUris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (suppliedUris != null) uris.addAll(suppliedUris);
            } else {
                Uri uri = Intent.ACTION_VIEW.equals(intent.getAction()) ? intent.getData() : intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) uris.add(uri);
            }
            if (uris.isEmpty() && intent.getClipData() != null) {
                for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                    Uri uri = intent.getClipData().getItemAt(i).getUri();
                    if (uri != null && !uris.contains(uri)) uris.add(uri);
                }
            }
            if (uris.size() > 10) throw new IOException("一次最多分享 10 个文件。");
            long total = 0;
            for (Uri uri : uris) {
                if (!"content".equals(uri.getScheme())) throw new IOException("无法读取此分享文件。");
                String name = "分享文件";
                try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (column >= 0) name = cursor.getString(column);
                    }
                }
                if (name == null || name.isBlank()) name = "分享文件";
                name = name.replaceAll("[\\\\/\\p{Cntrl}]", "_");
                name = name.substring(0, Math.min(name.length(), 200));
                String mime = context.getContentResolver().getType(uri);
                if (mime == null || mime.equals("application/octet-stream")) mime = intent.getType();
                String lower = name.toLowerCase(Locale.ROOT);
                if (lower.endsWith(".pdf")) mime = "application/pdf";
                if (lower.endsWith(".md") || lower.endsWith(".markdown")) mime = "text/markdown";
                if (mime != null && mime.equals("text/x-markdown")) mime = "text/markdown";
                if (mime == null || !(mime.equals("application/pdf") || mime.matches("image/(png|jpeg|gif|webp|avif|svg\\+xml)")
                        || mime.matches("text/(plain|markdown)")))
                    throw new IOException("分享文件仅支持 PDF、常用图片、Markdown 和纯文本格式。");
                // Text files are read into the note body, so they share the text limit.
                long limit = mime.startsWith("text/") ? 1024L * 1024 : 50_000_000L;
                String fileId = UUID.randomUUID().toString();
                long size = 0;
                try (InputStream input = context.getContentResolver().openInputStream(uri);
                     OutputStream output = new FileOutputStream(new File(dir, fileId))) {
                    if (input == null) throw new IOException("分享来源未授予文件读取权限。");
                    byte[] buffer = new byte[32768]; int length;
                    while ((length = input.read(buffer)) != -1) {
                        size += length; total += length;
                        if (size > limit || total > 100L * 1024 * 1024)
                            throw new IOException(limit < 50_000_000L ? "文本文件最多 1 MiB。" : "单个文件最多 50 MB，一次分享最多 100 MiB。");
                        output.write(buffer, 0, length);
                    }
                }
                files.put(new JSONObject().put("id", fileId).put("name", name).put("mime", mime).put("size", size)
                    .put("path", "/__share/" + id + "/" + fileId));
            }
            if (text.isBlank() && files.length() == 0) throw new IOException("分享内容为空。");
        } catch (Exception error) {
            for (File file : Objects.requireNonNull(dir.listFiles())) file.delete();
            result.put("files", new JSONArray()).put("error", error.getMessage() == null ? "无法读取分享内容。" : error.getMessage());
        }
        File pending = new File(dir, "share.tmp");
        Files.write(pending.toPath(), result.toString().getBytes(StandardCharsets.UTF_8));
        Files.move(pending.toPath(), new File(dir, "share.json").toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        return id;
    }
    synchronized WebResourceResponse open(String path) {
        if (!path.matches("/__share/[a-f0-9-]{36}/[a-f0-9-]{36}")) return missing();
        String[] parts = path.split("/");
        try {
            File file = new File(new File(root, parts[2]), parts[3]);
            return new WebResourceResponse("application/octet-stream", null, 200, "OK",
                Map.of("Cache-Control", "no-store", "Content-Length", String.valueOf(file.length())), new FileInputStream(file));
        } catch (IOException error) { return missing(); }
    }
    private WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Map.of("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }
}
