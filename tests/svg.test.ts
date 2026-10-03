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
      '<img',
      'onerror',
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
    // foreignObject keeps its (here empty) text container and nothing active.
    expect(svg).toContain('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"></div>');
  });
  it('keeps text boxes in foreignObject as formatted text, with math as TeX', () => {
    const svg = clean(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
<path d="M0 0H100V50H0Z" fill="none" stroke="black"/>
<foreignObject x="5" y="5" width="90" height="40"><span xmlns="http://www.w3.org/1999/xhtml" class="box" style="font-size:9pt;position:fixed;background:url(https://svg-tracker.invalid/x);width:80pt" onclick="alert(1)">Judge <b>both</b> answers<br/>then <a href="https://svg-tracker.invalid/link">decide</a>
<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="x^{2}"><msup><mi>x</mi><mn>2</mn></msup></math>
<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="A\\gg B"><semantics><mrow><mi>A</mi><mo>≫</mo><mi>B</mi></mrow><annotation encoding="application/x-tex">A\\gg B</annotation></semantics></math>
<script>alert(1)</script><style>span{color:red}</style><img src="https://svg-tracker.invalid/img"/><svg><circle r="9"/></svg></span></foreignObject></svg>`);
    expect(svg).toContain(
      '<foreignObject x="5" y="5" width="90" height="40"><span xmlns="http://www.w3.org/1999/xhtml" style="font-size:9pt;width:80pt">Judge <b>both</b> answers<br></br>then decide',
    );
    // Flat math reads as its symbols; structured math falls back to TeX.
    expect(svg).toContain('x^{2}');
    expect(svg).toContain('A≫B');
    expect(svg).not.toMatch(/svg-tracker|script|onclick|position|<a |<math|<msup|color:red|r="9"/);
    expect(clean(svg)).toBe(svg);
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
