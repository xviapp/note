import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FingerprintState } from '../fingerprint-keys';

const mock = vi.hoisted(() => ({
  state: null as FingerprintState | null,
  listeners: new Set<() => void>(),
  unlock: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../fingerprint-keys', () => ({
  fingerprintState: () => mock.state,
  subscribeFingerprint: (listener: () => void) => {
    mock.listeners.add(listener);
    return () => mock.listeners.delete(listener);
  },
  loadFingerprint: async () => mock.state,
  saveFingerprint: mock.save,
  unlockWithFingerprint: mock.unlock,
  removeFingerprint: async () => {},
}));
vi.mock('../mobile', () => ({ notice: vi.fn() }));
import { UnlockForm } from './Encryption';

const kept = (ids: string[]): FingerprintState => ({
  available: true,
  keys: new Map(ids.map((id) => [id, 'wrapped'])),
});

beforeEach(() => {
  mock.state = null;
  mock.unlock.mockReset().mockResolvedValue(true);
  mock.save.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe('UnlockForm fingerprint', () => {
  it('asks for the fingerprint at once when one is kept for the key', async () => {
    mock.state = kept(['k1']);
    const unlocked = vi.fn();
    render(<UnlockForm keyId="k1" onUnlocked={unlocked} />);
    await waitFor(() => expect(mock.unlock).toHaveBeenCalledTimes(1));
    expect(mock.unlock.mock.calls[0][0]).toBe('k1');
    await waitFor(() => expect(unlocked).toHaveBeenCalled());
  });

  it('asks once the kept keys are known, and only once', async () => {
    mock.unlock.mockResolvedValue(false);
    render(<UnlockForm keyId="k1" />);
    expect(mock.unlock).not.toHaveBeenCalled();
    mock.state = kept(['k1']);
    act(() => mock.listeners.forEach((listener) => listener()));
    await waitFor(() => expect(mock.unlock).toHaveBeenCalledTimes(1));
    act(() => mock.listeners.forEach((listener) => listener()));
    expect(mock.unlock).toHaveBeenCalledTimes(1);
    // The password chosen instead: the button asks again.
    await waitFor(() => expect((screen.getByRole('button', { name: '用指纹解锁' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '用指纹解锁' }));
    await waitFor(() => expect(mock.unlock).toHaveBeenCalledTimes(2));
  });

  it('keeps an automatic prompt that failed quiet, but not a tapped one', async () => {
    mock.state = kept(['k1']);
    mock.unlock.mockRejectedValue(new Error('指纹验证未通过。'));
    render(<UnlockForm keyId="k1" />);
    await waitFor(() => expect(mock.unlock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: '用指纹解锁' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '用指纹解锁' }));
    expect((await screen.findByRole('alert')).textContent).toBe('指纹验证未通过。');
  });

  it('shows one prompt for several forms', async () => {
    mock.state = kept(['k1', 'k2']);
    let finish: (done: boolean) => void = () => {};
    mock.unlock.mockImplementation(() => new Promise<boolean>((resolve) => (finish = resolve)));
    render(
      <>
        <UnlockForm keyId="k1" />
        <UnlockForm keyId="k2" />
      </>,
    );
    await waitFor(() => expect(mock.unlock).toHaveBeenCalledTimes(1));
    await act(async () => finish(false));
    expect(mock.unlock).toHaveBeenCalledTimes(1);
  });

  it('offers to keep the key for the fingerprint without asking for it', async () => {
    mock.state = kept([]);
    render(<UnlockForm keyId="k1" />);
    expect(await screen.findByLabelText('以后在本机用指纹解锁')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '用指纹解锁' })).toBeNull();
    expect(mock.unlock).not.toHaveBeenCalled();
  });
});
