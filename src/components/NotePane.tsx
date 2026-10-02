import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  History,
  Languages,
  Link2,
  List,
  Menu,
  Paperclip,
  Pencil,
  Plus,
  Star,
  X,
} from 'lucide-react';
import { api, ApiError, fileUrl, formatDate, lockNote, unlockNote, upload } from '../api';
import {
  KIND_LABELS,
  PARENT_KINDS,
  TEXT_KINDS,
  type FileInfo,
  type NoteDetail,
  type NoteNode,
  type ReadingPosition,
  type VersionInfo,
} from '../../shared/types';
import { useReading } from '../useReading';
import { openLink } from '../open-link';
import { Empty, Modal, NodeIcon, Spinner, useQuestion } from './Primitives';
import { MarkdownView, type Heading } from './MarkdownView';
import { Attachments, NodeList } from './Management';
import { FastScroll } from './FastScroll';
import { NodeMenu, NodePicker, type NodeAction } from './Tree';
import { AssistantPanel, type AssistantHandle } from './AssistantPanel';
import type { AssistantMode } from './AssistantWindow';
import { PaperView } from './PaperView';
import { SelectionToolbar } from './SelectionToolbar';
import { TranslationPanel } from './TranslationPanel';
import type { TranslationLaunch } from '../translation';
import type { PdfSourceLocation, SourceLocation } from '../../shared/translation';
import { clearSourceHighlight, locateTextSource } from '../source-location';
import { ReadingSettingsButton } from './ReadingSettings';
import { useReadingPreferences } from '../reading-preferences';
import { useOffline } from '../connectivity';
import { CachedImage } from './CachedImage';

const Editor = lazy(() => import('./Editor'));
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
}

