import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { FileText, X } from 'lucide-react';
import { api, ApiError, fileUrl, lockNote, unlockNote } from '../api';
import {
  TEXT_KINDS,
  type FileInfo,
  type NoteDetail,
  type NoteNode,
  type ReadingPosition,
} from '../../shared/types';
import { useReading } from '../useReading';
import { openLink } from '../open-link';
import { Empty, Modal, Spinner, useQuestion } from './Primitives';
import { Attachments } from './Attachments';
import type { EditorHandle } from './Editor';
import { useMarkdownReady } from './LazyMarkdown';
import { usePaperSession } from '../use-paper-session';
import { HistoryDialog } from './HistoryDialog';
import { EditToolbar, NoteHeading, NoteLocation, SaveErrorBar } from './NoteChrome';
import { NoteBody } from './NoteBody';
import { LinkDialog, markdownLink } from './LinkDialog';
import { useNoteEditor } from '../use-note-editor';
import { NoteActions } from './NoteActions';
import { useNoteToc } from '../use-note-toc';
import { NodeList } from './NodeList';
import { FastScroll } from './FastScroll';
import { type NodeAction } from './Tree';
import { AssistantPanel, type AssistantHandle } from './AssistantPanel';
import type { AssistantMode } from './AssistantWindow';
import { SelectionToolbar } from './SelectionToolbar';
import { TranslationPanel } from './TranslationPanel';
import type { TranslationLaunch } from '../translation';
import type { PdfSourceLocation, SourceLocation } from '../../shared/translation';
import { clearSourceHighlight, locateTextSource } from '../source-location';
import {
  annotationAt,
  clearAnnotationHighlights,
  exportAnnotations,
  paintAnnotations,
  sameText,
  useAnnotations,
} from '../annotations';
import { ANNOTATION_QUOTE_CHARS } from '../../shared/annotations';
import { AnnotationEditor, AnnotationList, type AnnotationDraft } from './AnnotationDialogs';
import { useReadingPreferences } from '../reading-preferences';
import { useOffline } from '../connectivity';

const Editor = lazy(() => import('./Editor'));
const CompareView = lazy(() => import('./CompareView'));
const SplitView = lazy(() => import('./SplitView'));
const PdfView = lazy(() => import('./PdfView'));
const ImageViewer = lazy(() => import('./ImageViewer'));

function restoreTextPosition(area: HTMLElement, position: ReadingPosition) {
  const anchors = Array.from(
    area.querySelectorAll<HTMLElement>(
      '.read-content [id^="heading-"], .read-content [data-paper-heading]',
    ),
  );
  const index = anchors.findIndex((element) => element.id === position.heading),
    anchor = anchors[index];
  if (anchor) {
    const nextTop =
      anchors[index + 1]?.getBoundingClientRect().top ??
      area.querySelector('.read-content')!.getBoundingClientRect().bottom;
    const sectionHeight = Math.max(1, nextTop - anchor.getBoundingClientRect().top);
    area.scrollTop +=
      anchor.getBoundingClientRect().top -
      area.getBoundingClientRect().top -
      24 +
      (position.headingRatio || 0) * sectionHeight;
  } else area.scrollTop = (area.scrollHeight - area.clientHeight) * (position.ratio || 0);
}

interface Props {
  id: string;
  refresh: number;
  treeRefresh: number;
  showSidebar: boolean;
  globalAssistantOpen: boolean;
  onGlobalAssistant: (selection: string) => void;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onBack: () => void;
  onNavigate: (id: string) => void;
  onOpen: (node: NoteNode) => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
  onChanged: () => void;
  onLoaded: (node: NoteDetail) => void;
  onFileNode: (file: FileInfo, parent: string) => void;
  setLeaveGuard: (guard: () => Promise<boolean>) => void;
  onError: (error: unknown) => void;
  onTrash: () => void;
  onSettings: () => void;
  // A short notice, e.g. a background translation that finished.
  onNotice?: (message: string) => void;
  // A note just created empty opens for writing without the confirmation.
  autoEdit?: boolean;
  onAutoEdit?: () => void;
}

