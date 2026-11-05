// Loaded by the public blog only on posts with a Mermaid diagram, so other
// pages run no script at all.
import { renderMermaid } from '../mermaid';

// A theme is either fixed or, like the default, follows the system.
const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content ?? '';
const dark = scheme === 'dark' || (scheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches);
for (const block of document.querySelectorAll<HTMLPreElement>('pre.mermaid')) {
  try {
    const image = document.createElement('img');
    image.src = await renderMermaid(block.textContent ?? '', dark);
    image.alt = 'Mermaid 图表';
    image.className = 'mermaid-diagram';
    block.replaceWith(image);
  } catch {
    // The diagram's source stays on the page.
  }
}
