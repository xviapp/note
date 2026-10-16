import type { ReactNode } from 'react';
import type { NoteDetail, NoteNode } from '../../shared/types';
import type { ProjectContext } from '../../shared/projects';
import type { RecordStyle } from '../markdown-records';

// What the note page lends every type module.
export interface TypeContext {
  // Null until the note has loaded; a type's hook then returns no view.
  note: NoteDetail | null;
  editing: boolean;
  // Offline, or still showing this device's copy: no changes yet.
  offline: boolean;
  // Bumps when the tree or this note's own data should be read again.
  refreshKey: number;
  refresh: () => void;
  // A block was appended: reload and reveal the end of the body.
  onAppended: () => void;
  setAppending: (busy: boolean) => void;
  appending: boolean;
  assistantOpen: boolean;
  // Open 青藜 using the current window mode.
  openAssistant: () => void;
  onOpen: (node: NoteNode) => void;
  onNavigate: (id: string, project?: ProjectContext) => void;
  projectContext?: ProjectContext;
  // A note the type just created: opened for writing.
  onCreated: (node: NoteNode) => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onNotice?: (message: string) => void;
  confirm: (title: string, message: string, ok?: string, danger?: boolean) => Promise<boolean>;
}

// 青藜 for one type: the shared panel, given another conversation, title,
// context line or header actions.
export interface AssistantCustom {
  // Remounts the panel, e.g. when switching between a page's discussions.
  key?: string;
  node?: NoteDetail;
  title?: string;
  fileNode?: NoteDetail;
  context?: ReactNode;
  headerActions?: ReactNode;
  initialPrompt?: { content: string; quote?: string };
  initialQuote?: string;
  onDraftSend?: (content: string, quote: string) => void;
  onReplied?: () => void;
  showLauncher?: boolean;
  // No switch to the global conversation.
  noGlobal?: boolean;
}

// What a type adds to the note page. The page lays these out in fixed places;
// anything left out falls back to the generic behaviour.
export interface TypeView {
  // The page heading and kind, in place of the note's own.
  title?: string;
  kind?: { icon: ReactNode; label: string };
  headingActions?: ReactNode;
  // A leading heading in the body that repeats `title`, hidden when reading.
  hideHeading?: string;
  // How the body lays out records appended below it.
  records?: RecordStyle;
  // Among the note actions in the toolbar.
  toolbar?: ReactNode;
  // Extra items in the note's ⋯ menu.
  menu?: ReactNode;
  // Below the body, inside the article.
  below?: ReactNode;
  // Replaces a folder's list of child notes.
  children?: ReactNode;
  // Below the reading area (e.g. an ask bar).
  footer?: ReactNode;
  // Dialogs and full-screen views the type opens.
  dialogs?: ReactNode;
  hideAttachments?: boolean;
  assistant?: AssistantCustom;
  // "问青藜" on a selection; returns an error message to show, if any.
  addQuote?: (text: string) => string | undefined;
  // Whole-paper translation and side-by-side reading.
  compare?: { open: () => void; progress?: string };
  // A full-screen view is open; 青藜 floats instead of docking.
  fullscreen?: boolean;
}
