package app.xvi.note;

import java.util.function.Consumer;

/** Owns fingerprint attempts across foreground visits. All calls run on the main thread. */
final class AppLockFingerprint {
    interface Host {
        boolean available();
        void schedule(Runnable request);
        void unschedule(Runnable request);
        /** Starts authentication and returns its cancellation action. */
        Runnable authenticate(Consumer<Boolean> completed);
        void showPin(boolean visible);
        void unlocked();
    }

    private final Host host;
    private final Runnable scheduled = this::request;
    private boolean foreground, prompted;
    private Object attempt;
    private Runnable cancel;

    AppLockFingerprint(Host host) {
        this.host = host;
    }

    void resumed() {
        foreground = true;
        if (prompted) return;
        if (!host.available()) {
            host.showPin(true);
            return;
        }
        prompted = true;
        host.showPin(false);
        host.schedule(scheduled);
    }

    void paused() {
        foreground = false;
        prompted = false;
        host.unschedule(scheduled);
        // Invalidate first: cancel may deliver its callback immediately or after a new prompt.
        attempt = null;
        Runnable previous = cancel;
        cancel = null;
        if (previous != null) previous.run();
    }

    void request() {
        if (!foreground || attempt != null) return;
        host.unschedule(scheduled);
        if (!host.available()) {
            host.showPin(true);
            return;
        }
        prompted = true;
        host.showPin(false);
        Object current = new Object();
        attempt = current;
        Runnable cancellation = host.authenticate(success -> {
            if (!foreground || attempt != current) return;
            attempt = null;
            cancel = null;
            if (success) host.unlocked();
            else host.showPin(true);
        });
        // A synchronous completion must not leave a stale cancellation handle behind.
        if (attempt == current) cancel = cancellation;
        else cancellation.run();
    }
}
