import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyState, ProxySubscription } from './proxy';

const mock = vi.hoisted(() => ({
  platform: 'android',
  statusListener: null as null | ((state: ProxyState) => void),
  prepare: vi.fn(),
  retry: vi.fn(),
  getStatus: vi.fn(),
  saveSubscription: vi.fn(),
  updateSubscription: vi.fn(),
  selectNextNode: vi.fn(),
  enable: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => mock.platform },
  registerPlugin: () => ({
    prepare: mock.prepare,
    retry: mock.retry,
    setEnabled: mock.enable,
    getStatus: mock.getStatus,
    saveSubscription: mock.saveSubscription,
    updateSubscription: mock.updateSubscription,
    selectNextNode: mock.selectNextNode,
    addListener: async (event: string, listener: (state: ProxyState) => void) => {
      expect(event).toBe('status');
      mock.statusListener = listener;
      return { remove: async () => {} };
    },
  }),
}));
import { prepareProxy, proxyMessage, subscriptionError } from './proxy';
import { ProxySettings, ProxyStatus } from './components/ProxySettings';
import { AppHeader } from './components/Sidebar';
const emptySubscription: ProxySubscription = {
  updating: false,
  error: '',
  url: '',
  lastUpdated: 0,
  updateIntervalMinutes: 1440, testIntervalMinutes: 5, testing: false, lastTested: 0, testError: '',
  nodes: [],
};
const off: ProxyState = { enabled: false, phase: 'off', errorCode: '', retryAtMillis: 0, hasProfile: false, subscription: emptySubscription };
const failed: ProxyState = {
  ...off,
  enabled: true,
  phase: 'failed',
  errorCode: 'START_FAILED',
  hasProfile: true,
};
beforeEach(async () => {
  vi.clearAllMocks();
  mock.platform = 'android';
  mock.prepare.mockResolvedValue(off);
  mock.getStatus.mockResolvedValue(off);
  await prepareProxy();
});
afterEach(cleanup);
describe('embedded proxy feedback', () => {
  it('localizes runtime codes and epoch retry time', () => {
    expect(proxyMessage({ ...failed, errorCode: 'WEBVIEW_UNSUPPORTED' })).toContain('WebView');
    expect(proxyMessage({ ...failed, errorCode: 'NO_PROFILE' })).toContain('尚无可用节点');
    expect(proxyMessage({ ...failed, errorCode: 'RECONNECT_FAILED' })).toBe('代理连接失败，当前使用直连。');
    vi.spyOn(Date, 'now').mockReturnValue(100000);
    expect(proxyMessage({ ...failed, phase: 'reconnecting', retryAtMillis: 103000 })).toBe('代理连接异常，3 秒后重连。');
    vi.restoreAllMocks();
  });
  it.each(['INVALID_URL', 'NO_SUBSCRIPTION', 'DOWNLOAD_FAILED', 'UPDATE_FAILED', 'NO_NODES',
    'NO_USABLE_NODES', 'BUSY', 'STORAGE_FAILED', 'TIMEOUT', 'CANCELLED'])('localizes %s', (code) => {
    expect(subscriptionError(code)).not.toBe('订阅操作未完成，请检查地址和网络后重试。');
    expect(subscriptionError(code)).not.toContain(code);
  });
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(complete).toBe(false);
    done(off);
    await pending;
    expect(complete).toBe(true);
  });
  it('shows a quiet indicator after failure, with details only on click; recovery clears it', async () => {
    render(<ProxyStatus />);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => mock.statusListener!(failed));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('代理启动失败，当前使用直连。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '代理不可用，当前使用直连' }));
    expect(screen.getByText('代理启动失败，当前使用直连。')).toBeTruthy();
    mock.retry.mockResolvedValue({ ...failed, phase: 'running', errorCode: '' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重试启动' })));
    expect(screen.queryByRole('button', { name: '代理不可用，当前使用直连' })).toBeNull();
  });
  it('keeps enablement visible while using direct fallback', () => {
    act(() => mock.statusListener!(failed));
    render(<ProxySettings />);
    expect((screen.getByRole('switch', { name: '应用内代理' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('代理不可用，当前使用直连')).toBeTruthy();
  });
  it('does not expose native status in the web client', () => {
    mock.platform = 'web';
    act(() => mock.statusListener!(failed));
    render(<ProxyStatus />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('single subscription snapshot', () => {
  const populated: ProxyState = {
    ...off, hasProfile: true,
    subscription: {
      ...emptySubscription, url: 'https://example.test/sub',
      nodes: [
        { id: 'a', name: '节点甲', type: 'VLESS', delayMillis: 30, selected: true },
        { id: 'b', name: '节点乙', type: 'VLESS', delayMillis: 50, selected: false },
      ],
    },
  };

  it('adds a subscription in a dialog and closes it only after success', async () => {
    let finish!: (state: ProxyState) => void;
    mock.saveSubscription.mockImplementation(() => new Promise<ProxyState>((resolve) => { finish = resolve; }));
    render(<ProxySettings />);
    expect(screen.queryByLabelText('订阅地址')).toBeNull();
    expect((screen.getByRole('button', { name: '立即更新' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '添加订阅' }));
    expect(screen.getByRole('dialog', { name: '添加订阅' })).toBeTruthy();
    expect(screen.queryByLabelText('订阅名称')).toBeNull();
    expect(screen.queryByLabelText('间隔（分钟）')).toBeNull();
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: populated.subscription.url } });
    fireEvent.click(screen.getByRole('button', { name: '保存订阅' }));
    expect(mock.saveSubscription).toHaveBeenCalledWith({ url: populated.subscription.url, updateIntervalMinutes: 1440, testIntervalMinutes: 5 });
    expect((screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(populated));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '更换订阅' })).toBeTruthy();
    expect(screen.queryByText('节点甲')).toBeNull();
    expect(screen.queryByLabelText('订阅地址')).toBeNull();
  });

  it('saves configured intervals and restores them when reopening', async () => {
    const configured = { ...populated, subscription: { ...populated.subscription, updateIntervalMinutes: 60, testIntervalMinutes: 2 } };
    mock.saveSubscription.mockResolvedValue(configured);
    render(<ProxySettings />);
    fireEvent.click(screen.getByRole('button', { name: '添加订阅' }));
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: populated.subscription.url } });
    fireEvent.change(screen.getByLabelText('订阅更新间隔（分钟）'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('连通性测试间隔（分钟）'), { target: { value: '2' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存订阅' })));
    expect(mock.saveSubscription).toHaveBeenCalledWith({ url: populated.subscription.url, updateIntervalMinutes: 60, testIntervalMinutes: 2 });
    fireEvent.click(screen.getByRole('button', { name: '更换订阅' }));
    expect((screen.getByLabelText('订阅更新间隔（分钟）') as HTMLInputElement).value).toBe('60');
    expect((screen.getByLabelText('连通性测试间隔（分钟）') as HTMLInputElement).value).toBe('2');
  });

  it.each([['14', '5'], ['60', '0'], ['15.5', '5'], ['60', '1.5'], ['', '5']])('rejects invalid intervals %s / %s', async (update, test) => {
    render(<ProxySettings />);
    fireEvent.click(screen.getByRole('button', { name: '添加订阅' }));
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: populated.subscription.url } });
    fireEvent.change(screen.getByLabelText('订阅更新间隔（分钟）'), { target: { value: update } });
    fireEvent.change(screen.getByLabelText('连通性测试间隔（分钟）'), { target: { value: test } });
    await act(async () => fireEvent.submit(screen.getByLabelText('订阅地址').closest('form')!));
    expect(mock.saveSubscription).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('更新间隔至少为 15 分钟');
  });

  it('shows connectivity failures without refreshing the subscription', () => {
    act(() => mock.statusListener!({ ...populated, subscription: { ...populated.subscription, lastTested: 42, testError: 'CONNECTIVITY_FAILED' } }));
    render(<ProxySettings />);
    expect(screen.getByRole('status').textContent).toContain('连通性检测失败');
    expect(mock.updateSubscription).not.toHaveBeenCalled();
    expect(mock.selectNextNode).not.toHaveBeenCalled();
  });

  it('preserves an open draft across native updates and discards it on cancel', () => {
    act(() => mock.statusListener!(populated));
    render(<ProxySettings />);
    fireEvent.click(screen.getByRole('button', { name: '更换订阅' }));
    expect((screen.getByLabelText('订阅地址') as HTMLInputElement).value).toBe(populated.subscription.url);
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: 'https://draft.test/sub' } });
    act(() => mock.statusListener!({ ...populated, phase: 'running', enabled: true }));
    expect(screen.getByText('已开启')).toBeTruthy();
    expect((screen.getByLabelText('订阅地址') as HTMLInputElement).value).toBe('https://draft.test/sub');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mock.saveSubscription).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更换订阅' }));
    expect((screen.getByLabelText('订阅地址') as HTMLInputElement).value).toBe(populated.subscription.url);
  });

  it('toggles enablement and prevents changes during subscription updates', async () => {
    mock.enable.mockResolvedValue({ ...off, enabled: true, phase: 'running' });
    render(<ProxySettings />);
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '应用内代理' })));
    expect(mock.enable).toHaveBeenCalledWith({ enabled: true });
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
    act(() => mock.statusListener!({ ...populated, subscription: { ...populated.subscription, updating: true } }));
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '更换订阅' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '更新中…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides node information and shows refresh failures', async () => {
    act(() => mock.statusListener!(populated));
    render(<ProxySettings />);
    expect(screen.queryByText('当前节点')).toBeNull();
    expect(screen.queryByText('节点甲')).toBeNull();
    expect(screen.queryByRole('button', { name: '下一个节点' })).toBeNull();
    mock.updateSubscription.mockResolvedValue({
      ...populated, subscription: { ...populated.subscription, error: 'UPDATE_FAILED' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '立即更新' })));
    expect(mock.updateSubscription).toHaveBeenCalledWith();
    expect(screen.getByText('订阅更新失败，请检查地址和网络后重试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '更换订阅' })).toBeTruthy();
  });

  it.each(['transport', 'subscription'])('keeps the dialog and draft on %s failure', async (failure) => {
    if (failure === 'transport') mock.saveSubscription.mockRejectedValue(new Error('bridge unavailable'));
    else mock.saveSubscription.mockResolvedValue({ ...off, subscription: { ...emptySubscription, error: 'INVALID_URL' } });
    render(<ProxySettings />);
    fireEvent.click(screen.getByRole('button', { name: '添加订阅' }));
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: 'https://draft.test/sub' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存订阅' })));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(failure === 'transport' ? '操作未完成' : '订阅地址无效');
    expect((screen.getByLabelText('订阅地址') as HTMLInputElement).value).toBe('https://draft.test/sub');
    expect((screen.getByRole('button', { name: '保存订阅' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('never renders unknown native error text or subscription credentials', () => {
    act(() => mock.statusListener!({
      ...off, subscription: { ...emptySubscription, error: 'https://secret.test/token' },
    }));
    render(<ProxySettings />);
    expect(screen.getByText('订阅操作未完成，请检查地址和网络后重试。')).toBeTruthy();
    expect(screen.queryByText('https://secret.test/token')).toBeNull();
  });
});


it('hides quick clips only in the proxy settings header', () => {
  const props = {
    view: 'settings' as const, section: 'proxy' as const,
    showBack: true, showMenu: false, menuOpen: false,
    onBack: vi.fn(), onMenu: vi.fn(), onSearch: vi.fn(),
  };
  const { rerender } = render(<AppHeader {...props} />);
  expect(screen.queryByRole('button', { name: '随手记' })).toBeNull();
  rerender(<AppHeader {...props} section={null} />);
  expect(screen.getByRole('button', { name: '随手记' })).toBeTruthy();
});
