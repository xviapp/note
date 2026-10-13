package app.xvi.note;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.junit.Test;

public class AppLockFingerprintTest {
    @Test
    public void returningAfterHomeOffersFingerprintAgainOnTheSameLock() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        host.runScheduled();
        assertEquals(1, host.attempts.size());

        // Android can dismiss the prompt before the activity receives onPause.
        host.attempts.get(0).complete(false);
        fingerprint.paused();
        fingerprint.resumed();
        host.runScheduled();

        assertEquals("Returning to the still-locked activity must offer fingerprint again", 2,
            host.attempts.size());
        assertFalse(host.pinVisible);
    }

    @Test
    public void pausingCancelsActivePromptAndReopensOnResume() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        host.runScheduled();

        fingerprint.paused();
        assertTrue(host.attempts.get(0).canceled);
        host.attempts.get(0).complete(false);
        fingerprint.request();
        assertEquals(1, host.attempts.size());

        fingerprint.resumed();
        host.runScheduled();
        assertEquals(2, host.attempts.size());
        assertFalse(host.pinVisible);
    }

    @Test
    public void pausingRemovesPromptScheduledBeforeWindowFocus() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        assertEquals(1, host.scheduled.size());

        fingerprint.paused();
        assertTrue(host.scheduled.isEmpty());
        host.runScheduled();
        fingerprint.request();
        assertTrue(host.attempts.isEmpty());

        fingerprint.resumed();
        host.runScheduled();
        assertEquals(1, host.attempts.size());
    }

    @Test
    public void staleCallbacksCannotReplaceOrUnlockTheNewPrompt() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        host.runScheduled();
        Attempt old = host.attempts.get(0);
        fingerprint.paused();
        fingerprint.resumed();
        host.runScheduled();

        old.complete(false);
        old.complete(true);
        assertFalse(host.pinVisible);
        assertEquals(0, host.unlocks);
        fingerprint.request();
        assertEquals(2, host.attempts.size());

        Attempt current = host.attempts.get(1);
        current.complete(true);
        current.complete(true);
        current.complete(false);
        assertEquals(1, host.unlocks);
        assertFalse(host.pinVisible);
    }

    @Test
    public void choosingPinDoesNotAutomaticallyReopenFingerprintInTheSameVisit() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        host.runScheduled();
        host.attempts.get(0).complete(false);
        assertTrue(host.pinVisible);

        fingerprint.resumed();
        host.runScheduled();
        assertEquals(1, host.attempts.size());
        assertTrue(host.pinVisible);

        fingerprint.request();
        assertEquals(2, host.attempts.size());
        assertFalse(host.pinVisible);
    }

    @Test
    public void manualRequestReplacesPendingAutomaticPrompt() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        fingerprint.request();
        assertTrue(host.scheduled.isEmpty());
        assertEquals(1, host.attempts.size());

        host.attempts.get(0).complete(false);
        host.runScheduled();
        assertEquals(1, host.attempts.size());
        assertTrue(host.pinVisible);
    }

    @Test
    public void unavailableBiometricsKeepPinAvailable() {
        FakeHost host = new FakeHost();
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        host.available = false;
        fingerprint.resumed();
        assertTrue(host.pinVisible);
        assertTrue(host.scheduled.isEmpty());

        host.available = true;
        fingerprint.resumed();
        host.available = false;
        host.runScheduled();
        assertTrue(host.attempts.isEmpty());
        assertTrue(host.pinVisible);
    }

    @Test
    public void synchronousCancellationCannotChangeTheWaitingBackground() {
        FakeHost host = new FakeHost();
        host.completeOnCancel = true;
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        host.runScheduled();

        fingerprint.paused();
        assertTrue(host.attempts.get(0).canceled);
        assertFalse(host.pinVisible);
        assertEquals(0, host.unlocks);

        fingerprint.resumed();
        host.runScheduled();
        assertEquals(2, host.attempts.size());
    }

    @Test
    public void synchronousFailureDoesNotLeaveAnActivePrompt() {
        FakeHost host = new FakeHost();
        host.completeDuringAuthentication = false;
        AppLockFingerprint fingerprint = new AppLockFingerprint(host);
        fingerprint.resumed();
        host.runScheduled();
        assertTrue(host.pinVisible);

        host.completeDuringAuthentication = null;
        fingerprint.request();
        assertEquals(2, host.attempts.size());
        assertFalse(host.pinVisible);
    }

    private static final class Attempt {
        final Consumer<Boolean> completed;
        boolean canceled;
        Attempt(Consumer<Boolean> completed) { this.completed = completed; }
        void complete(boolean success) { completed.accept(success); }
    }

    private static final class FakeHost implements AppLockFingerprint.Host {
        final List<Runnable> scheduled = new ArrayList<>();
        final List<Attempt> attempts = new ArrayList<>();
        boolean available = true, pinVisible = true, completeOnCancel;
        Boolean completeDuringAuthentication;
        int unlocks;
        @Override public boolean available() { return available; }
        @Override public void schedule(Runnable request) { scheduled.add(request); }
        @Override public void unschedule(Runnable request) { scheduled.remove(request); }
        @Override public Runnable authenticate(Consumer<Boolean> completed) {
            Attempt attempt = new Attempt(completed);
            attempts.add(attempt);
            if (completeDuringAuthentication != null) attempt.complete(completeDuringAuthentication);
            return () -> {
                attempt.canceled = true;
                if (completeOnCancel) attempt.complete(false);
            };
        }
        @Override public void showPin(boolean visible) { pinVisible = visible; }
        @Override public void unlocked() { unlocks++; }
        void runScheduled() {
            List<Runnable> ready = new ArrayList<>(scheduled);
            scheduled.clear();
            for (Runnable request : ready) request.run();
        }
    }
}
