import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyState } from './proxy';

const mock = vi.hoisted(() => ({
  platform: 'android',
  listener: null as null | ((state: ProxyState) => void),
  prepare: vi.fn(),
  retry: vi.fn(),
  configure: vi.fn(),
  enable: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => mock.platform },
  registerPlugin: () => ({
    prepare: mock.prepare,
    retry: mock.retry,
    setEnabled: mock.enable,
    openConfiguration: mock.configure,
    addListener: async (_event: string, listener: (state: ProxyState) => void) => {
      mock.listener = listener;
      return { remove: async () => {} };
    },
  }),
}));
import { prepareProxy } from './proxy';
import { ProxySettings, ProxyStatus } from './components/ProxySettings';
const off: ProxyState = { enabled: false, phase: 'off', message: '', hasProfile: false };
const failed: ProxyState = {
  enabled: true,
  phase: 'failed',
  message: '代理启动失败，当前使用直连。',
  hasProfile: true,
};
beforeEach(async () => {
  vi.clearAllMocks();
  mock.platform = 'android';
  mock.prepare.mockResolvedValue(off);
  await prepareProxy();
});
afterEach(cleanup);
describe('embedded proxy feedback', () => {
  it('waits for native network preparation before returning', async () => {
    let done!: (state: ProxyState) => void;
    mock.prepare.mockImplementation(
      () =>
        new Promise<ProxyState>((resolve) => {
          done = resolve;
        }),
    );
    let complete = false;
    const pending = prepareProxy().then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    done(off);
    await pending;
    expect(complete).toBe(true);
  });
  it('shows a quiet indicator after failure, with details only on click; recovery clears it', async () => {
    render(<ProxyStatus />);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => mock.listener!(failed));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(failed.message)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '代理不可用，当前使用直连' }));
    expect(screen.getByText(failed.message)).toBeTruthy();
    mock.retry.mockResolvedValue({ ...failed, phase: 'running', message: '' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重试启动' })));
    expect(screen.queryByRole('button', { name: '代理不可用，当前使用直连' })).toBeNull();
  });
  it('keeps enablement visible while using direct fallback', () => {
    act(() => mock.listener!(failed));
    render(<ProxySettings />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('代理不可用，当前使用直连')).toBeTruthy();
  });
  it('does not expose native status in the web client', () => {
    mock.platform = 'web';
    act(() => mock.listener!(failed));
    render(<ProxyStatus />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
