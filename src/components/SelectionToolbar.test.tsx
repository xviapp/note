import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionToolbar } from './SelectionToolbar';

const { native, platform, share } = vi.hoisted(() => ({ native: vi.fn(), platform: vi.fn(), share: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: platform } }));
vi.mock('../mobile', () => ({ device: { setSelectionToolbar: native, shareText: share } }));
vi.mock('../clips', () => ({ addClip: vi.fn() }));
vi.mock('../source-location', () => ({ captureSourceLocation: () => null }));

beforeEach(() => {
  vi.useFakeTimers();
  native.mockReset().mockResolvedValue(undefined);
  share.mockReset().mockResolvedValue(undefined);
  platform.mockReturnValue('android');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const props = { onSelection: vi.fn(), onQuote: () => undefined, onTranslate: vi.fn() };
function select(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  Object.defineProperty(range, 'getClientRects', {
    value: () => [new DOMRect(20, 200, 100, 20)],
  });
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => element.textContent,
  } as unknown as Selection);
  fireEvent(document, new Event('selectionchange'));
  act(() => vi.advanceTimersByTime(150));
}

it('hands only managed reading selections to Android and releases each owner on unmount', () => {
  const view = render(<>
    <div data-selection-owner="one"><p>第一篇正文</p><input aria-label="编辑" /></div>
    <div data-selection-owner="two"><p>第二篇正文</p></div>
    <SelectionToolbar owner="one" {...props} />
    <SelectionToolbar owner="two" {...props} />
  </>);
  select(screen.getByText('第一篇正文'));
  const firstOwner = native.mock.calls[0][0].owner;
  expect(native).toHaveBeenLastCalledWith({ owner: firstOwner, enabled: true });
  select(screen.getByText('第二篇正文'));
  const secondOwner = native.mock.lastCall![0].owner;
  expect(secondOwner).not.toBe(firstOwner);
  expect(native).toHaveBeenCalledWith({ owner: firstOwner, enabled: false });
  expect(native).toHaveBeenLastCalledWith({ owner: secondOwner, enabled: true });
  view.unmount();
  expect(native).toHaveBeenLastCalledWith({ owner: secondOwner, enabled: false });
});

it('leaves editor selections to Android and tolerates an unavailable native bridge', async () => {
  native.mockRejectedValue(new Error('old APK'));
  render(<>
    <div data-selection-owner="one"><p>正文</p><div contentEditable>可编辑文字</div></div>
    <SelectionToolbar owner="one" {...props} />
  </>);
  select(screen.getByText('正文'));
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: true });
  expect(screen.getByRole('toolbar', { name: '选中文字操作' })).toBeTruthy();
  select(screen.getByText('可编辑文字'));
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: false });
  expect(screen.queryByRole('toolbar')).toBeNull();
  await act(async () => {});
});

it('uses the web toolbar without calling the Android bridge', () => {
  platform.mockReturnValue('web');
  render(<>
    <div data-selection-owner="one"><p>网页正文</p></div>
    <SelectionToolbar owner="one" {...props} />
  </>);
  select(screen.getByText('网页正文'));
  expect(screen.getByRole('toolbar', { name: '选中文字操作' })).toBeTruthy();
  expect(native).not.toHaveBeenCalled();
});

it('gives a dismissed selection the system menu back until it changes', () => {
  render(<>
    <div data-selection-owner="one"><p>第一段</p><p>第二段</p></div>
    <SelectionToolbar owner="one" {...props} />
  </>);
  select(screen.getByText('第一段'));
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: true });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: false });
  // The same range reported again stays with the system menu.
  fireEvent(document, new Event('selectionchange'));
  act(() => vi.advanceTimersByTime(150));
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: false });
  expect(screen.queryByRole('toolbar')).toBeNull();
  select(screen.getByText('第二段'));
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: true });
  expect(screen.getByRole('toolbar', { name: '选中文字操作' })).toBeTruthy();
  fireEvent.scroll(document);
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(native).toHaveBeenLastCalledWith({ owner: expect.any(String), enabled: false });
});

it('keeps the system menu hidden while a tap may start a new selection', () => {
  render(<>
    <div data-selection-owner="one"><p>正文</p></div>
    <SelectionToolbar owner="one" {...props} />
  </>);
  select(screen.getByText('正文'));
  native.mockClear();
  fireEvent.pointerDown(screen.getByText('正文'));
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(native).not.toHaveBeenCalled();
});

it('copies instead of sharing on an APK without native share', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  share.mockRejectedValue(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
  render(<>
    <div data-selection-owner="one"><p>要分享的话</p></div>
    <SelectionToolbar owner="one" {...props} />
  </>);
  select(screen.getByText('要分享的话'));
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: '分享' })));
  expect(writeText).toHaveBeenCalledWith('要分享的话');
  expect(screen.getByRole('status').textContent).toBe('已复制。当前应用版本不支持分享，更新后可用。');
});
