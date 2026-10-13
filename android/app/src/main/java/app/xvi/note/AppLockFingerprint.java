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
    private boolean resumed, prompted, pending;
    private Object attempt;
    private Runnable cancel;

    AppLockFingerprint(Host host) {
        this.host = host;
    }

    /** Offers the fingerprint once per visit, after the window has focus. */
    void resumed() {
        resumed = true;
        if (prompted || !offer()) return;
        pending = true;
        host.schedule(scheduled);
    }

    /** A pause alone (a dialog, another window) keeps the visit and any open prompt. */
    void paused() {
        resumed = false;
        if (!pending) return;
        // Not opened yet: offer it again on resume instead of waiting on a hidden pad.
        pending = false;
        prompted = false;
        host.unschedule(scheduled);
    }

    /** Leaving the app ends the visit, so returning offers the fingerprint again. */
    void stopped() {
        paused();
        prompted = false;
        // Invalidate first: cancel may deliver its callback immediately or after a new prompt.
        attempt = null;
        Runnable previous = cancel;
        cancel = null;
        if (previous != null) previous.run();
    }

    void request() {
        if (!resumed || attempt != null) return;
        if (pending) {
            pending = false;
            host.unschedule(scheduled);
        }
        if (!offer()) return;
        Object current = new Object();
        attempt = current;
        Runnable cancellation = host.authenticate(success -> {
            if (attempt != current) return;
            attempt = null;
            cancel = null;
            if (success) host.unlocked();
            else host.showPin(true);
        });
        // A synchronous completion must not leave a stale cancellation handle behind.
        if (attempt == current) cancel = cancellation;
        else cancellation.run();
    }

    /** Hides the pad for a prompt, or shows it when the fingerprint cannot be used. */
    private boolean offer() {
        if (!host.available()) {
            host.showPin(true);
            return false;
        }
        prompted = true;
        host.showPin(false);
        return true;
    }
}
