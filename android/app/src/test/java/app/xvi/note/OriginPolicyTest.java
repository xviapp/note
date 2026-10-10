package app.xvi.note;

import static org.junit.Assert.*;
import org.junit.Test;

public class OriginPolicyTest {
    private final OriginPolicy policy = new OriginPolicy("https://note.xvi.app");

    @Test
    public void apiUsesNetworkWhileDocumentAndAssetsStayBundled() {
        assertTrue(policy.isApi("https://note.xvi.app/api/auth/status"));
        assertTrue(policy.isApi("https://note.xvi.app/api/nodes/note_1/chat?cursor=2"));
        assertFalse(policy.isApi("https://note.xvi.app/assets/index.js"));
        assertFalse(policy.isApi("https://note.xvi.app/n/note_1"));
        assertFalse(policy.isApi("https://note.xvi.app/api-other"));
        assertTrue(policy.isDocument("https://note.xvi.app/#setup=token"));
        assertTrue(policy.isDocument("https://note.xvi.app/n/note_1"));
        assertFalse(policy.isDocument("https://note.xvi.app/api/files/file_1"));
    }

    @Test
    public void collectionAndSettingsRoutesStayInTheBundledApp() {
        for (String path : new String[] {
            "/favorites", "/recent", "/offline", "/trash", "/settings",
            "/settings/theme", "/settings/reading", "/settings/ai", "/settings/offline",
            "/settings/share", "/settings/backup", "/settings/storage", "/settings/account", "/settings/about",
            "/settings/server"
        }) {
            assertTrue(path, policy.isDocument("https://note.xvi.app" + path));
            assertFalse(path, policy.isDocument("https://other.test" + path));
        }
        for (String path : new String[] { "/settings/unknown", "/settings/proxy", "/settings/../api/auth", "/settings%2Ftheme", "/favorites/other" })
            assertFalse(path, policy.isDocument("https://note.xvi.app" + path));
    }

    @Test
    public void downloadCookiesNeverGoToAnotherOrigin() {
        assertTrue(policy.isDownload("https://note.xvi.app/api/files/file_1?download=1"));
        assertTrue(policy.isDownload("https://NOTE.xvi.app:443/api/files/file-1"));
        for (String url : new String[] {
            "http://note.xvi.app/api/files/file_1",
            "https://note.xvi.app:444/api/files/file_1",
            "https://note.xvi.app.example.org/api/files/file_1",
            "https://note.xvi.app@evil.test/api/files/file_1",
            "https://user@note.xvi.app/api/files/file_1",
            "https://evil.test/api/files/file_1",
            "file:///api/files/file_1",
            "not a url"
        }) {
            assertFalse(url, policy.isDownload(url));
            assertFalse(url, policy.isApi(url));
            assertFalse(url, policy.isDocument(url));
        }
    }

    @Test
    public void onlyFileEndpointsMayBeDownloaded() {
        for (String path : new String[] {
            "/api/files/", "/api/files/a/../b", "/api/files/%2e%2e",
            "/api/files/a%2Fb", "/api/files/a/b", "/api/auth/status",
            "/api/files/a;other", "/assets/index.js"
        }) assertFalse(path, policy.isDownload("https://note.xvi.app" + path));
    }

    @Test(expected = IllegalArgumentException.class)
    public void serviceMustUseHttps() {
        new OriginPolicy("http://note.xvi.app");
    }

    @Test
    public void signedReleaseDownloadsStayOnTheServiceOrigin() {
        String hash = new String(new char[64]).replace('\0', 'a');
        String path = "/api/app/android-release/7/" + hash + ".apk";
        assertTrue(policy.isDownload("https://note.xvi.app" + path));
        assertFalse(policy.isDownload("https://other.test" + path));
        assertFalse(policy.isDownload("https://note.xvi.app/api/app/android-release"));
        assertFalse(policy.isDownload("https://note.xvi.app" + path.replace("/7/", "/../")));
        assertFalse(policy.isDownload("https://note.xvi.app" + path.replace(hash, "bad-hash")));
    }
}
