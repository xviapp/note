package app.xvi.note;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.webkit.CookieManager;
import com.v2ray.ang.embedded.EmbeddedProxy;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** The system owns retries after the capture window has gone away. */
public class ClipUploadJob extends JobService {
    private static final int JOB_ID = 7311;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean stopped;
    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        // Do not replace an active job when another capture arrives.
        if (scheduler.getPendingJob(JOB_ID) != null) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, ClipUploadJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
            .setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
    }
    @Override public boolean onStartJob(JobParameters params) {
        stopped = false;
        executor.execute(() -> {
            boolean retry = false;
            try {
                // Never silently bypass the configured proxy. Its foreground
                // lifetime is owned by the app; a later app visit can sync too.
                if (EmbeddedProxy.isEnabled()) { jobFinished(params, true); return; }
                String host = ServerConfig.host(this), origin = "https://" + host;
                String cookie = CookieManager.getInstance().getCookie(origin);
                if (cookie == null) { jobFinished(params, true); return; }
                HttpURLConnection settings = (HttpURLConnection) URI.create(origin + "/api/clips/key").toURL().openConnection();
                try {
                    settings.setInstanceFollowRedirects(false);
                    settings.setConnectTimeout(15000); settings.setReadTimeout(15000);
                    settings.setRequestProperty("Cookie", cookie);
                    if (settings.getResponseCode() != 200) { jobFinished(params, true); return; }
                    try (var input = settings.getInputStream()) {
                        ByteArrayOutputStream response = new ByteArrayOutputStream();
                        byte[] buffer = new byte[4096];
                        int length;
                        while ((length = input.read(buffer)) != -1) response.write(buffer, 0, length);
                        JSONObject value = new JSONObject(new String(response.toByteArray(), StandardCharsets.UTF_8));
                        // The library key is only available to its unlocked UI. Never
                        // upload an encrypted library's capture as plaintext.
                        if (!value.isNull("keyId")) { jobFinished(params, true); return; }
                    }
                } finally { settings.disconnect(); }
                JSONArray items = ClipInbox.list(this, host);
                for (int i = 0; i < items.length() && !stopped; i++) {
                    JSONObject item = items.getJSONObject(i);
                    HttpURLConnection connection = (HttpURLConnection) URI.create(origin + "/api/clips").toURL().openConnection();
                    try {
                        connection.setInstanceFollowRedirects(false);
                        connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
                        connection.setRequestMethod("POST"); connection.setDoOutput(true);
                        connection.setRequestProperty("Origin", origin);
                        connection.setRequestProperty("Cookie", cookie);
                        connection.setRequestProperty("Content-Type", "application/json");
                        connection.setRequestProperty("x-idempotency-key", item.getString("id"));
                        byte[] body = new JSONObject().put("id", item.getString("id")).put("text", item.getString("text"))
                            .put("createdAt", item.getLong("createdAt")).toString().getBytes(StandardCharsets.UTF_8);
                        try (var output = connection.getOutputStream()) { output.write(body); }
                        int status = connection.getResponseCode();
                        if (status >= 200 && status < 300) ClipInbox.remove(this, host, item.getString("id"));
                        else { retry = true; break; }
                    } finally { connection.disconnect(); }
                }
                retry |= ClipInbox.list(this, host).length() > 0;
            } catch (Exception error) { retry = true; }
            if (!stopped) jobFinished(params, retry);
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { stopped = true; return true; }
    @Override public void onDestroy() { stopped = true; executor.shutdownNow(); super.onDestroy(); }
}
