package app.xvi.note;

import java.net.URI;

/** Routing is deliberately narrow: only our API leaves the bundled web origin. */
final class OriginPolicy {
    private final URI origin;

    OriginPolicy(String origin) {
        this.origin = URI.create(origin);
        if (!"https".equals(this.origin.getScheme()) || this.origin.getHost() == null)
            throw new IllegalArgumentException("An HTTPS service origin is required");
    }

    boolean sameOrigin(String value) {
        try {
            URI uri = URI.create(value);
            return uri.getUserInfo() == null && "https".equals(uri.getScheme())
                && origin.getHost().equalsIgnoreCase(uri.getHost()) && port(origin) == port(uri);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    boolean isApi(String value) {
        return sameOrigin(value) && URI.create(value).getRawPath().startsWith("/api/");
    }

    boolean isDownload(String value) {
        return sameOrigin(value) && URI.create(value).getRawPath().matches("/api/files/[a-zA-Z0-9_-]{1,80}");
    }

    boolean isDocument(String value) {
        if (!sameOrigin(value)) return false;
        String path = URI.create(value).getRawPath();
        return path.isEmpty() || path.equals("/") || path.matches("/n/[a-zA-Z0-9_-]{1,80}");
    }

    private static int port(URI uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }
}
