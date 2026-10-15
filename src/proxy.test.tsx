import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyState } from './proxy';

const mock = vi.hoisted(() => ({
  platform: 'android',
  statusListener: null as null | ((state: ProxyState) => void),
  prepare: vi.fn(),
  getStatus: vi.fn(),
  check: vi.fn(),
  enable: vi.fn(),
  setUrl: vi.fn(),
  bypass: vi.fn(),
  notice: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => mock.platform },
  registerPlugin: () => ({
    prepare: mock.prepare,
    getStatus: mock.getStatus,
    check: mock.check,
    setEnabled: mock.enable,
    setUrl: mock.setUrl,
    setBypassOnVpn: mock.bypass,
    addListener: async (event: string, listener: (state: ProxyState) => void) => {
      expect(event).toBe('status');
      mock.statusListener = listener;
      return { remove: async () => {} };
    },
  }),
}));
vi.mock('./mobile', () => ({ notice: mock.notice }));
import { addressError, prepareProxy, proxyLabel, proxyReady, reportNetworkFailure } from './proxy';
import { ProxySettings, ProxyStatus } from './components/ProxySettings';
import { AppHeader } from './components/Sidebar';

const off: ProxyState = { enabled: false, url: '', bypassOnVpn: false, route: 'off', checkedAt: 0, error: '' };
const url = 'socks5://127.0.0.1:7890';
const proxied: ProxyState = { ...off, enabled: true, url, route: 'proxy', checkedAt: Date.now() };
const direct: ProxyState = { ...proxied, route: 'direct', error: 'refused' };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  mock.platform = 'android';
  mock.prepare.mockResolvedValue(off);
  mock.getStatus.mockResolvedValue(off);
  await prepareProxy();
});
afterEach(cleanup);

describe('external proxy state', () => {
  it('labels every route', () => {
    expect(proxyLabel(off)).toBe('已关闭，使用直连');
    expect(proxyLabel({ ...off, enabled: true })).toContain('尚未填写代理地址');
    expect(proxyLabel({ ...proxied, route: 'vpn' })).toBe('已连接 VPN，代理已暂停');
    expect(proxyLabel({ ...proxied, route: 'checking' })).toBe('正在检测代理…');
    expect(proxyLabel(proxied)).toBe('已连接 127.0.0.1:7890');
    expect(proxyLabel(direct)).toBe('代理无法连接，当前使用直连');
  });

  it.each(['SCHEME', 'AUTH', 'PORT', 'INVALID', ''])('localizes address error %s', (code) => {
    expect(addressError(code)).not.toContain(code || 'undefined');
  });

  it('waits for native preparation before returning', async () => {
    let done!: (state: ProxyState) => void;
    mock.prepare.mockImplementation(() => new Promise<ProxyState>((resolve) => { done = resolve; }));
    let complete = false;
    const pending = prepareProxy().then(() => { complete = true; });
    await flush();
    expect(complete).toBe(false);
    done(off);
    await pending;
    expect(complete).toBe(true);
  });

  it('checks again only once the last answer is old', async () => {
    act(() => mock.statusListener!(proxied));
    await proxyReady();
    expect(mock.check).not.toHaveBeenCalled();
    mock.check.mockResolvedValue({ ...proxied, checkedAt: Date.now() });
    act(() => mock.statusListener!({ ...proxied, checkedAt: Date.now() - 61_000 }));
    await proxyReady();
    expect(mock.check).toHaveBeenCalledWith({ force: false });
    mock.check.mockClear();
    act(() => mock.statusListener!({ ...direct, checkedAt: Date.now() - 16_000 }));
    mock.check.mockResolvedValue(direct);
    await proxyReady();
    expect(mock.check).toHaveBeenCalledTimes(1);
  });

  it('does not check while off or bypassed by a VPN', async () => {
    act(() => mock.statusListener!({ ...proxied, route: 'vpn', checkedAt: 0 }));
    await proxyReady();
    act(() => mock.statusListener!(off));
    await proxyReady();
    expect(mock.check).not.toHaveBeenCalled();
  });

  it('reports a failed request so a dead proxy moves traffic to direct', async () => {
    act(() => mock.statusListener!(proxied));
    mock.check.mockResolvedValue(direct);
    await act(async () => expect(await reportNetworkFailure()).toBe(true));
    expect(mock.check).toHaveBeenCalledWith({ force: true });
    // Already direct: nothing more to do.
    expect(await reportNetworkFailure()).toBe(false);
  });

  it('prompts once when falling back to direct and once on recovery', async () => {
    act(() => mock.statusListener!(proxied));
    act(() => mock.statusListener!(direct));
    act(() => mock.statusListener!({ ...direct, checkedAt: Date.now() }));
    // Vitest can hand a second concurrent dynamic import the real module; let the first settle.
    await flush();
    act(() => mock.statusListener!(proxied));
    act(() => mock.statusListener!(proxied));
    await flush();
    expect(mock.notice.mock.calls).toEqual([
      ['代理 127.0.0.1:7890 无法连接，已改用直连', 'toast'],
      ['代理已恢复', 'toast'],
    ]);
  });
});

