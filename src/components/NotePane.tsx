import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { FileText, X } from 'lucide-react';
import { api, ApiError, fileUrl, lockNote, unlockNote } from '../api';
import {
  TEXT_KINDS,
  variantOf,
  type FileInfo,
  type NoteDetail,
  type NoteNode,
} from '../../shared/types';
import { openLink } from '../open-link';
import { Empty, Modal, Spinner, useQuestion } from './Primitives';
import { Attachments } from './Attachments';
import type { EditorHandle } from './Editor';
import { useMarkdownReady } from './LazyMarkdown';
import { HistoryDialog } from './HistoryDialog';
import { EditToolbar, NoteHeading, NoteLocation, SaveErrorBar } from './NoteChrome';
import { NoteBody } from './NoteBody';
import { LinkDialog, markdownLink } from './LinkDialog';
import { useNoteEditor } from '../use-note-editor';
import { NoteActions } from './NoteActions';
import { NodeList } from './NodeList';
import { FastScroll } from './FastScroll';
import { NodeMenu, type NodeAction } from './Tree';
import { LockedNote } from './Encryption';
import { isUnlocked } from '../keyring';
import { AssistantPanel, type AssistantHandle } from './AssistantPanel';
import type { AssistantMode } from './AssistantWindow';
import { SelectionToolbar } from './SelectionToolbar';
import { TranslationPanel } from './TranslationPanel';
import type { TranslationLaunch } from '../translation';
import type { PdfSourceLocation, SourceLocation } from '../../shared/translation';
import { clearSourceHighlight, locateTextSource } from '../source-location';
import { exportAnnotations, useAnnotations } from '../annotations';
import type { Annotation } from '../../shared/annotations';
import { useAnnotationLayer } from '../use-annotation-layer';
import { AnnotationList, AnnotationPanel } from './AnnotationDialogs';
import { useOffline } from '../connectivity';
import { useTypeView } from '../note-types';
import type { ProjectContext } from '../../shared/projects';
import { setInsertTarget } from '../note-insert';
import { useNoteLoading } from '../use-note-loading';
import { useNoteReading } from '../use-note-reading';
import { useNoteAnnotationPosition } from '../use-note-annotation-position';
import { useReadingWindow } from '../reading-window';
import { settleChange, showChange } from '../optimistic';
import { pendingSaves, subscribeSaves } from '../save-outbox';

const Editor = lazy(() => import('./Editor'));
const SplitView = lazy(() => import('./SplitView'));
const PdfView = lazy(() => import('./PdfView'));
const ImageViewer = lazy(() => import('./ImageViewer'));

