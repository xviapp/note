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

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AppLockSettings', () => {
  it('sets a PIN after it is typed twice', async () => {
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '设置 PIN' }));
    fill('PIN', '1234');
    fill('再次输入 PIN', '1243');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findByRole('alert')).textContent).toBe('两次输入的 PIN 不一致。');
    expect(mock.appLockSetPin).not.toHaveBeenCalled();

    fill('再次输入 PIN', '1234');
    mock.appLockSetPin.mockImplementation(async () => {
      mock.state = on;
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('button', { name: '修改 PIN' });
    expect(mock.appLockSetPin).toHaveBeenCalledWith({ pin: '1234' });
    expect(screen.getByText(/打开页间时输入 4 位 PIN/)).toBeTruthy();
  });

  it('keeps digits only and refuses a short PIN', async () => {
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '设置 PIN' }));
    fill('PIN', '12a');
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('12');
    fill('再次输入 PIN', '12');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findByRole('alert')).textContent).toBe('PIN 需为 4 到 6 位数字。');
  });

  it('shows why the current PIN was refused and stays open', async () => {
    mock.state = on;
    mock.appLockDisable.mockRejectedValue(new Error('当前 PIN 不正确。'));
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    fill('当前 PIN', '0000');
    fireEvent.click(screen.getByRole('button', { name: '关闭应用锁' }));
    expect((await screen.findByRole('alert')).textContent).toBe('当前 PIN 不正确。');
    expect(mock.appLockDisable).toHaveBeenCalledWith({ current: '0000' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('changes the PIN with the current one', async () => {
    mock.state = on;
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '修改 PIN' }));
    fill('当前 PIN', '1234');
    fill('新 PIN', '567890');
    fill('再次输入新 PIN', '567890');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
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
    expect(screen.getByText(/本机没有可用的指纹/)).toBeTruthy();
  });
});
