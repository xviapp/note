import { describe, expect, it } from 'vitest';
import { sanitizeSvg, SVG_LIMIT } from '../shared/svg';
import { diagramSvg, hostileSvg } from './fixtures/svg';

const clean = (value: string) => sanitizeSvg(new TextEncoder().encode(value));
describe('static SVG images', () => {
  it('preserves vector paths, text, styles, gradients, clipping and local glyph references', () => {
    const svg = clean(diagramSvg);
    for (const value of [
      'viewBox="0 0 320 180"',
      'width="320"',
      'height="180"',
      '<linearGradient',
      '<clipPath',
      'href="#point"',
      'fill:url(#blue)',
      'SVG vector chart',
    ])
      expect(svg).toContain(value);
    expect(svg).not.toContain('DOCTYPE');
    expect(clean(svg)).toBe(svg);
  });
  it('removes active content and external XML/CSS references while keeping the diagram', () => {
    const svg = clean(hostileSvg);
    for (const value of [
      'script',
      'foreignObject',
      'onload',
      'javascript:',
      'svg-tracker',
      '<animate',
      '@import',
      '--bad',
    ])
      expect(svg).not.toContain(value);
    expect(svg).toContain('fill:url(#blue)');
    expect(svg).toContain('opacity:.5');
    expect(svg).toContain('<circle');
  });
  it('rejects malformed XML, masquerading HTML, custom entities, excessive depth and oversized input', () => {
    for (const value of [
      '<svg><g></svg>',
      '<html><svg/></html>',
      '<svg xmlns="https://evil.test"/>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      '<!DOCTYPE svg [<!ENTITY x "bomb">]><svg>&x;</svg>',
      `<svg>${'<g>'.repeat(65)}${'</g>'.repeat(65)}</svg>`,
    ])
      expect(() => clean(value)).toThrow();
    expect(() => sanitizeSvg(new Uint8Array(SVG_LIMIT + 1))).toThrow('10 MiB');
  });
  it('preserves embedded raster images, XML text escaping and UTF-16 documents', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,YWJj"/><text>A &amp; B &lt; C</text></svg>`;
    expect(clean(svg)).toContain('data:image/png;base64,YWJj');
    expect(clean(svg)).toContain('A &amp; B &lt; C');
    const encoded = Uint8Array.from([
      255,
      254,
      ...Array.from(svg).flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]),
    ]);
    expect(sanitizeSvg(encoded)).toBe(clean(svg));
  });
});
