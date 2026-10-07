import type { Element, ElementContent, Root, RootContent } from 'hast';
import { CONCLUSION_LABELS, FINISHED_STATUSES, PROJECT_STATUSES } from '../shared/projects';
import { RECORD_SEPARATOR, type RecordKind } from '../shared/records';

// The kinds whose appended records are laid out specially (see shared/records.ts).
export type RecordStyle = Exclude<RecordKind, 'note'>;

const STAMPS: Record<RecordStyle, RegExp> = {
  journal: /^(\d{2}:\d{2})(?= · |$)/,
  issue: /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?= · |$)/,
  todo: /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?= · |$)/,
};
// Records written before kinds: "## 标题" (optional), then "> 2026-10-07 14:05:00 +08:00".
const LEGACY_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/;

const textOf = (node: RootContent | ElementContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : '';
const level = (node: RootContent) =>
  node.type === 'element' && /^h[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
const span = (name: string, children: ElementContent[]): Element => ({
  type: 'element',
  tagName: 'span',
  properties: { className: [name] },
  children,
});
const legacyTime = (node: RootContent | undefined) =>
  node?.type === 'element' && node.tagName === 'blockquote' && LEGACY_TIME.test(textOf(node).trim());

// Splits "2026-10-07 14:05 · 标题" into time and title without changing the
// heading's text, so annotations and reading positions keep their offsets.
function splitHeading(heading: Element, stamp: string) {
  const first = heading.children[0];
  if (first?.type !== 'text') return;
  const rest = first.value.slice(stamp.length);
  const separator = rest.startsWith(RECORD_SEPARATOR) ? RECORD_SEPARATOR : '';
  const title: ElementContent[] = [
    ...(rest.length > separator.length ? [{ type: 'text' as const, value: rest.slice(separator.length) }] : []),
    ...heading.children.slice(1),
  ];
  heading.children = [
    span('record-time', [{ type: 'text', value: stamp }]),
    ...(separator ? [span('record-separator', [{ type: 'text', value: separator }])] : []),
    ...(title.length ? [span('record-title', title)] : []),
  ];
  heading.properties.className = ['record-heading'];
  return title.map(textOf).join('');
}

// Groups each record heading with the content up to the next heading of level
// three or above into a <section class="record">. Anything else is left as is.
export function rehypeRecords(style?: RecordStyle) {
  return (tree: Root) => {
    if (!style) return;
    const states = style === 'journal' ? null : PROJECT_STATUSES[style];
    const records: { section: Element; header: number; status: boolean; finished: boolean; untitled: boolean }[] = [];
    const output: RootContent[] = [];
    let current: Element | null = null;
    const nodes = tree.children;
    const start = (children: ElementContent[], status = false, finished = false, legacy = false, untitled = false) => {
      current = {
        type: 'element',
        tagName: 'section',
        properties: { className: ['record', ...(legacy ? ['is-legacy'] : [])] },
        children,
      };
      records.push({ section: current, header: children.length, status, finished, untitled });
      output.push(current);
    };
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const depth = level(node);
      if (depth === 3 && node.type === 'element') {
        const first = node.children[0];
        const stamp = first?.type === 'text' ? first.value.match(STAMPS[style])?.[1] : undefined;
        if (stamp) {
          const title = splitHeading(node, stamp) ?? '';
          const change = states && title.match(/^(.+) → (.+)$/);
          const status = !!change && Object.values(states).includes(change[2]);
          start([node], status, status && change![2] === states![FINISHED_STATUSES[style as 'issue' | 'todo']!], false, !title);
          continue;
        }
      }
      if (style !== 'journal') {
        let next = index + 1;
        while (nodes[next]?.type === 'text' && !textOf(nodes[next]).trim()) next++;
        if (depth === 2 && node.type === 'element' && legacyTime(nodes[next])) {
          node.properties.className = ['record-heading'];
          const time = nodes[next] as Element;
          time.properties.className = ['record-legacy-time'];
          start([node, time], false, false, true);
          index = next;
          continue;
        }
        if (legacyTime(node)) {
          (node as Element).properties.className = ['record-legacy-time'];
          start([node as Element], false, false, true);
          continue;
        }
      }
      if (current && depth >= 1 && depth <= 3) current = null;
      if (current) (current as Element).children.push(node as ElementContent);
      else output.push(node);
    }
    for (const record of records) {
      const body = record.section.children.slice(record.header).some((node) => textOf(node).trim() || node.type === 'element');
      const classes = record.section.properties.className as string[];
      if (record.untitled) classes.push('is-untitled');
      if (record.status && !body) classes.push('is-status');
      if (record.finished && body) {
        classes.push('is-conclusion');
        // Shown by CSS, so the label never enters the text that annotations anchor to.
        (record.section.children[0] as Element).properties.dataLabel = CONCLUSION_LABELS[style as 'issue' | 'todo'];
      }
    }
    tree.children = output;
  };
}

// Marks a leading H1 that repeats the page heading (a journal day's date) so
// it is hidden while staying in the text that annotations anchor to.
export function rehypeRepeatedTitle(title?: string) {
  return (tree: Root) => {
    if (!title) return;
    const first = tree.children.find((node) => node.type !== 'text' || node.value.trim());
    if (first?.type === 'element' && first.tagName === 'h1' && textOf(first).trim() === title)
      first.properties.className = ['is-repeated-title'];
  };
}