const closeMenu = (element: Element) => {
  const menu = element.closest('details');
  if (menu) menu.open = false;
};
export default function NotePane(props: Props) {
  const { id } = props;
  const offline = useOffline();
  const readingPreferences = useReadingPreferences();
  const [note, setNote] = useState<NoteDetail | null>(null),
    noteRef = useRef<NoteDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [editing, setEditing] = useState(false),
    [content, setContent] = useState(''),
    [assets, setAssets] = useState<FileInfo[]>([]);
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [saveError, setSaveError] = useState('');
  const [editTab, setEditTab] = useState<'source' | 'preview'>('source');
  const [headings, setHeadings] = useState<Heading[]>([]),
    [activeHeading, setActiveHeading] = useState(''),
    [tocOpen, setTocOpen] = useState(false);
  const [desktopTocOpen, setDesktopTocOpen] = useState(true);
  const [compactToc, setCompactToc] = useState(
    () => window.matchMedia('(max-width: 1150px)').matches,
  );
  const tocId = useId();
  const tocToggle = useRef<HTMLButtonElement>(null);
  const tocPosition = useRef<ReadingPosition | null>(null);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null),
    [pdf, setPdf] = useState<FileInfo | null>(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [linkOpen, setLinkOpen] = useState(false),
    [linkTarget, setLinkTarget] = useState<{ id: string; title: string } | null>(null);
  const question = useQuestion(),
    scroll = useRef<HTMLDivElement>(null),
    draftUploads = useRef(new Set<string>());
  const reading = useReading(id),
    restored = useRef(false),
    touched = useRef(false);
  const saveRequest = useRef<{ payload: string; key: string } | null>(null);
  const readingRoot = useRef<HTMLDivElement>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('floating');
  const [selection, setSelection] = useState('');
  const assistantActions = useRef<AssistantHandle>(null);
  const [translation, setTranslation] = useState<TranslationLaunch | null>(null);
  const [pdfLocation, setPdfLocation] = useState<PdfSourceLocation | null>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1150px)');
    const update = () => {
      setCompactToc(query.matches);
      setTocOpen(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
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
  const dirty =
    !!note &&
    (content !== note.content ||
      assets
        .map((f) => f.id)
        .sort()
        .join() !==
        note.attachments
          .map((f) => f.id)
          .sort()
          .join());
  const applyDetail = (detail: NoteDetail) => {
    noteRef.current = detail;
    setNote(detail);
    setContent(detail.content);
    setAssets(detail.attachments);
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
  }, [id, props.refresh, editing]);
  useEffect(() => {
    if (!editing || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing, dirty]);

  const abandonUploads = () => {
    for (const fileId of draftUploads.current)
      void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
    draftUploads.current.clear();
  };
  const exitEdit = () => {
    setEditing(false);
    lockNote(id);
    setSaveError('');
  };
  const save = async (): Promise<boolean> => {
    if (!noteRef.current || busy || uploading) return false;
    setBusy(true);
    setSaveError('');
    const payload = {
      content,
      attachments: assets.map((file) => file.id),
      revision: noteRef.current.revision,
    };
    const fingerprint = JSON.stringify(payload);
    if (saveRequest.current?.payload !== fingerprint)
      saveRequest.current = { payload: fingerprint, key: crypto.randomUUID() };
    try {
      await api<NoteNode>(`/api/nodes/${id}/content`, 'PUT', payload, saveRequest.current.key);
      // Commit the local baseline before any navigation guard can run again.
      const detail = await api<NoteDetail>(`/api/nodes/${id}`);
      noteRef.current = detail;
      setNote(detail);
      setContent(detail.content);
      setAssets(detail.attachments);
      for (const fileId of draftUploads.current)
        if (!detail.attachments.some((file) => file.id === fileId))
          void api(`/api/files/${fileId}`, 'DELETE').catch(() => {});
      draftUploads.current.clear();
      exitEdit();
      props.onChanged();
      return true;
    } catch (error) {
      setSaveError((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const leave = async (): Promise<boolean> => {
    if (busy || uploading) return false;
    if (!editing) return true;
    if (dirty) {
      const answer = await question.ask('还有未保存的修改', '离开之前，如何处理这篇笔记的修改？', [
        { value: 'cancel', label: '继续编辑' },
        { value: 'discard', label: '放弃修改', danger: true },
        { value: 'save', label: '保存并离开' },
      ]);
      if (answer === 'save') return save();
      if (answer !== 'discard') return false;
    }
    abandonUploads();
    setContent(noteRef.current?.content || '');
    setAssets(noteRef.current?.attachments || []);
    exitEdit();
    return true;
  };
  useEffect(() => {
    props.setLeaveGuard(leave);
    return () => props.setLeaveGuard(async () => true);
  });
  const startEdit = async () => {
    if (
      !(await question.confirm(
        '编辑这篇笔记？',
        '确认后可以修改正文和附件。手动保存后回到只读预览。',
        '开始编辑',
      ))
    )
      return;
    try {
      await unlockNote(id);
      setTranslation(null);
      setEditing(true);
      setEditTab('source');
      setSaveError('');
    } catch (e) {
      props.onError(e);
    }
  };
  const onHeadings = useCallback((value: Heading[]) => setHeadings(value), []);
  const showImage = useCallback((src: string, alt: string) => setImage({ src, alt }), []);
  const restorePosition = useCallback(() => {
    if (!note || !reading.initial || editing || touched.current || !scroll.current) return;
    restoreTextPosition(scroll.current, reading.initial);
    restored.current = true;
  }, [note?.id, reading.initial, editing]);
  useEffect(() => {
    const timer = window.setTimeout(restorePosition, 120);
    return () => clearTimeout(timer);
  }, [restorePosition, headings]);
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
  }, [desktopTocOpen, readingPreferences]);
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
    setActiveHeading(heading);
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
  const toggleToc = () => {
    if (compactToc) setTocOpen((open) => !open);
    else {
      touched.current = restored.current = true;
      tocPosition.current = recordScroll() ?? null;
      setDesktopTocOpen((open) => !open);
      tocToggle.current?.focus({ preventScroll: true });
    }
  };
  const closeToc = () => {
    setTocOpen(false);
    requestAnimationFrame(() => tocToggle.current?.focus({ preventScroll: true }));
  };
  const jump = (heading: Heading) => {
    touched.current = true;
    restored.current = true;
    setActiveHeading(heading.id);
    setTocOpen(false);
    // Close the modal before scrolling: native dialog focus restoration otherwise
    // competes with the requested reading position on mobile browsers.
    requestAnimationFrame(() =>
      scroll.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };
  const toc = (
    <nav id={tocId} className="toc" aria-label="标题目录">
      {headings.map((heading) => (
        <button
          key={heading.id}
          className={activeHeading === heading.id ? 'active' : ''}
          aria-current={activeHeading === heading.id ? 'location' : undefined}
          style={{ paddingLeft: 12 + (heading.level - 1) * 10 }}
          onClick={() => jump(heading)}
        >
          {heading.title || '无标题'}
        </button>
      ))}
    </nav>
  );
  const previewFile = (file: FileInfo) => {
    if (file.mime.startsWith('image/')) showImage(fileUrl(file.id), file.name);
    else if (file.mime === 'application/pdf') setPdf(file);
    else openLink(fileUrl(file.id, true));
  };
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setSaveError('');
    try {
      for (const selected of Array.from(files)) {
        const file = await upload(selected);
        draftUploads.current.add(file.id);
        setAssets((previous) => [...previous, file]);
        if (note?.kind === 'markdown' && file.mime.startsWith('image/'))
          setContent(
            (previous) =>
              `${previous}\n\n![${file.name.replace(/[\[\]\\]/g, '')}](${fileUrl(file.id)})\n`,
          );
      }
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const navigation = (
    <div className="note-location">
      <button className="icon-button page-back" aria-label="返回" onClick={props.onBack}>
        <ChevronLeft size={22} />
      </button>
      {props.showSidebar && (
        <button
          className="icon-button mobile-menu"
          aria-label="打开笔记目录"
          aria-controls="notebook-sidebar"
          aria-expanded={props.sidebarOpen}
          onClick={props.onOpenSidebar}
        >
          <Menu size={21} />
        </button>
      )}
      <div className="breadcrumbs">
        <button onClick={() => props.onNavigate('')}>全部笔记</button>
        {note?.breadcrumbs.map((part, index) => (
          <span key={part.id}>
            <ChevronRight size={13} />
            <button
              title={part.title}
              disabled={index === note.breadcrumbs.length - 1}
              onClick={() => props.onNavigate(part.id)}
            >
              {part.title}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
  if (loadError || !note)
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
                <button className="button" onClick={() => window.location.reload()}>
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
        <div className="note-actions">
          {!editing && (TEXT_KINDS.includes(note.kind) || note.arxiv_id) && (
            <ReadingSettingsButton
              beforeChange={() => {
                touched.current = restored.current = true;
                tocPosition.current = recordScroll() ?? reading.initial;
              }}
            />
          )}
          {note.kind !== 'folder' && !editing && (
            <button
              className="icon-button toolbar-secondary"
              aria-label="翻译记录"
              disabled={offline}
              title="翻译记录"
              aria-expanded={!!translation}
              onClick={() => setTranslation({})}
            >
              <Languages size={18} />
            </button>
          )}
          <button
            className={`icon-button ${note.favorite ? 'is-favorite' : ''}`}
            aria-label={note.favorite ? '取消收藏' : '收藏笔记'}
            disabled={offline}
            title={note.favorite ? '取消收藏' : '收藏'}
            onClick={async () => {
              try {
                await api(`/api/nodes/${id}/favorite`, 'PUT', { enabled: !note.favorite });
                const next = { ...note, favorite: note.favorite ? 0 : 1 };
                noteRef.current = next;
                setNote(next);
                props.onChanged();
              } catch (e) {
                props.onError(e);
              }
            }}
          >
            <Star size={18} fill={note.favorite ? 'currentColor' : 'none'} />
          </button>
          {TEXT_KINDS.includes(note.kind) && (
            <button
              className="icon-button toolbar-secondary"
              aria-label="版本历史"
              disabled={offline}
              title="版本历史"
              onClick={() => setHistoryOpen(true)}
            >
              <History size={18} />
            </button>
          )}
          {!editing && (note.kind === 'markdown' || note.arxiv_id) && headings.length > 0 && (
            <button
              ref={tocToggle}
              className="icon-button toc-toggle"
              aria-label="标题目录"
              title={(compactToc ? tocOpen : desktopTocOpen) ? '隐藏目录' : '显示目录'}
              aria-expanded={compactToc ? tocOpen : desktopTocOpen}
              aria-controls={tocId}
              aria-haspopup={compactToc ? 'dialog' : undefined}
              onClick={toggleToc}
            >
              <List size={18} />
            </button>
          )}
          {!editing && TEXT_KINDS.includes(note.kind) && note.attachments.length > 0 && (
            <button
              className="icon-button attachments-toggle toolbar-secondary"
              aria-label={`附件（${note.attachments.length}）`}
              title="附件"
              aria-haspopup="dialog"
              onClick={() => setAttachmentsOpen(true)}
            >
              <Paperclip size={18} />
              <span className="toolbar-badge" aria-hidden="true">
                {note.attachments.length}
              </span>
            </button>
          )}
          {!editing && TEXT_KINDS.includes(note.kind) && (
            <button
              className="button compact edit-note-button"
              aria-label="编辑正文"
              disabled={offline}
              title="编辑正文"
              onClick={startEdit}
            >
              <Pencil size={15} />
              <span>编辑正文</span>
            </button>
          )}
          {!editing && (
            <NodeMenu node={note} onAction={props.onAction}>
              {/* On phones these leave the toolbar so it stays on one row. */}
              {note.kind !== 'folder' && (
                <button
                  className="menu-compact-only"
                  disabled={offline}
                  onClick={(event) => {
                    closeMenu(event.currentTarget);
                    setTranslation({});
                  }}
                >
                  翻译记录
                </button>
              )}
              {TEXT_KINDS.includes(note.kind) && (
                <button
                  className="menu-compact-only"
                  disabled={offline}
                  onClick={(event) => {
                    closeMenu(event.currentTarget);
                    setHistoryOpen(true);
                  }}
                >
                  版本历史
                </button>
              )}
              {TEXT_KINDS.includes(note.kind) && note.attachments.length > 0 && (
                <button
                  className="menu-compact-only"
                  onClick={(event) => {
                    closeMenu(event.currentTarget);
                    setAttachmentsOpen(true);
                  }}
                >
                  附件（{note.attachments.length}）
                </button>
              )}
              <hr className="menu-compact-only" />
            </NodeMenu>
          )}
        </div>
      </div>
      {editing && (
        <div className="edit-toolbar">
          <span className="editing-label">
            <Pencil size={14} />
            正在编辑{dirty ? ' · 未保存' : ''}
          </span>
          <div className="edit-tabs">
            <button
              className={editTab === 'source' ? 'active' : ''}
              onClick={() => setEditTab('source')}
            >
              源码
            </button>
            <button
              className={editTab === 'preview' ? 'active' : ''}
              onClick={() => setEditTab('preview')}
            >
              预览
            </button>
          </div>
          <label className="button compact file-input-button">
            <Paperclip size={15} />
            <span>{uploading ? '上传中…' : '附件 / 图片'}</span>
            <input
              aria-label="上传附件"
              type="file"
              multiple
              disabled={busy || uploading}
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          {note.kind === 'markdown' && (
            <button
              className="icon-button"
              aria-label="插入笔记链接"
              disabled={busy || uploading}
              onClick={() => setLinkOpen(true)}
            >
              <Link2 size={17} />
            </button>
          )}
          <span className="toolbar-spacer" />
          <button className="button compact" disabled={busy || uploading} onClick={leave}>
            取消
          </button>
          <button
            className="button primary compact"
            disabled={busy || uploading}
            onClick={() => save()}
          >
            <Check size={15} />
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      )}
      {saveError && (
        <div className="save-error" role="alert">
          <span>{saveError}</span>
          <button
            className="text-button"
            onClick={() => {
              const href = URL.createObjectURL(
                new Blob([content], {
                  type: `${note.kind === 'markdown' ? 'text/markdown' : 'text/plain'};charset=utf-8`,
                }),
              );
              const a = document.createElement('a');
              a.href = href;
              a.download = `${note.title}.${note.kind === 'markdown' ? 'md' : 'txt'}`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(href), 1000);
            }}
          >
            下载当前草稿
          </button>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await unlockNote(id);
                setSaveError('编辑确认已更新，请再次保存。');
              } catch (e) {
                props.onError(e);
              }
            }}
          >
            重新确认编辑
          </button>
        </div>
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
                    void save();
                  }}
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
              >
                <article className="note-article">
                  <header className="document-heading">
                    <h1>{note.title}</h1>
                    {/* Kind, date and New share one ruled row to keep the page top short. */}
                    <div className="document-meta">
                      <span className="document-kind">
                        <NodeIcon
                          node={note}
                          kind={note.arxiv_id ? 'arxiv' : note.kind}
                          size={14}
                        />
                        {note.arxiv_id ? 'arXiv 论文' : KIND_LABELS[note.kind]}
                      </span>
                      {note.arxiv_id ? (
                        <a
                          className="paper-source"
                          href={note.url!}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          arXiv:{note.arxiv_id}
                          <ArrowUpRight size={13} />
                        </a>
                      ) : (
                        <span>更新于 {formatDate(note.updated_at)}</span>
                      )}
                      {PARENT_KINDS.includes(note.kind) && !editing && (
                        <button className="text-button" onClick={() => props.onAction('new', note)}>
                          <Plus size={14} />
                          新建
                        </button>
                      )}
                    </div>
                  </header>
                  <div className="read-content" data-version-id={note.current_version_id}>
                    {note.arxiv_id ? (
                      <PaperView note={note} onHeadings={onHeadings} onImage={showImage} />
                    ) : note.kind === 'markdown' ? (
                      content ? (
                        <MarkdownView
                          content={editing ? content : note.content}
                          onNavigate={props.onNavigate}
                          onImage={showImage}
                          onHeadings={onHeadings}
                        />
                      ) : (
                        <p className="empty-body">暂无内容。点击「编辑正文」开始编辑。</p>
                      )
                    ) : note.kind === 'text' ? (
                      <div className="plain-text">
                        {((editing ? content : note.content) || '暂无内容')
                          .split(/\r?\n\r?\n/)
                          .map((paragraph, index) => (
                            <p key={index}>{paragraph || '\u00a0'}</p>
                          ))}
                      </div>
                    ) : note.kind === 'image' && note.file ? (
                      <button
                        className="image-node"
                        aria-label="放大查看图片"
                        onClick={() => showImage(fileUrl(note.file!.id), note.title)}
                      >
                        <CachedImage src={fileUrl(note.file.id)} alt={note.title} />
                      </button>
                    ) : note.kind === 'link' ? (
                      <a
                        className="external-link"
                        href={note.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ArrowUpRight size={22} />
                        <strong>打开网页</strong>
                        <span>{note.url}</span>
                      </a>
                    ) : null}
                  </div>
                  {/* While reading, attachments open from the toolbar instead. */}
                  {TEXT_KINDS.includes(note.kind) && editing && (
                    <Attachments
                      files={assets}
                      editing
                      onRemove={(fileId) => {
                        setAssets((previous) => previous.filter((file) => file.id !== fileId));
                        if (note.kind === 'markdown')
                          setContent((previous) =>
                            previous.replace(
                              new RegExp(`!\\[[^\\]]*\\]\\(/api/files/${fileId}\\)`, 'g'),
                              '',
                            ),
                          );
                      }}
                      onPreview={previewFile}
                    />
                  )}
                  {/* A folder is its list; other kinds list children below their body. */}
                  {PARENT_KINDS.includes(note.kind) &&
                    !editing &&
                    (note.kind === 'folder' || !!note.child_count) && (
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
            headings.length > 0 &&
            !compactToc &&
            desktopTocOpen && (
              <aside
                className="desktop-toc"
                aria-label="标题目录面板"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleToc();
                  }
                }}
              >
                <div className="toc-heading">
                  <span>本篇目录</span>
                  <button className="icon-button" aria-label="隐藏标题目录" onClick={toggleToc}>
                    <X size={16} />
                  </button>
                </div>
                {toc}
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
            mode={assistantMode}
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
      {attachmentsOpen && !editing && (
        <Modal
          title={`附件（${note.attachments.length}）`}
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
      {compactToc && tocOpen && (
        <Modal title="标题目录" className="toc-modal" onClose={closeToc}>
          {toc}
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
        <Modal title="插入笔记链接" onClose={() => setLinkOpen(false)}>
          <NodePicker
            value={linkTarget?.id || null}
            onSelect={(target, title) => {
              if (target) setLinkTarget({ id: target, title });
            }}
          />
          <div className="dialog-actions">
            <button className="button" onClick={() => setLinkOpen(false)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={!linkTarget}
              onClick={() => {
                if (linkTarget)
                  setContent(
                    (previous) =>
                      `${previous}\n[${linkTarget.title.replace(/[\[\]\\]/g, '')}](/n/${linkTarget.id})\n`,
                  );
                setLinkOpen(false);
              }}
            >
              插入链接
            </button>
          </div>
        </Modal>
      )}
      {question.dialog}
    </div>
  );
}

function HistoryDialog({
  note,
  onClose,
  onRestore,
  onImage,
  onNavigate,
  onPreviewFile,
}: {
  note: NoteDetail;
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
  onImage: (src: string, alt: string) => void;
  onNavigate: (id: string) => void;
  onPreviewFile: (file: FileInfo) => void;
}) {
  const [versions, setVersions] = useState<VersionInfo[]>([]),
    [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{ content: string; attachments: FileInfo[] } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [headings, setHeadings] = useState<Heading[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    api<{ versions: VersionInfo[] }>(`/api/nodes/${note.id}/versions`)
      .then((data) => {
        if (live) {
          setVersions(data.versions);
          setSelected(data.versions[0]?.id || '');
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [note.id]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setPreview(null);
    api<{ content: string; attachments: FileInfo[] }>(`/api/nodes/${note.id}/versions/${selected}`)
      .then((data) => {
        if (live) setPreview(data);
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [selected, note.id]);
  const onHeadings = useCallback((value: Heading[]) => setHeadings(value), []);
  return (
    <Modal
      title="版本历史"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <p className="dialog-copy">保留当前版本与最近 5 个历史版本。</p>
      <div className="history-layout">
        <div className="version-list">
          {versions.map((version) => (
            <button
              key={version.id}
              className={selected === version.id ? 'selected' : ''}
              onClick={() => setSelected(version.id)}
            >
              <strong>{version.current ? '当前版本' : `版本 ${version.sequence}`}</strong>
              <time>{formatDate(version.created_at)}</time>
            </button>
          ))}
        </div>
        <div className="version-preview" ref={previewRef}>
          {preview ? (
            <>
              {note.kind === 'markdown' ? (
                <>
                  <div className="history-toc">
                    {headings.map((h) => (
                      <button
                        className="text-button"
                        key={h.id}
                        onClick={() =>
                          previewRef.current
                            ?.querySelector(`#${h.id}`)
                            ?.scrollIntoView({ block: 'start' })
                        }
                      >
                        {h.title}
                      </button>
                    ))}
                  </div>
                  <MarkdownView
                    content={preview.content}
                    onImage={onImage}
                    onNavigate={(target) => {
                      onClose();
                      onNavigate(target);
                    }}
                    onHeadings={onHeadings}
                  />
                </>
              ) : (
                <pre className="plain-text">{preview.content}</pre>
              )}
              <Attachments files={preview.attachments} onPreview={onPreviewFile} />
            </>
          ) : (
            <Spinner />
          )}
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" onClick={onClose} disabled={busy}>
          关闭
        </button>
        <button
          className="button primary"
          disabled={busy || !selected || !!versions.find((v) => v.id === selected)?.current}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onRestore(selected);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在恢复…' : '恢复此版本'}
        </button>
      </div>
    </Modal>
  );
}
