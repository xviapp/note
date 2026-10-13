package app.xvi.note;

import static org.junit.Assert.*;
import org.junit.Test;

public class AppLockTest {
    @Test
    public void pinsAreFourToSixDigits() {
        assertTrue(AppLock.validPin("1234"));
        assertTrue(AppLock.validPin("000000"));
        assertFalse(AppLock.validPin("123"));
        assertFalse(AppLock.validPin("1234567"));
        assertFalse(AppLock.validPin("12a4"));
        assertFalse(AppLock.validPin("１２３４"));
        assertFalse(AppLock.validPin(null));
    }

    @Test
    public void onlyOfferedTimeoutsAreAccepted() {
        for (long timeout : AppLock.TIMEOUTS) assertTrue(AppLock.validTimeout(timeout));
        assertFalse(AppLock.validTimeout(1));
        assertFalse(AppLock.validTimeout(-60_000));
    }

    @Test
    public void wrongPinsWaitLongerUpToFifteenMinutes() {
        for (int failures = 0; failures < AppLock.FREE_ATTEMPTS; failures++)
            assertEquals(0, AppLock.waitAfter(failures));
        assertEquals(30_000, AppLock.waitAfter(5));
        assertEquals(60_000, AppLock.waitAfter(6));
        assertEquals(480_000, AppLock.waitAfter(9));
        assertEquals(AppLock.LONGEST_WAIT, AppLock.waitAfter(10));
        assertEquals(AppLock.LONGEST_WAIT, AppLock.waitAfter(1000));
    }

    @Test
    public void waitsAreShownInSecondsThenMinutes() {
        assertEquals("请 30 秒后再试", AppLock.waitMessage(29_001));
        assertEquals("请 1 秒后再试", AppLock.waitMessage(1));
        assertEquals("请 2 分钟后再试", AppLock.waitMessage(61_000));
        assertEquals("请 15 分钟后再试", AppLock.waitMessage(AppLock.LONGEST_WAIT));
    }

    @Test
    public void hashDependsOnPinAndSalt() throws Exception {
        byte[] salt = new byte[16], other = new byte[16];
        other[0] = 1;
        byte[] hash = AppLock.hash("1234", salt);
        assertEquals(32, hash.length);
        assertArrayEquals(hash, AppLock.hash("1234", salt));
        assertFalse(java.util.Arrays.equals(hash, AppLock.hash("1235", salt)));
        assertFalse(java.util.Arrays.equals(hash, AppLock.hash("1234", other)));
    }
}
