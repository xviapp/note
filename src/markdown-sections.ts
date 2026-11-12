import type { Element, ElementContent, Root, RootContent } from 'hast';

export interface MarkdownSection {
  start: number;
  end: number;
  title: string;
  level: number;
  children: number;
}

const levelOf = (node: RootContent) =>
  node.type === 'element' && /^h[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
const textOf = (node: RootContent | ElementContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : '';

function taskCheckboxOf(li: Element): Element | null {
  for (const child of li.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'input' && child.properties.type === 'checkbox') return child;
    if (child.tagName === 'p') {
      const inner = child.children.find(
        (item): item is Element =>
          item.type === 'element' && item.tagName === 'input' && item.properties.type === 'checkbox',
      );
      if (inner) return inner;
    }
    break;
  }
  return null;
}

function markTasks(node: Root | Element) {
  if (node.type === 'element' && node.tagName === 'li' && node.position?.start.offset !== undefined) {
    const checkbox = taskCheckboxOf(node);
    if (checkbox) checkbox.properties.dataTaskOffset = node.position.start.offset;
  }
  for (const child of node.children) {
    if (child.type === 'element') markTasks(child);
  }
}

// Work from parsed headings: fenced code, lists, quotes and Setext headings
// follow the renderer's Markdown rules. Original source offsets stay intact.
export function rehypeSections(options: { enabled: boolean; length: number; bodyStart: number }) {
  return (tree: Root) => {
    if (!options.enabled) return;
    markTasks(tree);
    const headings = tree.children.filter((node) => levelOf(node) && node.position?.start.offset !== undefined);
    const sections = new Map<RootContent, MarkdownSection>();
    headings.forEach((node, index) => {
      const level = levelOf(node);
      let next = index + 1;
      while (next < headings.length && levelOf(headings[next]) > level) next++;
      sections.set(node, {
        start: node.position!.start.offset!,
        end: headings[next]?.position?.start.offset ?? options.length,
        title: textOf(node) || '未命名章节',
        level,
        children: next - index - 1,
      });
    });
    const wrap = (section: MarkdownSection): Element => ({
      type: 'element', tagName: 'section',
      properties: {
        dataSectionStart: section.start, dataSectionEnd: section.end,
        dataSectionTitle: section.title, dataSectionLevel: section.level,
        dataSectionChildren: section.children,
      },
      children: [],
    });
    const output: RootContent[] = [];
    const stack: { section: MarkdownSection; node: Element }[] = [];
    const first = headings[0]?.position?.start.offset ?? options.length;
    const intro = tree.children.filter((node) => (node.position?.start.offset ?? 0) < first && !levelOf(node));
    let preamble: Element | null = null;
    if (intro.some((node) => node.type !== 'text' || node.value.trim())) {
      preamble = wrap({ start: options.bodyStart, end: first, title: '前言', level: 0, children: 0 });
      output.push(preamble);
    }
    for (const node of tree.children) {
      const section = sections.get(node);
      if (section) {
        while (stack.length && stack.at(-1)!.section.level >= section.level) stack.pop();
        const wrapper = wrap(section);
        if (stack.length) stack.at(-1)!.node.children.push(wrapper);
        else output.push(wrapper);
        stack.push({ section, node: wrapper });
      }
      if (stack.length) stack.at(-1)!.node.children.push(node as ElementContent);
      else if (preamble) preamble.children.push(node as ElementContent);
      else output.push(node);
    }
    tree.children = output;
  };
}

export function replaceSection(content: string, section: MarkdownSection, replacement: string) {
  // A heading after the edited range must still start a new block. Preserve
  // every byte outside that range, including front matter and other sections.
  const text = replacement.trimEnd();
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return content.slice(0, section.start) + (text ? text + newline + newline : '') + content.slice(section.end);
}

// Toggles the GFM task marker (`[ ]` <-> `[x]`) on the list item starting at `offset`.
export function toggleTaskAt(content: string, offset: number, checked: boolean): string | null {
  if (offset < 0 || offset >= content.length) return null;
  const end = content.indexOf('\n', offset);
  const line = content.slice(offset, end < 0 ? content.length : end);
  const match = /^([ \t>]*?(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/.exec(line);
  if (!match) return null;
  const mark = checked ? 'x' : ' ';
  if (match[2].toLowerCase() === mark) return null;
  const pos = offset + match[1].length;
  return content.slice(0, pos) + mark + content.slice(pos + 1);
}
