import { AI_PROMPT_LIMIT, GLOBAL_ASSISTANT_ID } from '../../shared/assistant';
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Camera,
  Check,
  CirclePlay,
  Copy,
  FilePlus2,
  FileText,
  MessageSquareQuote,
  Paperclip,
  Quote,
  RefreshCw,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { QingliIcon } from './QingliIcon';
import type { NoteDetail } from '../../shared/types';
import { CHAT_FILE_LIMIT, pageLabel } from '../../shared/chat-files';
import { fileUrl } from '../api';
import { CachedImage } from './CachedImage';
import { useAssistantConversation } from './useAssistantConversation';
import { captureReading } from '../capture';
import { validatePreparedFiles, type AttachmentSource } from '../chat-files';
import { ChatFileDialog } from './ChatFileDialog';
import { AssistantWindow, type AssistantMode } from './AssistantWindow';
import { MarkdownView } from './LazyMarkdown';
import { ScreenshotCrop } from './ScreenshotCrop';
import { ActivityDots, Spinner, useQuestion } from './Primitives';

export interface AssistantHandle {
  addQuote: (text: string) => string | undefined;
}

interface Props {
  actionsRef: RefObject<AssistantHandle | null>;
  node?: NoteDetail;
  global?: boolean;
  showLauncher?: boolean;
  onGlobal?: () => void;
  visible: boolean;
  enabled: boolean;
  mode: AssistantMode;
  onModeChange: (mode: AssistantMode) => void;
  selection: string;
  readingRoot: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onOpen: () => void;
  onChanged: () => void;
  onSettings: () => void;
  onNavigate: (id: string) => void;
  onImage: (src: string, alt: string) => void;
  // How many highlights and notes the file has, to offer sending them along.
  annotationCount?: number;
  // A book page's discussion: the conversation is the discussion note's thread,
  // titled after it, while "attach current file" offers the page itself.
  title?: string;
  fileNode?: NoteDetail;
  // What the conversation carries along, with an action beside it.
  context?: ReactNode;
  // A reply finished (the page's discussion list counts replies).
  onReplied?: () => void;
  headerActions?: ReactNode;
  // Sent once the conversation has loaded (a question asked from the page).
  initialPrompt?: { content: string; quote?: string };
  // A passage chosen on the page, quoted in the next question.
  initialQuote?: string;
  // A discussion not created yet: the first question creates it instead of
  // being sent here.
  onDraftSend?: (content: string, quote: string) => void;
}
export function AssistantPanel(props: Props) {
  const { node, visible } = props;
  const scopeId = props.global ? GLOBAL_ASSISTANT_ID : node!.id;
  const [capturing, setCapturing] = useState(false),
    [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null),
    [copied, setCopied] = useState(''),
    [fileSource, setFileSource] = useState<AttachmentSource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true),
    bottom = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const conversation = useAssistantConversation({
    ...props,
    scopeId,
    onSend: () => { follow.current = true; },
  });
  const {
    messages, nextBefore, settings, loading, sending, remoteBusy, uploading,
    error, setError, contextNotice, exporting, load, send, save, clear, cancel,
  } = conversation;
  const { prompt, setPrompt, quote, setQuote, image, setImage, withNotes, setWithNotes, files, setFiles } = conversation.composer;
  const question = useQuestion();
  const addQuote = (text: string) => {
    const error = conversation.addQuote(text);
    if (error) return error;
    // On phones the keyboard would cover the sheet; a tap on the field starts typing.
    if (!matchMedia('(pointer: coarse)').matches)
      requestAnimationFrame(() => promptInput.current?.focus({ preventScroll: true }));
  };
  useImperativeHandle(props.actionsRef, () => ({ addQuote }));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (visible && follow.current) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, visible, props.mode]);

  const capture = async () => {
    setCapturing(true);
    setError('');
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const root = props.readingRoot.current?.querySelector<HTMLElement>(
        '.pdf-scroll, .note-scroll',
      );
      if (!root) throw new Error('阅读区尚未加载，请稍后截图。');
      const result = await captureReading(root);
      if (mounted.current) setCanvas(result);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '截图失败，请重试。');
    } finally {
      if (mounted.current) {
        setCapturing(false);
      }
    }
  };
  return (
    <>
      <AssistantWindow
        title={props.global ? '全局对话' : (props.title ?? node!.title)}
        showLauncher={props.showLauncher}
        label={props.global ? '全局青藜' : '青藜'}
        visible={visible}
        hidden={!props.enabled || capturing}
        busy={sending || remoteBusy}
        mode={props.mode}
        onModeChange={props.onModeChange}
        readingRoot={props.readingRoot}
        onOpen={props.onOpen}
        onClose={props.onClose}
        actions={
          <>
            {props.headerActions}
            {props.onGlobal && (
              <button className="text-button" onClick={props.onGlobal}>
                全局对话
              </button>
            )}
            {props.global && node && (
              <button className="text-button" onClick={props.onClose}>
                文件对话
              </button>
            )}
            <button
              className="icon-button"
              aria-label="刷新会话"
              disabled={sending || loading}
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="清空会话"
              disabled={sending || remoteBusy || !messages.length}
              onClick={async () => {
                if (
                  !(await question.confirm(
                    props.global ? '清空全局会话？' : '清空这个文件的会话？',
                    '会话、截图和会话附件将被清理，已保存的笔记会保留。',
                    '清空会话',
                    true,
                  ))
                )
                  return;
                await clear();
              }}
            >
              <Trash2 size={16} />
            </button>
          </>
        }
      >
        {/* An empty conversation carries the set-up guide itself. */}
        {settings && !settings.configured && messages.length > 0 && (
          <div className="assistant-config">
            <span>先配置 DeepSeek API Key</span>
            <button className="text-button" onClick={props.onSettings}>
              打开设置
            </button>
          </div>
        )}
        {props.context && <div className="assistant-context">{props.context}</div>}
        <div
          className="assistant-messages"
          data-selection-owner={scopeId}
          ref={list}
          onScroll={() => {
            const el = list.current!;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
        >
          {nextBefore && (
            <button
              className="text-button older-messages"
              onClick={() => {
                follow.current = false;
                void load(nextBefore);
              }}
            >
              查看更早的消息
            </button>
          )}
          {loading ? (
            <Spinner label="正在读取会话…" />
          ) : !messages.length ? (
            <div className="assistant-empty">
              <QingliIcon size={36} />
              {settings && !settings.configured ? (
                <>
                  <p>配置 DeepSeek API Key 后，就可以向青藜提问。</p>
                  <button className="button primary compact" onClick={props.onSettings}>
                    打开设置
                  </button>
                </>
              ) : (
                <p>附上文件、选中文字或截图，开始提问。</p>
              )}
            </div>
          ) : null}
          {messages.map((message) => (
            <article className={`chat-message chat-${message.role}`} key={message.id}>
              <div className="chat-role">{message.role === 'user' ? '你' : '青藜'}</div>
              {message.quote && (
                <details className="chat-quote">
                  <summary>引用文字</summary>
                  <blockquote>{message.quote}</blockquote>
                </details>
              )}
              {message.annotations && (
                <details className="chat-quote">
                  <summary>我的批注</summary>
                  <blockquote>{message.annotations}</blockquote>
                </details>
              )}
              {message.image && (
                <button
                  className="chat-image"
                  aria-label="查看会话截图"
                  onClick={() => props.onImage(fileUrl(message.image!.id), '会话截图')}
                >
                  <CachedImage
                    src={fileUrl(message.image.id)}
                    alt="发送给青藜的截图"
                    loading="lazy"
                  />
                </button>
              )}
              {message.files?.map((file, index) => (
                <details className="chat-file-card" key={index}>
                  <summary>
                    {file.name}
                    <small>
                      {file.pages
                        ? `第 ${pageLabel(file.pages)} 页 · ${file.mode === 'images' ? '整页图片' : '文字优先'} · `
                        : ''}
                      {file.text.length.toLocaleString()} 字符
                      {file.images.length ? ` · ${file.images.length} 张图片` : ''}
                    </small>
                  </summary>
                  {file.text && <pre>{file.text}</pre>}
                  {file.images.map((image, imageIndex) => (
                    <button
                      className="chat-image"
                      key={imageIndex}
                      aria-label={
                        image.page ? `查看 ${file.name} 第 ${image.page} 页` : `查看 ${file.name}`
                      }
                      onClick={() =>
                        props.onImage(
                          fileUrl(image.file.id),
                          image.page ? `${file.name} · 第 ${image.page} 页` : file.name,
                        )
                      }
                    >
                      <CachedImage
                        src={fileUrl(image.file.id)}
                        alt={image.page ? `第 ${image.page} 页` : file.name}
                        loading="lazy"
                      />
                    </button>
                  ))}
                  {file.source && (
                    <a className="text-button" href={fileUrl(file.source.id, true)}>
                      下载原文件
                    </a>
                  )}
                </details>
              ))}
              {message.role === 'user' ? (
                <p className="chat-user-content">{message.content}</p>
              ) : message.content ? (
                <MarkdownView
                  content={message.content}
                  safeImages
                  onNavigate={props.onNavigate}
                  onImage={props.onImage}
                />
              ) : message.status === 'pending' ? (
                <ActivityDots />
              ) : null}
              {message.error && <p className="chat-error">{message.error}</p>}
              {message.role === 'assistant' && !!message.content && (
                <div className="chat-message-actions">
                  {message.status !== 'pending' && (
                    <button
                      className="text-button"
                      disabled={!!exporting}
                      onClick={() => void save(message)}
                    >
                      {message.exportedNodeId ? <Check size={14} /> : <FilePlus2 size={14} />}
                      {exporting === message.id
                        ? '保存中…'
                        : message.exportedNodeId
                          ? props.global
                            ? '打开笔记'
                            : '打开子笔记'
                          : props.global
                            ? '保存为笔记'
                            : '保存为子笔记'}
                    </button>
                  )}
                  {message.status === 'interrupted' && (
                    <button
                      className="text-button"
                      disabled={sending || remoteBusy || !settings?.configured}
                      onClick={() => void send(message.id)}
                    >
                      <CirclePlay size={14} />
                      继续生成
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={copied === message.id ? '已复制回复' : '复制回复'}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(message.content);
                        setCopied(message.id);
                      } catch {
                        setError('复制失败，可选中回复手动复制。');
                      }
                    }}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )}
            </article>
          ))}
          <div ref={bottom} />
        </div>
        <form
          className="assistant-compose"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {quote && (
            <div className="context-quote">
              <Quote size={14} />
              <span>{quote}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="移除引用"
                disabled={sending}
                onClick={() => setQuote('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {withNotes && !!props.annotationCount && (
            <div className="context-quote">
              <MessageSquareQuote size={14} />
              <span>附上这份文件的 {props.annotationCount} 条高亮与批注</span>
              <button
                type="button"
                className="icon-button"
                aria-label="不附上批注"
                disabled={sending}
                onClick={() => setWithNotes(false)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {image && (
            <div className="context-image">
              <button type="button" onClick={() => props.onImage(image, '待发送截图')}>
                <img src={image} alt="待发送截图" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="移除截图"
                disabled={sending}
                onClick={() => setImage('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {!!files.length && (
            <div className="context-files" aria-label="待发送文件">
              {files.map((file) => (
                <div className="context-file" key={file.id}>
                  <Paperclip size={14} />
                  <div>
                    <strong>{file.name}</strong>
                    <small>
                      {file.pages
                        ? `第 ${pageLabel(file.pages)} 页 · ${file.mode === 'images' ? '整页图片' : '文字优先'}`
                        : `${file.text.length.toLocaleString()} 字符`}
                      {file.images.length ? ` · ${file.images.length} 张图片` : ''}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`移除附件 ${file.name}`}
                    disabled={sending}
                    onClick={() => setFiles((old) => old.filter((item) => item.id !== file.id))}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="context-actions">
            {node && (props.fileNode ?? node).kind !== 'folder' && (
              <button
                type="button"
                className="text-button"
                disabled={sending || files.length >= CHAT_FILE_LIMIT}
                onClick={() => setFileSource({ type: 'note', note: props.fileNode ?? node })}
              >
                <FileText size={15} />
                <span className="action-label">附上当前文件</span>
              </button>
            )}
            <button
              type="button"
              className="text-button"
              disabled={sending || files.length >= CHAT_FILE_LIMIT}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={15} />
              <span className="action-label">另选文件</span>
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              aria-label={props.global ? '选择全局聊天附件' : '选择聊天附件'}
              accept=".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.gif,.webp,.avif,.svg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) setFileSource({ type: 'local', file });
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="text-button"
              disabled={!props.selection || sending}
              title={props.selection ? undefined : '先在正文中选中文字'}
              onClick={() => {
                const error = addQuote(props.selection);
                if (error) setError(error);
              }}
            >
              <Quote size={15} />
              <span className="action-label">
                {props.selection ? '引用选中文字' : '选中正文后可引用'}
              </span>
            </button>
            {!!props.annotationCount && !withNotes && (
              <button
                type="button"
                className="text-button"
                disabled={sending}
                onClick={() => setWithNotes(true)}
              >
                <MessageSquareQuote size={15} />
                <span className="action-label">附上我的批注</span>
              </button>
            )}
            <button
              type="button"
              className="text-button"
              disabled={!node || sending || capturing}
              onClick={() => void capture()}
            >
              <Camera size={15} />
              <span className="action-label">框选截图</span>
            </button>
          </div>
          <textarea
            ref={promptInput}
            aria-label="发给青藜的问题"
            rows={3}
            maxLength={AI_PROMPT_LIMIT}
            value={prompt}
            placeholder={settings && !settings.configured ? '配置 API Key 后即可提问' : '问问青藜…'}
            disabled={sending || (!!settings && !settings.configured)}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229 &&
                !matchMedia('(pointer: coarse)').matches
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {contextNotice && (
            <p className="field-hint" role="status">
              {contextNotice}
            </p>
          )}
          <div className="assistant-send">
            <span className={uploading || (remoteBusy && !sending) ? undefined : 'send-provider'}>
              {uploading
                ? '正在上传附件…'
                : remoteBusy && !sending
                  ? '其他页面正在生成回复…'
                  : 'DeepSeek'}
            </span>
            {sending ? (
              <button type="button" className="button" onClick={cancel}>
                <Square size={13} />
                {uploading ? '取消发送' : '停止生成'}
              </button>
            ) : (
              <button
                className="button primary"
                disabled={!prompt.trim() || !settings?.configured || remoteBusy || loading}
              >
                <Send size={14} />
                发送
              </button>
            )}
          </div>
        </form>
      </AssistantWindow>
      {fileSource && (
        <ChatFileDialog
          source={fileSource}
          onClose={() => setFileSource(null)}
          onPrepared={(file) => {
            const next = [...files, file];
            validatePreparedFiles(next);
            setFiles(next);
            setFileSource(null);
            setError('');
          }}
        />
      )}
      {capturing && (
        <div className="capture-loading" role="status">
          正在准备截图…
        </div>
      )}
      {canvas && (
        <ScreenshotCrop
          canvas={canvas}
          onDone={(value) => {
            setImage(value);
            setCanvas(null);
          }}
          onClose={() => setCanvas(null)}
        />
      )}
      {question.dialog}
    </>
  );
}
