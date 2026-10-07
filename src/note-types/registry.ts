import {
  BookMarked,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  CircleAlert,
  CornerUpRight,
  File,
  FileText,
  Folder,
  Image,
  Link,
  ListTodo,
  MessagesSquare,
  NotebookPen,
  type LucideIcon,
} from 'lucide-react';
import { variantOf, type NodeKind, type NoteNode, type NoteVariant } from '../../shared/types';
import { PROJECT_LABELS, type ProjectCategory } from '../../shared/projects';

// What each kind of page is to the interface: its name and icon, whether it
// holds child notes, and how it is created. Behaviour specific to one kind
// (its panels, toolbar and 青藜) lives in that kind's module in this folder.
export interface NoteType {
  variant: NoteVariant;
  label: string;
  icon: LucideIcon;
  // Holds child notes and accepts them when dragged.
  container: boolean;
  // Offers "新建" under its heading; a book adds pages from its card, a page
  // gathers its notes itself, and a reference adds to its target instead.
  newChild: boolean;
  // Offered in the new-note dialog, in this order, stored as this kind.
  create?: { order: number; kind: NodeKind };
  // Can take an Emoji or picture icon (folders and what is built on them).
  customIcon: boolean;
}

const type = (
  variant: NoteVariant,
  label: string,
  icon: LucideIcon,
  options: Partial<Pick<NoteType, 'container' | 'newChild' | 'create' | 'customIcon'>> = {},
): NoteType => ({
  variant,
  label,
  icon,
  container: options.container ?? true,
  newChild: options.newChild ?? options.container ?? true,
  create: options.create,
  customIcon: options.customIcon ?? false,
});

export const NOTE_TYPES: Record<NoteVariant, NoteType> = {
  folder: type('folder', '文件夹', Folder, {
    create: { order: 1, kind: 'folder' },
    customIcon: true,
  }),
  book: type('book', '书籍', BookMarked, {
    newChild: false,
    create: { order: 2, kind: 'folder' },
    customIcon: true,
  }),
  project: type('project', '项目', BriefcaseBusiness, {
    create: { order: 3, kind: 'folder' },
    customIcon: true,
  }),
  // Entries are written from its calendar, one per day.
  journal: type('journal', '日记本', CalendarDays, {
    newChild: false,
    create: { order: 4, kind: 'folder' },
    customIcon: true,
  }),
  reference: type('reference', '文件／文件夹引用', CornerUpRight, {
    container: false,
    create: { order: 5, kind: 'folder' },
  }),
  markdown: type('markdown', 'Markdown 笔记', FileText, { create: { order: 6, kind: 'markdown' } }),
  text: type('text', '纯文本', File, { create: { order: 7, kind: 'text' } }),
  pdf: type('pdf', 'PDF', BookOpen, { create: { order: 8, kind: 'pdf' } }),
  image: type('image', '图片', Image, { create: { order: 9, kind: 'image' } }),
  link: type('link', '网页链接', Link, { create: { order: 10, kind: 'link' } }),
  paper: type('paper', 'arXiv 论文', BookOpen, { create: { order: 11, kind: 'link' } }),
  'book-page': type('book-page', '书页', FileText, { newChild: false }),
  discussion: type('discussion', '讨论', MessagesSquare, { newChild: false }),
};

// The kinds offered in the new-note dialog, in order.
export const CREATABLE_TYPES = Object.values(NOTE_TYPES)
  .filter((item) => item.create)
  .sort((a, b) => a.create!.order - b.create!.order);

export function noteType(node: Parameters<typeof variantOf>[0] & Partial<Pick<NoteNode, 'project_category'>>): NoteType {
  const variant = variantOf(node);
  const result = NOTE_TYPES[variant];
  return variant === 'markdown' && node.project_category ? { ...result, newChild: false } : result;
}

// Items in a project's todo, issue and note folders show as such.
export const PROJECT_ICONS: Record<ProjectCategory, LucideIcon> = {
  todo: ListTodo,
  issue: CircleAlert,
  note: NotebookPen,
};
type Labelled = Parameters<typeof variantOf>[0] & Pick<NoteNode, 'project_category'>;
export function typeLabel(node: Labelled): string {
  const variant = variantOf(node);
  if (node.project_category && variant === 'markdown') return PROJECT_LABELS[node.project_category];
  return NOTE_TYPES[variant].label;
}
