import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLockState } from '../mobile';

const mock = vi.hoisted(() => ({
  state: null as unknown as AppLockState,
  appLockState: vi.fn(),
  appLockSetPin: vi.fn(),
  appLockDisable: vi.fn(),
  appLockSetBiometric: vi.fn(),
  appLockSetTimeout: vi.fn(),
}));
// Like a Capacitor plugin, the mock answers any property (`then` included)
// with a native call; this one never returns.
vi.mock('../mobile', () => {
  const methods: Record<string, unknown> = {
    appLockState: mock.appLockState,
    appLockSetPin: mock.appLockSetPin,
    appLockDisable: mock.appLockDisable,
    appLockSetBiometric: mock.appLockSetBiometric,
    appLockSetTimeout: mock.appLockSetTimeout,
  };
  return { device: new Proxy(methods, { get: (target, key) => target[String(key)] ?? (() => new Promise(() => {})) }) };
});
import { AppLockSettings } from './AppLockSettings';

const off: AppLockState = { enabled: false, pinLength: 0, biometric: false, biometricAvailable: true, timeout: 60_000 };
const on: AppLockState = { ...off, enabled: true, pinLength: 4 };

beforeEach(() => {
  mock.state = off;
  mock.appLockState.mockReset().mockImplementation(async () => mock.state);
  for (const fn of [mock.appLockSetPin, mock.appLockDisable, mock.appLockSetBiometric, mock.appLockSetTimeout])
    fn.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

const type = (digits: string) => {
  for (const digit of digits) fireEvent.click(screen.getByRole('button', { name: digit }));
};
const prompt = (text: string) => expect(screen.getByText(text)).toBeTruthy();

describe('AppLockSettings', () => {
  it('sets a PIN after it is typed twice on the pad', async () => {
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '设置 PIN' }));
    prompt('输入 PIN');
    type('1234');
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    prompt('再次输入 PIN');
    type('1243');
    expect((await screen.findByRole('alert')).textContent).toBe('两次输入的 PIN 不一致，请重新输入。');
    expect(mock.appLockSetPin).not.toHaveBeenCalled();
    prompt('输入 PIN');

    mock.appLockSetPin.mockImplementation(async () => {
      mock.state = on;
    });
    type('1234');
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    type('1234');
    await screen.findByRole('button', { name: '修改 PIN' });
    expect(mock.appLockSetPin).toHaveBeenCalledWith({ pin: '1234' });
    expect(screen.getByText('打开页间时输入 4 位 PIN')).toBeTruthy();
  });

  it('needs four digits before 下一步 and deletes the last one', async () => {
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '设置 PIN' }));
    const next = screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement;
    type('125');
    expect(next.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('已输入 2 位');
    type('34');
    expect(next.disabled).toBe(false);
  });

  it('takes a six-digit PIN without 下一步 and accepts the keyboard', async () => {
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '设置 PIN' }));
    for (const key of '123456') fireEvent.keyDown(window, { key });
    prompt('再次输入 PIN');
    for (const key of '123456') fireEvent.keyDown(window, { key });
    await waitFor(() => expect(mock.appLockSetPin).toHaveBeenCalledWith({ pin: '123456' }));
  });

  it('shows why the current PIN was refused and stays open', async () => {
    mock.state = on;
    mock.appLockDisable.mockRejectedValue(new Error('当前 PIN 不正确。'));
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    prompt('输入当前 PIN');
    type('0000');
    expect((await screen.findByRole('alert')).textContent).toBe('当前 PIN 不正确。');
    expect(mock.appLockDisable).toHaveBeenCalledWith({ current: '0000' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('已输入 0 位');
  });

  it('changes the PIN with the current one', async () => {
    mock.state = on;
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '修改 PIN' }));
    type('1234');
    prompt('输入新 PIN');
    type('567890');
    prompt('再次输入新 PIN');
    type('567890');
    await waitFor(() => expect(mock.appLockSetPin).toHaveBeenCalledWith({ pin: '567890', current: '1234' }));
  });

  it('turns on the fingerprint and sets when it locks again', async () => {
    mock.state = on;
    mock.appLockSetBiometric.mockImplementation(async () => {
      mock.state = { ...mock.state, biometric: true };
    });
    render(<AppLockSettings />);
    const fingerprint = (await screen.findByRole('switch', { name: '指纹解锁' })) as HTMLInputElement;
    fireEvent.click(fingerprint);
    await waitFor(() => expect(fingerprint.checked).toBe(true));
    expect(mock.appLockSetBiometric).toHaveBeenCalledWith({ enabled: true });
    fireEvent.change(screen.getByLabelText('重新上锁'), { target: { value: '0' } });
    await waitFor(() => expect(mock.appLockSetTimeout).toHaveBeenCalledWith({ timeout: 0 }));
  });

  it('reports a fingerprint that was not confirmed', async () => {
    mock.state = on;
    mock.appLockSetBiometric.mockRejectedValue(new Error('未启用指纹解锁。'));
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: '指纹解锁' }));
    expect((await screen.findByRole('alert')).textContent).toBe('未启用指纹解锁。');
    expect((screen.getByRole('switch', { name: '指纹解锁' }) as HTMLInputElement).checked).toBe(false);
  });

  it('cannot turn on a fingerprint the device does not have', async () => {
    mock.state = { ...on, biometricAvailable: false };
    render(<AppLockSettings />);
    expect(((await screen.findByRole('switch', { name: '指纹解锁' })) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/未录入指纹/)).toBeTruthy();
  });
});
