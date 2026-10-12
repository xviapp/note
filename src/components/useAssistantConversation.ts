import { useCallback, useEffect, useRef, useState } from 'react';
import { AI_QUOTE_LIMIT, type AssistantSettings, type ChatHistory, type ChatMessage, type ChatInput } from '../../shared/assistant';
import type { NoteNode } from '../../shared/types';
import { api, cachedApi } from '../api';
import { streamChat } from '../assistant';
import { uploadPreparedFile, validatePreparedFiles, type PreparedChatFile } from '../chat-files';

interface Options {
  scopeId: string;
  visible: boolean;
  initialQuote?: string;
  initialPrompt?: { content: string; quote?: string };
  annotationCount?: number;
  onDraftSend?: (content: string, quote: string) => void;
  onSend: () => void;
  onChanged: () => void;
  onReplied?: () => void;
  onNavigate: (id: string) => void;
}

const RESUMED = 'resumed';
// Long enough for a stream that survived the background to deliver its end.
export const RESUME_CHECK_MS = 3000;

// Own the conversation lifecycle so callers never coordinate request keys,
// uploads or stream cancellation. Only explicit sends can start paid requests.
export function useAssistantConversation(props: Options) {
  const { scopeId, visible } = props;
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [nextBefore, setNextBefore] = useState<number | null>(null);
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [loading, setLoading] = useState(true),
    [sending, setSending] = useState(false),
    [remoteBusy, setRemoteBusy] = useState(false);
  const [prompt, setPrompt] = useState(''),
    [quote, setQuote] = useState(props.initialQuote ?? ''),
    [image, setImage] = useState(''),
    [withNotes, setWithNotes] = useState(false);
  const [error, setError] = useState('');
  const [contextNotice, setContextNotice] = useState('');
  const [exporting, setExporting] = useState('');
  const [files, setFiles] = useState<PreparedChatFile[]>([]),
    [uploading, setUploading] = useState(false);
  const abort = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const requestKey = useRef<{ payload: string; key: string } | null>(null);
  // The server's history has arrived; a cached copy no longer applies.
  const fresh = useRef(false);
  const base = `/api/nodes/${scopeId}/assistant`;
  const draft = !!props.onDraftSend;
  const load = useCallback(
    async (before?: number, quiet = false) => {
      if (draft) {
        setLoading(false);
        return;
      }
      if (!quiet) setError('');
      try {
        const history = await api<ChatHistory>(`${base}${before ? `?before=${before}` : ''}`);
        if (!mounted.current) return;
        if (!before) fresh.current = true;
        setMessages((old) =>
          before
            ? [
                ...history.messages,
                ...old.filter((m) => !history.messages.some((n) => n.id === m.id)),
              ]
            : history.messages.map((message) => {
                const local = old.find((m) => m.id === message.id);
                // Keep received text available to copy if saving failed or the
                // server is still finishing a cancelled request.
                return local?.content && !message.content && message.role === 'assistant'
                  ? { ...message, content: local.content }
                  : message;
              }),
        );
        setNextBefore(history.nextBefore);
        setRemoteBusy(history.busy);
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : '会话加载失败。');
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [base, draft],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!visible || abort.current) return;
    // This device's last copy (the global conversation) shows while the server answers.
    if (!draft && !fresh.current)
      void Promise.all([cachedApi<ChatHistory>(base), cachedApi<AssistantSettings>('/api/ai/settings')]).then(
        ([history, cached]) => {
          if (!mounted.current) return;
          if (cached) setSettings((current) => current ?? cached);
          if (!history || fresh.current) return;
          setMessages(history.messages);
          setNextBefore(history.nextBefore);
          setLoading(false);
        },
      );
    void load();
    api<AssistantSettings>('/api/ai/settings')
      .then((value) => {
        if (mounted.current) setSettings(value);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
  }, [visible, load]);
  // A question asked from the page goes out once the conversation is ready.
  const initialSent = useRef(false);
  useEffect(() => {
    const initial = props.initialPrompt;
    if (!initial || initialSent.current || loading || !settings?.configured || !visible) return;
    initialSent.current = true;
    void send(undefined, initial);
    // send is recreated each render; this runs once the history and settings are in.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialPrompt, loading, settings, visible]);
  useEffect(() => {
    if (!remoteBusy || sending || !visible) return;
    const timer = setInterval(() => void load(undefined, true), 5000);
    return () => clearInterval(timer);
  }, [remoteBusy, sending, visible, load]);
  const send = async (continueFrom?: string, initial?: { content: string; quote?: string }) => {
    const text = initial ? initial.content : prompt.trim(),
      quoted = initial ? (initial.quote ?? '') : quote;
    if (abort.current || sending || remoteBusy || (!continueFrom && !text) || !settings?.configured)
      return;
    if (props.onDraftSend && !continueFrom) {
      props.onDraftSend(text, quoted);
      return;
    }
    setSending(true);
    setError('');
    setContextNotice('');
    props.onSend();
    const controller = new AbortController();
    abort.current = controller;
    let replyId = '',
      started = false;
    // A phone may freeze or drop the stream while the app is in the background.
    // Back in front, ask the server: once it has finished the reply, stop
    // waiting and show what it saved.
    let away = false,
      check: ReturnType<typeof setTimeout> | undefined;
    const watch = (event: Event) => {
      if (event.type === 'pagehide' || document.visibilityState === 'hidden') {
        away = true;
        return;
      }
      if (!away || !replyId) return;
      away = false;
      clearTimeout(check);
      check = setTimeout(async () => {
        const history = await api<ChatHistory>(base).catch(() => null);
        const reply = history?.messages.find((m) => m.id === replyId);
        if (abort.current === controller && reply && reply.status !== 'pending')
          controller.abort(RESUMED);
      }, RESUME_CHECK_MS);
    };
    window.addEventListener('pagehide', watch);
    window.addEventListener('focus', watch);
    document.addEventListener('visibilitychange', watch);
    try {
      let data: ChatInput = { content: '继续生成', continueFrom };
      if (!continueFrom) {
        validatePreparedFiles(files);
        setUploading(files.length > 0);
        const attached = [];
        for (const file of files)
          attached.push(await uploadPreparedFile(scopeId, file, controller.signal));
        data = {
          content: text,
          ...(quoted ? { quote: quoted } : {}),
          ...(image ? { image } : {}),
          ...(withNotes && props.annotationCount ? { annotations: true } : {}),
          ...(attached.length ? { files: attached } : {}),
        };
      }
      controller.signal.throwIfAborted();
      setUploading(false);
      const payload = JSON.stringify(data);
      if (requestKey.current?.payload !== payload)
        requestKey.current = { payload, key: crypto.randomUUID() };
      await streamChat(scopeId, data, requestKey.current.key, controller.signal, (event) => {
        if (!mounted.current) return;
        if (event.type === 'start') {
          setContextNotice(
            event.context?.omittedHistory ? '本次已省略较早的对话，完整历史仍保留。' : '',
          );
          started = true;
          replyId = event.assistant.id;
          if (!continueFrom) {
            setPrompt('');
            setQuote('');
            setImage('');
            setWithNotes(false);
            setFiles([]);
          }
          setMessages((old) => [
            ...old.filter((m) => m.id !== event.user.id && m.id !== event.assistant.id),
            event.user,
            event.assistant,
          ]);
        } else if (event.type === 'delta') {
          setMessages((old) =>
            old.map((m) => (m.id === replyId ? { ...m, content: m.content + event.content } : m)),
          );
        } else {
          if (event.message)
            setMessages((old) => old.map((m) => (m.id === event.message!.id ? event.message! : m)));
          if (event.type === 'error') setError(event.error);
          else props.onReplied?.();
          requestKey.current = null;
        }
      });
    } catch (e) {
      // A reply the server already finished: the history reload below shows it.
      if (controller.signal.reason === RESUMED) requestKey.current = null;
      else if (mounted.current) {
        const message = controller.signal.aborted
          ? started
            ? '已停止生成。'
            : '已取消发送。'
          : e instanceof Error
            ? e.message
            : '发送失败，请刷新会话查看结果。';
        setError(message);
        if (started)
          setMessages((old) =>
            old.map((m) =>
              m.id === replyId ? { ...m, status: 'interrupted', error: message } : m,
            ),
          );
      }
    } finally {
      clearTimeout(check);
      window.removeEventListener('pagehide', watch);
      window.removeEventListener('focus', watch);
      document.removeEventListener('visibilitychange', watch);
      if (mounted.current) {
        setSending(false);
        setUploading(false);
        if (started) void load(undefined, true);
        props.onChanged();
      }
      abort.current = null;
    }
  };
  const save = async (message: ChatMessage) => {
    if (message.exportedNodeId) {
      props.onNavigate(message.exportedNodeId);
      return;
    }
    setExporting(message.id);
    setError('');
    try {
      const saved = await api<NoteNode>(`${base}/${message.id}/export`, 'POST', {});
      setMessages((old) =>
        old.map((m) => (m.id === message.id ? { ...m, exportedNodeId: saved.id } : m)),
      );
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败。');
    } finally {
      setExporting('');
    }
  };
  const addQuote = (text: string) => {
    if (sending || abort.current) return '正在回复，请结束后再加入引用。';
    if (text.length > AI_QUOTE_LIMIT)
      return `引用最多 ${AI_QUOTE_LIMIT.toLocaleString()} 个字符，请缩小选择范围。`;
    setQuote(text);
    setError('');
  };
  const clear = async () => {
    try {
      await api(base, 'DELETE');
      requestKey.current = null;
      setContextNotice('');
      await load();
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '清空失败。');
    }
  };

  return {
    messages, nextBefore, settings, loading, sending, remoteBusy, uploading,
    error, setError, contextNotice, exporting,
    composer: { prompt, setPrompt, quote, setQuote, image, setImage, withNotes, setWithNotes, files, setFiles },
    addQuote, load, send, save, clear,
    cancel: () => abort.current?.abort(),
  };
}
