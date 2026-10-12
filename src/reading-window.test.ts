import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KEEP_AWAKE_IDLE_MS,
  setReadingWindowPreferences,
  setWindowStateForTest,
  useReadingWindow,
} from './reading-window';

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));

const apply = vi.fn(async (_state: { keepAwake: boolean; secure: boolean; volumeKeys: boolean }) => {});
const last = () => apply.mock.calls.at(-1)?.[0];
beforeEach(() => {
  vi.useFakeTimers();
  apply.mockClear();
  setWindowStateForTest(apply);
  setReadingWindowPreferences({ keepAwake: true, volumeKeys: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('keeps the screen on while the reader is active, then lets it sleep', () => {
  const view = renderHook(() => useReadingWindow(true, false, true));
  expect(last()).toEqual({ keepAwake: true, secure: false, volumeKeys: false });
  act(() => vi.advanceTimersByTime(KEEP_AWAKE_IDLE_MS));
  expect(last()).toEqual({ keepAwake: false, secure: false, volumeKeys: false });
  // A touch wakes it again, and leaving the note releases everything.
  act(() => {
    window.dispatchEvent(new Event('pointerdown'));
  });
  expect(last()?.keepAwake).toBe(true);
  view.unmount();
  expect(last()).toEqual({ keepAwake: false, secure: false, volumeKeys: false });
});

it('blocks screenshots of encrypted notes and pages with the volume keys only while reading', () => {
  setReadingWindowPreferences({ volumeKeys: true, keepAwake: false });
  const view = renderHook(({ editing }) => useReadingWindow(true, true, !editing), {
    initialProps: { editing: false },
  });
  expect(last()).toEqual({ keepAwake: false, secure: true, volumeKeys: true });
  const area = document.createElement('div');
  area.className = 'note-scroll';
  Object.defineProperty(area, 'clientHeight', { value: 600 });
  area.scrollBy = vi.fn();
  document.body.appendChild(area);
  window.dispatchEvent(new CustomEvent('note:volume-key', { detail: 1 }));
  expect(area.scrollBy).toHaveBeenCalledWith({ top: 552, behavior: 'smooth' });
  view.rerender({ editing: true });
  expect(last()).toEqual({ keepAwake: false, secure: true, volumeKeys: false });
});

it('does not repeat an unchanged state', () => {
  renderHook(() => useReadingWindow(true, false, true));
  const calls = apply.mock.calls.length;
  act(() => {
    window.dispatchEvent(new Event('keydown'));
    window.dispatchEvent(new Event('keydown'));
  });
  expect(apply.mock.calls.length).toBe(calls);
});
