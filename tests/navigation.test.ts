import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, settingsTitles } from '../src/navigation';

describe('notebook routes', () => {
  it('preserves note and collection deep links', () => {
    for (const path of [
      '/',
      '/n/note_123-abc',
      '/favorites',
      '/recent',
      '/offline',
      '/trash',
      '/settings',
    ])
      expect(routePath(parseRoute(path))).toBe(path);
  });
  it('gives every settings section a distinct reloadable address', () => {
    for (const section of Object.keys(settingsTitles)) {
      const path = `/settings/${section}`;
      expect(routePath(parseRoute(path))).toBe(path);
      expect(parseRoute(path).view).toBe('settings');
    }
  });
  it('does not treat unknown routes or object properties as settings sections', () => {
    for (const path of ['/settings/unknown', '/settings/toString', '/n/', '/n/a/b', '/random'])
      expect(routePath(parseRoute(path))).toBe('/');
  });
});
