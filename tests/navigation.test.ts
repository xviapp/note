import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, settingsTitles } from '../src/navigation';

describe('notebook routes', () => {
  it('keeps project category context through reloadable note links', () => {
    for (const category of ['todo', 'issue', 'note']) {
      const path = `/n/source?project=project_id&category=${category}`;
      expect(routePath(parseRoute(path))).toBe(path);
    }
    expect(routePath(parseRoute('/n/source?project=bad/id&category=todo'))).toBe('/n/source');
    expect(routePath(parseRoute('/n/source?project=id&category=unknown'))).toBe('/n/source');
    expect(parseRoute('/n/source').project).toBeUndefined();
  });
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
    for (const path of ['/settings/unknown', '/settings/proxy', '/settings/toString', '/n/', '/n/a/b', '/random'])
      expect(routePath(parseRoute(path))).toBe('/');
  });
});
