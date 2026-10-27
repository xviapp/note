import mermaid from 'mermaid';
import { sanitizeSvg } from '../shared/svg';

let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

export function renderMermaid(source: string, dark: boolean): Promise<string> {
  // Mermaid shares configuration and temporary DOM across renders. Keep each
  // initialization and render together, including after a previous failure.
  const result = queue.catch(() => {}).then(async () => {
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => style.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      gantt: { fontSize: 14, sectionFontSize: 14 },
      theme: 'base',
      fontFamily: style.getPropertyValue('--font-ui').trim(),
      themeVariables: {
        darkMode: dark,
        background: color('--surface'),
        primaryColor: color('--selected'),
        primaryTextColor: color('--ink'),
        primaryBorderColor: color('--line-strong'),
        secondaryColor: color('--surface-subtle'),
        secondaryTextColor: color('--ink'),
        tertiaryColor: color('--surface-raised'),
        tertiaryTextColor: color('--ink'),
        lineColor: color('--muted'),
        textColor: color('--ink'),
        taskBkgColor: color('--selected'),
        taskBorderColor: color('--line-strong'),
        taskTextColor: color('--ink'),
        taskTextOutsideColor: color('--ink'),
        taskTextDarkColor: color('--ink'),
        taskTextLightColor: color('--ink'),
        doneTaskBkgColor: color('--surface-subtle'),
        doneTaskBorderColor: color('--muted'),
        activeTaskBkgColor: color('--selected'),
        activeTaskBorderColor: color('--blue'),
        gridColor: color('--line'),
      },
    });
    // A fixed drawing surface keeps Gantt dates readable on phones. The
    // displayed image scrolls inside the note instead of widening the page.
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-10000px;top:0;width:960px;pointer-events:none';
    container.setAttribute('aria-hidden', 'true');
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(`note-mermaid-${++nextId}`, source, container);
      const clean = sanitizeSvg(new TextEncoder().encode(svg));
      const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
      const root = parsed.documentElement;
      root.setAttribute('color', color('--muted'));
      const box = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
      if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
        root.setAttribute('width', String(box[2]));
        root.setAttribute('height', String(box[3]));
      }
      // An image document also isolates diagram CSS from the app and disables
      // diagram scripts, links and external resources.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
    } finally {
      container.remove();
    }
  });
  queue = result;
  return result;
}
