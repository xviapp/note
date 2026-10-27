import { expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { renderMermaid } from './mermaid';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

it('serializes renders, recovers after errors, and isolates sanitized SVG with intrinsic dimensions', async () => {
  let fail!: (error: Error) => void;
  const draw = vi.mocked(mermaid.render);
  draw.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  draw.mockResolvedValueOnce({
    diagramType: 'gantt',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 960 200" onload="alert(1)"><script>alert(1)</script><style>text{fill:red}body{background:url(https://example.com/leak)}</style><text>任务</text><image href="https://example.com/leak"/></svg>',
  });
  const first = renderMermaid('invalid', false);
  const rejected = expect(first).rejects.toThrow('invalid');
  const second = renderMermaid('gantt', true);
  await vi.waitFor(() => expect(draw).toHaveBeenCalledTimes(1));
  expect(document.querySelector('[aria-hidden="true"]')).toBeTruthy();
  fail(new Error('invalid'));
  await rejected;
  const uri = await second;
  const svg = decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
  expect(svg).toContain('width="960"');
  expect(svg).toContain('height="200"');
  expect(svg).toContain('任务');
  expect(svg).not.toMatch(/script|onload|https:\/\/example.com/);
  expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
    securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true,
    themeVariables: expect.objectContaining({ darkMode: true }),
  }));
  expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
});
