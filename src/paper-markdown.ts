// The translated article as Markdown, for saving as a child note. Formulas
// become $TeX$ from their alttext, figures keep the paper's own image files
// (a note links at most 100), and tables point back to the original.
const FILE_LIMIT = 100;

export function paperMarkdown(root: Element): string {
  const blocks: string[] = [];
  const files = new Set<string>();
  const tex = (math: Element) =>
    math.getAttribute('alttext')?.trim() || math.textContent?.trim() || '';
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (!(node instanceof Element)) return '';
    if (node.matches('math')) return `$${tex(node)}$`;
    if (node.matches('img, button, .ltx_note_outer')) return '';
    if (node.matches('b, strong')) return `**${children(node).trim()}**`;
    if (node.matches('i, em')) return `*${children(node).trim()}*`;
    return children(node);
  };
  const children = (node: Node) => Array.from(node.childNodes, inline).join('');
  const image = (img: HTMLImageElement) => {
    const source = img.dataset.fileSource || img.getAttribute('src') || '';
    const id = source.match(/^\/api\/files\/([\w-]+)$/)?.[1];
    if (!id) return;
    if (!files.has(id) && files.size >= FILE_LIMIT) {
      blocks.push('*（图片较多，其余图片请在原论文中查看）*');
      return;
    }
    files.add(id);
    blocks.push(`![${(img.alt || '论文插图').replace(/[[\]\\]/g, '')}](/api/files/${id})`);
  };
  const walk = (element: Element) => {
    for (const child of element.children) {
      if (child.matches('h1, h2, h3, h4, h5, h6')) {
        const level = Math.min(6, Number(child.tagName[1]));
        blocks.push(`${'#'.repeat(level)} ${children(child).trim()}`);
      } else if (child.matches('p, figcaption')) {
        const text = children(child).trim();
        if (text) blocks.push(child.matches('figcaption') ? `*${text}*` : text);
        child.querySelectorAll('img').forEach((img) => image(img));
      } else if (child.matches('img')) image(child as HTMLImageElement);
      else if (child.matches('.ltx_equation, .ltx_equationgroup')) {
        const math = Array.from(child.querySelectorAll('math'), tex).filter(Boolean);
        if (math.length) blocks.push(`$$\n${math.join('\\\\\n')}\n$$`);
      } else if (child.matches('table.ltx_tabular, .ltx_tabular')) {
        blocks.push('*（表格请在原论文中查看）*');
      } else if (child.matches('ul, ol')) {
        const ordered = child.matches('ol');
        Array.from(child.children).forEach((item, index) => {
          const text = children(item).replace(/\s+/g, ' ').trim();
          if (text) blocks.push(`${ordered ? `${index + 1}.` : '-'} ${text}`);
        });
      } else if (child.matches('script, style, button')) continue;
      else walk(child);
    }
  };
  walk(root);
  return blocks.join('\n\n') + '\n';
}