interface Props {
  id: string;
  projectContext?: ProjectContext;
  refresh: number;
  treeRefresh: number;
  showSidebar: boolean;
  globalAssistantOpen: boolean;
  onGlobalAssistant: (selection: string) => void;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onBack: () => void;
  onNavigate: (id: string, project?: ProjectContext) => void;
  // A note created from this page (e.g. a journal entry), opened for writing.
  onCreated: (node: NoteNode) => void;
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
  const [note, setNote] = useState<NoteDetail | null>(null),
    noteRef = useRef<NoteDetail | null>(null);
  const [appending, setAppending] = useState(false);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null),
    [pdf, setPdf] = useState<FileInfo | null>(null);
  const [childrenOpen, setChildrenOpen] = useState(false),
    [attachmentsOpen, setAttachmentsOpen] = useState(false),
    [splitOpen, setSplitOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [linkOpen, setLinkOpen] = useState(false);
  const question = useQuestion();
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
    setLeaveGuard: (guard) => props.setLeaveGuard(async () => {
      if (!appending) return guard();
      props.onNotice?.('正在保存，请稍候再离开。');
      return false;
    }),
    onStart: () => setTranslation(null),
    onChanged: props.onChanged,
    onError: props.onError,
    editorRef: editorHandle,
  });
  const {
    scroll, reading, toc, touched, restored, tocPosition, revealAppend, restorePosition, recordScroll,
  } = useNoteReading({ id, note, editing });
  const { loadError, retry, setRetry, stale, applyDetail } = useNoteLoading({
    id,
    refresh: props.refresh,
    editing,
    note,
    noteRef,
    setNote,
    reset,
    onLoaded: props.onLoaded,
  });
  // This note's body on its way to the server (保存 returned at once).
  const saves = useSyncExternalStore(subscribeSaves, pendingSaves);
  const sending = saves.find((item) => item.id === id && !item.error);
  // Android: the screen stays on, encrypted notes block screenshots, volume keys page.
  useReadingWindow(!!note, !!note?.key_id, !!note && !editing);
  // While editing, 随手记 can insert a clip at the cursor.
  const inserting = useRef({ insert, addFiles });
  inserting.current = { insert, addFiles };
  const editingTitle = editing ? (note?.title ?? '') : null;
  useEffect(() => {
    if (editingTitle === null) return;
    setInsertTarget({
      id,
      title: editingTitle,
      insert: (text) => inserting.current.insert(text),
      addFiles: (files) => inserting.current.addFiles(files),
    });
    return () => setInsertTarget(null);
  }, [id, editingTitle]);
  // Once per opened note, offer a draft that was never saved.
  const draftChecked = useRef(false);
  const loadedId = note?.id;
  useEffect(() => {
    if (!loadedId || stale || draftChecked.current || !TEXT_KINDS.includes(noteRef.current!.kind))
      return;
    draftChecked.current = true;
    void offerDraft();
    // offerDraft reads the latest note through noteRef; run once it has loaded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId, stale]);
  // The E shortcut, sent by the notebook when no field has focus.
  const editShortcut = useRef(() => {});
  editShortcut.current = () => {
    if (note && TEXT_KINDS.includes(note.kind) && !editing && !offline && !stale && !appending) void startEdit();
  };
  useEffect(() => {
    const edit = () => editShortcut.current();
    window.addEventListener('note:edit-shortcut', edit);
    return () => window.removeEventListener('note:edit-shortcut', edit);
  }, []);
  const { autoEdit, onAutoEdit } = props;
  useEffect(() => {
    // A new journal entry opens with its composer instead of the full editor.
    if (
      !autoEdit ||
      !note ||
      editing ||
      !TEXT_KINDS.includes(note.kind) ||
      (note.content && !note.journal_entry)
    )
      return;
    onAutoEdit?.();
    if (note.journal_entry) return;
    void startEdit(false);
    // startEdit is recreated each render; this runs once the new note has loaded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit, note, editing, onAutoEdit]);
  useEffect(() => {
    clearSourceHighlight();
    return clearSourceHighlight;
  }, [id, note?.content, editing]);
  // "问青藜" on a selection: the open conversation quotes it. A type may route
  // it elsewhere (a book page starts a discussion); see typeView below.
  const quoteInAssistant = (text: string) => {
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
  const showImage = useCallback((src: string, alt: string) => setImage({ src, alt }), []);
  const previewFile = (file: FileInfo) => {
    if (file.mime.startsWith('image/')) showImage(fileUrl(file.id), file.name);
    else if (file.mime === 'application/pdf') setPdf(file);
    else openLink(fileUrl(file.id, true));
  };
  // Shown at once; withdrawn if the server refuses.
  const toggleFavorite = async () => {
    if (!note) return;
    const favorite = note.favorite ? 0 : 1;
    const mark = (value: number) => {
      if (!noteRef.current) return;
      noteRef.current = { ...noteRef.current, favorite: value };
      setNote(noteRef.current);
    };
    mark(favorite);
    const withdraw = showChange(id, { fields: { favorite } });
    try {
      await api(`/api/nodes/${id}/favorite`, 'PUT', { enabled: !!favorite });
      props.onChanged();
      settleChange(withdraw);
    } catch (e) {
      withdraw();
      mark(favorite ? 0 : 1);
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
  const markdownReady = useMarkdownReady(note?.kind === 'markdown');

  // Highlights and notes on the rendered text (Markdown, plain text, papers).
  const annotatable =
    !!note && (TEXT_KINDS.includes(note.kind) || !!note.arxiv_id || note.kind === 'pdf');
  const annotations = useAnnotations(id, annotatable);
  const [annotationsOpen, setAnnotationsOpen] = useState(false),
    [currentAnnotation, setCurrentAnnotation] = useState('');
  const annotationList = annotations.list;
  const layer = useAnnotationLayer({
    store: annotations,
    owner: 'note',
    root: () => readingRoot.current?.querySelector<HTMLElement>('.read-content') ?? null,
    active: !editing,
    offline,
    paintKey: `${note?.id}:${note?.current_version_id}:${markdownReady}`,
    markerHost: () => scroll.current?.querySelector<HTMLElement>('.note-article') ?? null,
    onAsk: (text) => addQuote(text),
  });
  const { missingAnnotations, locateAnnotation } = useNoteAnnotationPosition({
    id,
    note,
    annotationList,
    missingText: layer.missingText,
    locateSource,
    onNotice: props.onNotice,
  });
  // The type's own parts of the page: book, book page, project, paper (see note-types).
  const projectContext = props.projectContext ?? (note?.project_id && note.project_category
    ? { id: note.project_id, category: note.project_category } : undefined);
  const displayNote = note && projectContext && note.kind === 'markdown'
    ? { ...note, project_category: projectContext.category } : note;
  const typeView = useTypeView(
    {
      note: displayNote,
      projectContext,
      editing,
      offline: offline || stale,
      refreshKey: props.treeRefresh + retry,
      refresh: () => setRetry((count) => count + 1),
      onAppended: () => {
        revealAppend.current = true;
        setRetry((count) => count + 1);
        props.onChanged();
      },
      setAppending,
      appending,
      assistantOpen,
      openAssistant: () => {
        setTranslation(null);
        setPdf(null);
        setAssistantOpen(true);
      },
      onOpen: props.onOpen,
      onNavigate: props.onNavigate,
      onCreated: props.onCreated,
      onChanged: props.onChanged,
      onError: props.onError,
      onNotice: props.onNotice,
      confirm: question.confirm,
    },
    { quote: (text) => addQuote(text), annotations, realOffline: offline },
  );
  function addQuote(text: string): string | undefined {
    return typeView.addQuote ? typeView.addQuote(text) : quoteInAssistant(text);
  }
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
  const lockedKey =
    note.locked ?? (note.key_id && !isUnlocked(note.key_id) && !editing ? note.key_id : null);
  if (lockedKey)
    return (
      <div className="note-pane">
        <div className="note-toolbar">
          {navigation}
          <div className="note-actions is-short">
            <NodeMenu node={note} onAction={props.onAction} />
          </div>
        </div>
        <div className="note-scroll">
          <LockedNote note={note} keyId={lockedKey} />
        </div>
      </div>
    );
  // Wide windows keep the list open beside the text; narrow ones use a dialog.
  const annotationPanel = annotationsOpen && !editing && !toc.compact;
  const annotationListProps = {
    list: annotationList,
    missing: missingAnnotations,
    offline,
    current: currentAnnotation,
    onLocate: (item: Annotation) => {
      setCurrentAnnotation(item.id);
      if (!annotationPanel) setAnnotationsOpen(false);
      // Wait for a dialog to close so focus and scrolling land in the text.
      requestAnimationFrame(() => {
        const failed = locateAnnotation(item);
        if (failed) props.onNotice?.(failed);
      });
    },
    onEdit: (item: Annotation) => {
      if (!annotationPanel) setAnnotationsOpen(false);
      layer.setDraft({ ...item, saved: true });
    },
    onExport: async () => {
      const result = await exportAnnotations(id, note.title, annotationList);
      props.onChanged();
      setRetry((count) => count + 1);
      return `${result.updated ? '已更新' : '已保存为'}子笔记「${result.title}」（${result.count} 条）`;
    },
    onClose: () => setAnnotationsOpen(false),
  };
  return (
    <div className={`note-pane ${editing ? 'is-editing' : ''}`}>
      <div className="note-toolbar">
        {navigation}
        <NoteActions
          note={displayNote!}
          editing={editing}
          offline={offline || stale || appending}
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
          onCompare={() => typeView.compare?.open()}
          compareProgress={typeView.compare?.progress}
          onSplit={() => setSplitOpen(true)}
          annotationCount={annotatable ? annotationList.length : 0}
          annotationsOpen={annotationPanel}
          onAnnotations={() => setAnnotationsOpen((open) => !(open && !toc.compact))}
          onEdit={() => void startEdit()}
          menu={typeView.menu}
          onAction={props.onAction}
        />
        {typeView.toolbar}
      </div>
      {sending && !editing && (
        <p className="save-pending" role="status">
          {offline ? '修改已保存在本设备，联网后自动保存到服务器。' : '正在保存修改…'}
        </p>
      )}
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
                  annotations={annotationList}
                  onAnnotation={layer.open}
                />
              </Suspense>
            ) : (
              <Spinner />
            )
          ) : (
            <div className="note-reading-column">
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
                onClick={layer.onClick}
              >
                <article className={`note-article variant-${variantOf(note)}`}>
                  <NoteHeading
                    note={displayNote!}
                    editing={editing}
                    title={typeView.title}
                    kind={typeView.kind}
                    actions={typeView.headingActions}
                    onNew={() => props.onAction('new', note)}
                  />
                  <NoteBody
                    note={note}
                    editing={editing}
                    content={content}
                    onNavigate={props.onNavigate}
                    onImage={showImage}
                    onHeadings={toc.onHeadings}
                    records={typeView.records}
                    hideHeading={typeView.hideHeading}
                  />
                  {!editing && layer.marks}
                  {typeView.below}
                  {TEXT_KINDS.includes(note.kind) && !typeView.hideAttachments && (
                    <Attachments
                      files={editing ? assets : note.attachments}
                      editing={editing}
                      onRemove={removeAsset}
                      onPreview={previewFile}
                      onCreate={!editing ? (file) => props.onFileNode(file, id) : undefined}
                    />
                  )}
                  {/* A folder is its list; other notes open their children from the toolbar.
                      A type may show its own overview instead (book, project, reference). */}
                  {typeView.children ??
                    (note.kind === 'folder' && !editing && (
                      <section className="children-section is-folder" aria-label="下级笔记">
                        <NodeList
                          parent={id}
                          onNew={() => props.onAction('new', note)}
                          refresh={props.treeRefresh}
                          onOpen={props.onOpen}
                          onAction={props.onAction}
                        />
                      </section>
                    ))}
                </article>
              </div>
              {typeView.footer}
            </div>
          )}
          {!editing &&
            (note.kind === 'markdown' || note.arxiv_id) &&
            toc.headings.length > 0 &&
            !toc.compact &&
            toc.sideOpen &&
            !annotationPanel && (
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
          {annotationPanel && <AnnotationPanel {...annotationListProps} />}
        </div>
        {/* Folders have no conversation, except a book about the whole book. */}
        {(note.kind !== 'folder' || variantOf(note) === 'book') && (
          <AssistantPanel
            // The shared 青藜; a type may give it another conversation, title,
            // context line or header actions (a book page's discussions).
            key={typeView.assistant?.key}
            node={typeView.assistant?.node ?? note}
            title={typeView.assistant?.title}
            fileNode={typeView.assistant?.fileNode}
            context={typeView.assistant?.context}
            headerActions={typeView.assistant?.headerActions}
            initialPrompt={typeView.assistant?.initialPrompt}
            initialQuote={typeView.assistant?.initialQuote}
            onDraftSend={typeView.assistant?.onDraftSend}
            onReplied={typeView.assistant?.onReplied}
            actionsRef={assistantActions}
            showLauncher={typeView.assistant?.showLauncher}
            visible={assistantOpen && !editing}
            enabled={!editing && !props.globalAssistantOpen}
            onGlobal={
              typeView.assistant?.noGlobal ? undefined : () => props.onGlobalAssistant(selection)
            }
            // Docked beside the article has no place in a full-screen view.
            mode={
              (typeView.fullscreen || splitOpen) && assistantMode === 'docked'
                ? 'floating'
                : assistantMode
            }
            onModeChange={setAssistantMode}
            selection={selection}
            readingRoot={readingRoot}
            onClose={() => setAssistantOpen(false)}
            onOpen={() => setAssistantOpen(true)}
            onChanged={() => {
              props.onChanged();
              typeView.assistant?.onReplied?.();
            }}
            onSettings={props.onSettings}
            onNavigate={props.onNavigate}
            onImage={showImage}
            annotationCount={annotationList.length}
          />
        )}
      </div>
      {!editing && note.kind !== 'folder' && (
        <SelectionToolbar
          owner={id}
          clipSource={{ id: note.id, title: note.title }}
          onSelection={setSelection}
          onQuote={addQuote}
          onTranslate={setTranslation}
          onAnnotate={annotatable ? layer.annotate : undefined}
        />
      )}
      {layer.editor}
      {annotationsOpen && !editing && toc.compact && <AnnotationList {...annotationListProps} />}
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
      {typeView.dialogs}
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
              annotations={annotationList}
              onAnnotation={layer.open}
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