describe('proxy settings', () => {
  it('saves the address and shows it normalized', async () => {
    mock.setUrl.mockResolvedValue({ ...off, url });
    render(<ProxySettings />);
    expect((screen.getByRole('switch', { name: '使用代理' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('代理地址'), { target: { value: ' 127.0.0.1:7890 ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(mock.setUrl).toHaveBeenCalledWith({ url: '127.0.0.1:7890' });
    expect((screen.getByLabelText('代理地址') as HTMLInputElement).value).toBe(url);
    expect((screen.getByRole('switch', { name: '使用代理' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps the draft and explains a refused address', async () => {
    mock.setUrl.mockRejectedValue(Object.assign(new Error('AUTH'), { code: 'AUTH' }));
    render(<ProxySettings />);
    fireEvent.change(screen.getByLabelText('代理地址'), { target: { value: 'socks5://a:b@host:1' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(screen.getByRole('alert').textContent).toBe('不支持带用户名和密码的代理地址。');
    expect((screen.getByLabelText('代理地址') as HTMLInputElement).value).toBe('socks5://a:b@host:1');
  });

  it('switches on and checks on demand', async () => {
    act(() => mock.statusListener!({ ...off, url }));
    mock.enable.mockResolvedValue(proxied);
    render(<ProxySettings />);
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '使用代理' })));
    expect(mock.enable).toHaveBeenCalledWith({ enabled: true });
    expect(screen.getByText('已连接 127.0.0.1:7890')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    let answer!: (value: typeof proxied) => void;
    mock.check.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    act(() => fireEvent.click(screen.getByRole('button', { name: '检测' })));
    expect((screen.getByRole('button', { name: '检测中…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer(proxied));
    expect(screen.getByRole('status').textContent).toContain('代理连接正常。');
    mock.check.mockResolvedValue(direct);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '检测' })));
    expect(mock.check).toHaveBeenCalledWith({ force: true });
    expect(screen.getByRole('status').textContent).toContain('代理拒绝连接');
  });

  it('goes direct on VPN only while the proxy is enabled and reports the pause', async () => {
    render(<ProxySettings />);
    const vpn = () => screen.getByRole('switch', { name: '连接 VPN 时直连' }) as HTMLInputElement;
    expect(vpn().disabled).toBe(true);
    act(() => mock.statusListener!(proxied));
    expect(vpn().disabled).toBe(false);
    mock.bypass.mockResolvedValue({ ...proxied, bypassOnVpn: true, route: 'vpn' });
    await act(async () => fireEvent.click(vpn()));
    expect(mock.bypass).toHaveBeenCalledWith({ enabled: true });
    expect(vpn().checked).toBe(true);
    expect(screen.getAllByText('已连接 VPN，代理已暂停').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '检测' })).toBeNull();
  });

  it('keeps the VPN switch when the native call fails', async () => {
    act(() => mock.statusListener!(proxied));
    mock.bypass.mockRejectedValue(new Error('bridge'));
    render(<ProxySettings />);
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '连接 VPN 时直连' })));
    expect((screen.getByRole('switch', { name: '连接 VPN 时直连' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe('操作未完成，请重试。');
  });
});

describe('direct fallback indicator', () => {
  it('appears only while direct, with details on click; recovery clears it', async () => {
    render(<ProxyStatus />);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => mock.statusListener!(direct));
    expect(screen.queryByText('当前使用直连')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '代理无法连接，当前使用直连' }));
    expect(screen.getByText('当前使用直连')).toBeTruthy();
    mock.check.mockResolvedValue(proxied);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重新检测' })));
    expect(screen.queryByRole('button', { name: '代理无法连接，当前使用直连' })).toBeNull();
  });

  it('does not show in the web client', () => {
    mock.platform = 'web';
    act(() => mock.statusListener!(direct));
    render(<ProxyStatus />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

it('hides search and quick clips from the settings headers', () => {
  const props = {
    view: 'settings' as const, section: 'server' as const,
    showBack: true, showMenu: false, menuOpen: false,
    onBack: vi.fn(), onMenu: vi.fn(), onSearch: vi.fn(),
  };
  const { rerender } = render(<AppHeader {...props} />);
  expect(screen.queryByRole('button', { name: '搜索笔记' })).toBeNull();
  expect(screen.queryByRole('button', { name: '随手记' })).toBeNull();
  rerender(<AppHeader {...props} section={null} />);
  expect(screen.queryByRole('button', { name: '搜索笔记' })).toBeNull();
  expect(screen.queryByRole('button', { name: '随手记' })).toBeNull();
  rerender(<AppHeader {...props} view="tree" section={null} />);
  expect(screen.getByRole('button', { name: '搜索笔记' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '随手记' })).toBeTruthy();
});