export default function NotePane(props: Props) {
  const { id } = props;
  const offline = useOffline();
  const readingPreferences = useReadingPreferences();
  const [note, setNote] = useState<NoteDetail | null>(null),
    noteRef = useRef<NoteDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null),
    [retry, setRetry] = useState(0);
  const tocPosition = useRef<ReadingPosition | null>(null);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null),
    [pdf, setPdf] = useState<FileInfo | null>(null);
  const [childrenOpen, setChildrenOpen] = useState(false),
    [attachmentsOpen, setAttachmentsOpen] = useState(false),
    [compareOpen, setCompareOpen] = useState(false),
    [splitOpen, setSplitOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [linkOpen, setLinkOpen] = useState(false);
  const question = useQuestion(),
    scroll = useRef<HTMLDivElement>(null);
  const toc = useNoteToc({
    scroll,
    beforeSideToggle: () => {
      touched.current = restored.current = true;
      tocPosition.current = recordScroll() ?? null;
    },
    onJump: () => {
      touched.current = restored.current = true;
    },
  });
  const reading = useReading(id),
    restored = useRef(false),
    touched = useRef(false);
  const readingRoot = useRef<HTMLDivElement>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('floating');
  const [selection, setSelection] = useState('');
  const assistantActions = useRef<AssistantHandle>(null);
  const [translation, setTranslation] = useState<TranslationLaunch | null>(null);
  const [pdfLocation, setPdfLocation] = useState<PdfSourceLocation | null>(null);
  const editorHandle = useRef<EditorHandle | null>(null);
  const {
    editing,
    content,
    setContent,
    assets,
    busy,
    uploading,
    saveError,
    tab: editTab,
    setTab: setEditTab,
    dirty,
    reset,
    save,
    leave,
    start: startEdit,
    offerDraft,
    reconfirm,
    addFiles,
    insert,
    removeAsset,
  } = useNoteEditor({
    id,
    note,
    noteRef,
    setNote,
    question,
    setLeaveGuard: props.setLeaveGuard,
    onStart: () => setTranslation(null),
    onChanged: props.onChanged,
    onError: props.onError,
    editorRef: editorHandle,
  });
  // Once per opened note, offer a draft that was never saved.
  const draftChecked = useRef(false);
  const loadedId = note?.id;
  useEffect(() => {
    if (!loadedId || draftChecked.current || !TEXT_KINDS.includes(noteRef.current!.kind)) return;
    draftChecked.current = true;
    void offerDraft();
    // offerDraft reads the latest note through noteRef; run once it has loaded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);
  // The E shortcut, sent by the notebook when no field has focus.
  const editShortcut = useRef(() => {});
  editShortcut.current = () => {
    if (note && TEXT_KINDS.includes(note.kind) && !editing && !offline) void startEdit();
  };
  useEffect(() => {
    const edit = () => editShortcut.current();
    window.addEventListener('note:edit-shortcut', edit);
    return () => window.removeEventListener('note:edit-shortcut', edit);
  }, []);
  const { autoEdit, onAutoEdit } = props;
  useEffect(() => {
    if (!autoEdit || !note || editing || !TEXT_KINDS.includes(note.kind) || note.content) return;
    onAutoEdit?.();
    void startEdit(false);
    // startEdit is recreated each render; this runs once the new note has loaded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit, note, editing, onAutoEdit]);
  useEffect(() => {
    clearSourceHighlight();
    return clearSourceHighlight;
  }, [id, note?.content, editing]);
  const addQuote = (text: string) => {
    if (!assistantActions.current) return '青藜尚未就绪，请稍后重试。';
    const error = assistantActions.current.addQuote(text);
    if (error) return error;
    setTranslation(null);
    setPdf(null);
    setAssistantOpen(true);
  };
  const locateSource = (location: SourceLocation): string | undefined => {
    if (location.kind === 'text') {
      const root = readingRoot.current?.querySelector<HTMLElement>('.read-content');
      if (!root) return '原文暂时无法打开，请稍后重试。';
      touched.current = restored.current = true;
      return locateTextSource(root, location);
    }
    const file =
      note?.file?.id === location.fileId
        ? note.file
        : note?.attachments.find((file) => file.id === location.fileId);
    if (!file) return '原 PDF 已删除或从附件移除，无法定位。保存的原文与译文仍可查看。';
    setPdfLocation({ ...location });
    if (note?.file?.id !== file.id) setPdf(file);
  };
  const applyDetail = (detail: NoteDetail) => {
    noteRef.current = detail;
    setNote(detail);
    reset(detail);
    props.onLoaded(detail);
  };
  useEffect(() => {
    if (editing) return;
    let live = true;
    setLoadError(null);
    api<NoteDetail>(`/api/nodes/${id}`)
      .then((detail) => {
        if (live) applyDetail(detail);
      })
      .catch((e) => {
        if (live) setLoadError(e);
      });
    return () => {
      live = false;
    };
    // Reload only for a new note or refresh; applyDetail is recreated each render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [id, props.refresh, editing, retry]);
  const showImage = useCallback((src: string, alt: string) => setImage({ src, alt }), []);
  const noteId = note?.id;
  const restorePosition = useCallback(() => {
    if (!noteId || !reading.initial || editing || touched.current || !scroll.current) return;
    restoreTextPosition(scroll.current, reading.initial);
    restored.current = true;
  }, [noteId, reading.initial, editing]);
  useEffect(() => {
    const timer = window.setTimeout(restorePosition, 120);
    return () => clearTimeout(timer);
  }, [restorePosition, toc.headings]);
  useEffect(() => {
    const article = scroll.current?.querySelector('article');
    if (!article) return;
    const observer = new ResizeObserver(() => restorePosition());
    observer.observe(article);
    return () => observer.disconnect();
  }, [note?.id, restorePosition]);
  useLayoutEffect(() => {
    // Toggling the sidebar reflows the article; keep the same point in the chapter.
    const position = tocPosition.current;
    tocPosition.current = null;
    if (!position || !scroll.current) return;
    const area = scroll.current;
    restoreTextPosition(area, position);
    const top = area.scrollTop;
    let active = true;
    // A newly selected font may finish loading after the initial reflow.
    void document.fonts.ready.then(() => {
      if (active && Math.abs(area.scrollTop - top) < 2) restoreTextPosition(area, position);
    });
    return () => {
      active = false;
    };
  }, [toc.sideOpen, readingPreferences]);
  const recordScroll = () => {
    const area = scroll.current;
    if (!note || !area || editing || (!restored.current && !touched.current)) return;
    let heading = '',
      headingRatio = 0;
    const top = area.getBoundingClientRect().top;
    const anchors = Array.from(
      area.querySelectorAll<HTMLElement>(
        '.read-content [id^="heading-"], .read-content [data-paper-heading]',
      ),
    );
    for (const [index, element] of anchors.entries()) {
      const anchorTop = element.getBoundingClientRect().top;
      if (anchorTop > top + 25) break;
      heading = element.id;
      const nextTop =
        anchors[index + 1]?.getBoundingClientRect().top ??
        area.querySelector('.read-content')!.getBoundingClientRect().bottom;
      headingRatio = Math.max(
        0,
        Math.min(1, (top + 24 - anchorTop) / Math.max(1, nextTop - anchorTop)),
      );
    }
    toc.setActive(heading);
    if (!touched.current || (!TEXT_KINDS.includes(note.kind) && !note.arxiv_id)) return;
    const ratio = Math.max(
      0,
      Math.min(1, area.scrollTop / Math.max(1, area.scrollHeight - area.clientHeight)),
    );
    const position = { ratio, ...(heading ? { heading, headingRatio } : {}) };
    reading.update(position);
    return position;
  };
  useEffect(() => {
    const remember = () => {
      if (editing || !scroll.current) return;
      touched.current = restored.current = true;
      tocPosition.current = recordScroll() ?? reading.initial;
    };
    window.addEventListener('note:before-reading-change', remember);
    return () => window.removeEventListener('note:before-reading-change', remember);
  });
  const previewFile = (file: FileInfo) => {
    if (file.mime.startsWith('image/')) showImage(fileUrl(file.id), file.name);
    else if (file.mime === 'application/pdf') setPdf(file);
    else openLink(fileUrl(file.id, true));
  };
  const toggleFavorite = async () => {
    if (!note) return;
    try {
      await api(`/api/nodes/${id}/favorite`, 'PUT', { enabled: !note.favorite });
      const next = { ...note, favorite: note.favorite ? 0 : 1 };
      noteRef.current = next;
      setNote(next);
      props.onChanged();
    } catch (e) {
      props.onError(e);
    }
  };
  const navigation = (
    <NoteLocation
      note={note}
      showSidebar={props.showSidebar}
      sidebarOpen={props.sidebarOpen}
      onBack={props.onBack}
      onOpenSidebar={props.onOpenSidebar}
      onNavigate={props.onNavigate}
    />
  );
  const paperSession = usePaperSession(note, {
    onFinished: (message) => props.onNotice?.(message),
    onExported: () => {
      props.onChanged();
      setRetry((count) => count + 1);
    },
  });
  const markdownReady = useMarkdownReady(note?.kind === 'markdown');

  // Highlights and notes on the rendered text (Markdown, plain text, papers).
  const annotatable = !!note && (TEXT_KINDS.includes(note.kind) || !!note.arxiv_id);
  const annotations = useAnnotations(id, annotatable);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null),
    [annotationsOpen, setAnnotationsOpen] = useState(false);
  const annotationRanges = useRef(new Map<string, Range>());
  const [missingKey, setMissingKey] = useState('');
  const missingAnnotations = useMemo(
    () => new Set(missingKey.split(',').filter(Boolean)),
    [missingKey],
  );
  const annotationList = annotations.list;
  useEffect(() => {
    const root = readingRoot.current?.querySelector<HTMLElement>('.read-content');
    annotationRanges.current = new Map();
    if (!root || editing || !annotationList.length) {
      clearAnnotationHighlights();
      setMissingKey('');
      return;
    }
    let timer = 0;
    const paint = () => {
      const ranges = paintAnnotations(root, annotationList);
      annotationRanges.current = ranges;
      setMissingKey(
        annotationList
          .filter((item) => item.location.kind === 'text' && !ranges.has(item.id))
          .map((item) => item.id)
          .join(','),
      );
    };
    paint();
    // Formulas, paper figures and lazy Markdown render after the first paint.
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, 150);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      clearAnnotationHighlights();
    };
  }, [annotationList, editing, note?.id, note?.content, markdownReady]);
  const annotate = async (
    { quote, location }: { quote: string; location: SourceLocation | null },
    withNote: boolean,
  ) => {
    if (offline) return '离线时不能添加批注。';
    if (location?.kind === 'pdf') return 'PDF 暂不支持批注，后续版本加入。';
    if (!location) return '这里的文字不能批注，请选择正文内容。';
    if (quote.length > ANNOTATION_QUOTE_CHARS)
      return `每条批注最多选择 ${ANNOTATION_QUOTE_CHARS.toLocaleString()} 个字符，请缩小范围。`;
    const existing = annotationList.find(
      (item) => item.location.kind === 'text' && sameText(item.location, location),
    );
    if (existing) {
      setAnnotationDraft({ ...existing, saved: true });
      return;
    }
    const draft = { id: crypto.randomUUID(), quote, note: '', location, saved: false };
    if (withNote) {
      setAnnotationDraft(draft);
      return;
    }
    try {
      await annotations.save(draft);
    } catch (e) {
      return `未能高亮：${(e as Error).message}`;
    }
  };
  const openAnnotationAt = (event: ReactMouseEvent) => {
    if (editing || !annotationRanges.current.size || !window.getSelection()?.isCollapsed) return;
    if ((event.target as Element).closest('a, button, input, textarea, img, summary')) return;
    const hit = annotationAt(annotationRanges.current, event.clientX, event.clientY);
    const item = hit && annotationList.find((annotation) => annotation.id === hit);
    if (item) setAnnotationDraft({ ...item, saved: true });
  };
  if (loadError || !note || !markdownReady)
    return (
      <div className="note-pane">
        <div className="note-toolbar">{navigation}</div>
        {loadError ? (
          <Empty
            icon={<FileText />}
            title={
              loadError instanceof ApiError && loadError.code === 'NODE_TRASHED'
                ? '这篇笔记在回收站中'
                : '暂时无法打开笔记'
            }
            action={
              loadError instanceof ApiError && loadError.code === 'NODE_TRASHED' ? (
                <button className="button" onClick={props.onTrash}>
                  前往回收站
                </button>
              ) : (
                // Fetch just this note again; the tree and loaded lists stay as they are.
                <button className="button" onClick={() => setRetry((count) => count + 1)}>
                  重新加载
                </button>
              )
            }
          >
            {loadError.message}
          </Empty>
        ) : (
          <Spinner />
        )}
      </div>
    );
  return (
    <div className={`note-pane ${editing ? 'is-editing' : ''}`}>
      <div className="note-toolbar">
        {navigation}
        <NoteActions
          note={note}
          editing={editing}
          offline={offline}
          translating={!!translation}
          toc={{
            available: toc.headings.length > 0,
            expanded: toc.expanded,
            dialog: toc.compact,
            id: toc.id,
            toggleRef: toc.toggleRef,
            onToggle: toc.toggle,
          }}
          onReadingChange={() => {
            touched.current = restored.current = true;
            tocPosition.current = recordScroll() ?? reading.initial;
          }}
          onTranslate={() => setTranslation({})}
          onFavorite={() => void toggleFavorite()}
          onHistory={() => setHistoryOpen(true)}
          onChildren={() => setChildrenOpen(true)}
          onAttachments={() => setAttachmentsOpen(true)}
          onCompare={() => setCompareOpen(true)}
          compareProgress={
            paperSession.running && paperSession.total
              ? `${Math.floor((paperSession.done / paperSession.total) * 100)}%`
              : undefined
          }
          onSplit={() => setSplitOpen(true)}
          annotationCount={annotatable ? annotationList.length : 0}
          onAnnotations={() => setAnnotationsOpen(true)}
          onEdit={() => void startEdit()}
          onAction={props.onAction}
        />
      </div>
      {editing && (
        <EditToolbar
          kind={note.kind}
          dirty={dirty}
          tab={editTab}
          busy={busy}
          uploading={uploading}
          onTab={setEditTab}
          onFiles={(files) => void addFiles(files)}
          onInsertLink={() => setLinkOpen(true)}
          onCancel={() => void leave()}
          onSave={() => void save()}
        />
      )}
      {saveError && (
        <SaveErrorBar
          message={saveError}
          note={note}
          content={content}
          onReconfirm={() => void reconfirm()}
        />
      )}
      <div
        className={`reading-with-assistant${assistantOpen && !editing && !props.globalAssistantOpen && assistantMode === 'docked' ? ' assistant-docked' : ''}`}
      >
        <div
          ref={readingRoot}
          data-selection-owner={id}
          className={`note-workspace ${editing ? `edit-tab-${editTab}` : ''}`}
        >
          {editing && (
            <div className="source-pane">
              <Suspense fallback={<Spinner label="正在打开编辑器…" />}>
                <Editor
                  value={content}
                  onChange={setContent}
                  onSave={() => {
                    void save(false);
                  }}
                  onFiles={(files) => void addFiles(files)}
                  handleRef={editorHandle}
                  kind={note.kind as 'markdown' | 'text'}
                />
              </Suspense>
            </div>
          )}
          {note.kind === 'pdf' && note.file ? (
            reading.initial ? (
              <Suspense fallback={<Spinner label="正在打开 PDF…" />}>
                <PdfView
                  key={note.file.id}
                  fileId={note.file.id}
                  cacheNote={note}
                  initialPosition={reading.initial}
                  onPosition={reading.update}
                  sourceLocation={pdfLocation}
                />
              </Suspense>
            ) : (
              <Spinner />
            )
          ) : (
            <>
              <FastScroll
                target={scroll}
                onInteract={() => {
                  touched.current = true;
                }}
              />
              <div
                ref={scroll}
                className="note-scroll"
                tabIndex={0}
                aria-label="笔记阅读区"
                onScroll={recordScroll}
                onWheel={() => {
                  touched.current = true;
                }}
                onTouchStart={() => {
                  touched.current = true;
                }}
                onPointerDown={() => {
                  touched.current = true;
                }}
                onKeyDown={(e) => {
                  if (
                    ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(
                      e.key,
                    )
                  )
                    touched.current = true;
                }}
                onLoadCapture={() => {
                  if (!touched.current) restorePosition();
                }}
                onClick={openAnnotationAt}
              >
                <article className="note-article">
                  <NoteHeading
                    note={note}
                    editing={editing}
                    onNew={() => props.onAction('new', note)}
                  />
                  <NoteBody
                    note={note}
                    editing={editing}
                    content={content}
                    onNavigate={props.onNavigate}
                    onImage={showImage}
                    onHeadings={toc.onHeadings}
                  />
                  {TEXT_KINDS.includes(note.kind) && (
                    <Attachments
                      files={editing ? assets : note.attachments}
                      editing={editing}
                      onRemove={removeAsset}
                      onPreview={previewFile}
                      onCreate={!editing ? (file) => props.onFileNode(file, id) : undefined}
                    />
                  )}
                  {/* A folder is its list; other notes open their children from the toolbar. */}
                  {note.kind === 'folder' && !editing && (
                    <section
                      className={`children-section${note.kind === 'folder' ? ' is-folder' : ''}`}
                      aria-label="下级笔记"
                    >
                      <NodeList
                        parent={id}
                        refresh={props.treeRefresh}
                        onOpen={props.onOpen}
                        onAction={props.onAction}
                      />
                    </section>
                  )}
                </article>
              </div>
            </>
          )}
          {!editing &&
            (note.kind === 'markdown' || note.arxiv_id) &&
            toc.headings.length > 0 &&
            !toc.compact &&
            toc.sideOpen && (
              <aside
                className="desktop-toc"
                aria-label="标题目录面板"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    toc.toggle();
                  }
                }}
              >
                <div className="toc-heading">
                  <span>本篇目录</span>
                  <button className="icon-button" aria-label="隐藏标题目录" onClick={toc.toggle}>
                    <X size={16} />
                  </button>
                </div>
                {toc.nav}
              </aside>
            )}
        </div>
        {note.kind !== 'folder' && (
          <AssistantPanel
            actionsRef={assistantActions}
            node={note}
            visible={assistantOpen && !editing}
            enabled={!editing && !props.globalAssistantOpen}
            onGlobal={() => props.onGlobalAssistant(selection)}
            // Docked beside the article has no place in a full-screen view.
            mode={
              (compareOpen || splitOpen) && assistantMode === 'docked' ? 'floating' : assistantMode
            }
            onModeChange={setAssistantMode}
            selection={selection}
            readingRoot={readingRoot}
            onClose={() => setAssistantOpen(false)}
            onOpen={() => setAssistantOpen(true)}
            onChanged={props.onChanged}
            onSettings={props.onSettings}
            onNavigate={props.onNavigate}
            onImage={showImage}
          />
        )}
      </div>
      {!editing && note.kind !== 'folder' && (
        <SelectionToolbar
          owner={id}
          onSelection={setSelection}
          onQuote={addQuote}
          onTranslate={setTranslation}
          onAnnotate={annotatable ? annotate : undefined}
        />
      )}
      {annotationDraft && !editing && (
        <AnnotationEditor
          key={annotationDraft.id}
          draft={annotationDraft}
          offline={offline}
          onSave={(text) => annotations.save({ ...annotationDraft, note: text })}
          onDelete={() => annotations.remove(annotationDraft.id)}
          onAsk={(text) =>
            addQuote(
              text.trim()
                ? `${annotationDraft.quote}\n\n（我的批注：${text.trim()}）`
                : annotationDraft.quote,
            )
          }
          onClose={() => setAnnotationDraft(null)}
        />
      )}
      {annotationsOpen && !editing && (
        <AnnotationList
          list={annotationList}
          missing={missingAnnotations}
          offline={offline}
          onLocate={(item) => {
            setAnnotationsOpen(false);
            if (item.location.kind !== 'text') return;
            const root = readingRoot.current?.querySelector<HTMLElement>('.read-content');
            if (!root) return;
            touched.current = restored.current = true;
            // Wait for the dialog to close so focus and scrolling land in the text.
            requestAnimationFrame(() => {
              const location = item.location;
              if (location.kind === 'text') locateTextSource(root, location);
            });
          }}
          onEdit={(item) => {
            setAnnotationsOpen(false);
            setAnnotationDraft({ ...item, saved: true });
          }}
          onExport={async () => {
            const result = await exportAnnotations(id, note.title, annotationList);
            props.onChanged();
            setRetry((count) => count + 1);
            return `${result.updated ? '已更新' : '已保存为'}子笔记「${result.title}」（${result.count} 条）`;
          }}
          onClose={() => setAnnotationsOpen(false)}
        />
      )}
      {!editing && translation && (
        <TranslationPanel
          nodeId={id}
          launch={translation}
          onClose={() => setTranslation(null)}
          onChanged={props.onChanged}
          onQuote={addQuote}
          onLocate={locateSource}
          onNavigate={props.onNavigate}
          onImage={showImage}
        />
      )}
      {splitOpen && !editing && (
        <Suspense fallback={null}>
          <SplitView
            first={note}
            onClose={() => setSplitOpen(false)}
            onQuote={addQuote}
            onChanged={props.onChanged}
          />
        </Suspense>
      )}
      {compareOpen && note.arxiv_id && (
        <Suspense fallback={null}>
          <CompareView
            note={note}
            session={paperSession}
            onClose={() => setCompareOpen(false)}
            onChanged={props.onChanged}
            onQuote={addQuote}
          />
        </Suspense>
      )}
      {attachmentsOpen && !editing && (
        <Modal
          title={`所有附件（${note.attachments.length}）`}
          className="attachments-modal"
          onClose={() => setAttachmentsOpen(false)}
        >
          <Attachments
            files={note.attachments}
            onPreview={(file) => {
              setAttachmentsOpen(false);
              previewFile(file);
            }}
            onCreate={(file) => {
              setAttachmentsOpen(false);
              props.onFileNode(file, id);
            }}
          />
        </Modal>
      )}
      {childrenOpen && !editing && (
        <Modal
          title={`下级笔记（${note.child_count ?? 0}）`}
          className="children-modal"
          onClose={() => setChildrenOpen(false)}
        >
          <NodeList
            parent={id}
            refresh={props.treeRefresh}
            onOpen={(node) => {
              setChildrenOpen(false);
              props.onOpen(node);
            }}
            onAction={props.onAction}
          />
        </Modal>
      )}
      {toc.compact && toc.dialogOpen && (
        <Modal title="标题目录" className="toc-modal" onClose={toc.closeDialog}>
          {toc.nav}
        </Modal>
      )}
      {image && (
        <Suspense fallback={<Spinner />}>
          <ImageViewer {...image} onClose={() => setImage(null)} />
        </Suspense>
      )}
      {pdf && (
        <Modal
          title={pdf.name}
          onClose={() => {
            setTranslation(null);
            setPdf(null);
          }}
          wide
          className="pdf-modal"
        >
          <Suspense fallback={<Spinner />}>
            <PdfView
              key={pdf.id}
              fileId={pdf.id}
              selectionOwner={id}
              sourceLocation={pdfLocation}
            />
          </Suspense>
        </Modal>
      )}
      {historyOpen && (
        <HistoryDialog
          note={note}
          onClose={() => setHistoryOpen(false)}
          onImage={showImage}
          onNavigate={props.onNavigate}
          onPreviewFile={previewFile}
          onRestore={async (version) => {
            if (!(await leave())) return;
            if (
              !(await question.confirm(
                '恢复这个版本？',
                '恢复后会生成新的当前版本，现有正文进入历史；标题与节点位置保持原样。',
                '确认并恢复',
              ))
            )
              return;
            await unlockNote(id);
            await api(`/api/nodes/${id}/versions/${version}/restore`, 'POST', {
              revision: noteRef.current!.revision,
            });
            lockNote(id);
            applyDetail(await api<NoteDetail>(`/api/nodes/${id}`));
            props.onChanged();
            setHistoryOpen(false);
          }}
        />
      )}
      {linkOpen && (
        <LinkDialog
          onInsert={(target) => insert(markdownLink(target))}
          onClose={() => setLinkOpen(false)}
        />
      )}
      {question.dialog}
    </div>
  );
}
