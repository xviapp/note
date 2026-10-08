import { expect, it } from 'vitest';
import { setInkMode, setTheme } from './theme';

it('keeps the chosen theme while ink is enabled and restores it afterwards', () => {
  setTheme('starry');
  setInkMode(true);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('note:theme')).toBe('starry');
  expect(localStorage.getItem('note:ink')).toBe('true');
  setTheme('dark');
  expect(document.documentElement.dataset.theme).toBe('light');
  setInkMode(false);
  expect(document.documentElement.dataset.theme).toBe('dark');
  setTheme('system');
});

it('responds to preference changes from another window', () => {
  setTheme('starry');
  window.dispatchEvent(new StorageEvent('storage', { key: 'note:ink', newValue: 'true' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  window.dispatchEvent(new StorageEvent('storage', { key: 'note:ink', newValue: 'false' }));
  expect(document.documentElement.dataset.theme).toBe('starry');
  setTheme('system');
});
