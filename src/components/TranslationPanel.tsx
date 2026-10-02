import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, History, Locate, Quote, RotateCw, Square, Trash2 } from 'lucide-react';
import {
  TRANSLATION_LANGUAGES,
  sourceLabel,
  type SourceLocation,
  type Translation,
  type TranslationHistory,
  type TranslationLanguage,
  type TranslationSummary,
} from '../../shared/translation';
import { api, formatDate } from '../api';
import {
  preferredLanguage,
  rememberLanguage,
  translateText,
  type TranslationLaunch,
} from '../translation';
import { MarkdownView } from './MarkdownView';
import { Spinner, useQuestion } from './Primitives';
import { TranslationWindow } from './TranslationWindow';

export function TranslationPanel(props: {
  nodeId: string;
  launch: TranslationLaunch;
  onClose: () => void;
  onChanged: () => void;
  onQuote: (text: string) => string | undefined;
  onLocate: (location: SourceLocation) => string | undefined;
  onNavigate: (id: string) => void;
  onImage: (src: string, alt: string) => void;
}) {
  const { nodeId, launch } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const [source, setSource] = useState(''),
    [content, setContent] = useState('');
  const [location, setLocation] = useState<SourceLocation | null>(null);
  const [language, setLanguage] = useState(preferredLanguage);
  const [saved, setSaved] = useState<Translation | null>(null);
  const [busy, setBusy] = useState<'translation' | 'loading' | null>(null);
  const [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [history, setHistory] = useState(false);
  const [expanded, setExpanded] = useState(!launch.source);
  const [records, setRecords] = useState<TranslationSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const operation = useRef<AbortController | null>(null);
  const question = useQuestion();
  const begin = () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError('');
    setStatus('');
    return controller;
  };
  const show = (translation: Translation) => {
    setSource(translation.source);
    setContent(translation.content);
    setLocation(translation.location);
    setLanguage(translation.targetLanguage);
    setSaved(translation);
  };
  const run = async (
    text: string,
    target: TranslationLanguage,
    anchor: SourceLocation | null,
    refresh = false,
  ) => {
    const controller = begin();
    setHistory(false);
    setSource(text);
    setLanguage(target);
    setLocation(anchor);
    setContent('');
    setSaved(null);
    setBusy('translation');
    try {
      await translateText(nodeId, text, target, refresh, anchor, controller.signal, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'delta') setContent((value) => value + event.content);
        else if (event.type === 'error') setError(event.error);
        else {
          show(event.translation);
          setStatus(event.cached ? '已保存 · 来自翻译记录' : '已保存');
          callbacks.current.onChanged();
        }
      });
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };
  const loadHistory = async (offset = 0) => {
    const controller = begin();
    setHistory(true);
    setExpanded(true);
    setBusy('loading');
    if (!offset) {
      setRecords([]);
      setNextOffset(null);
    }
    try {
      const result = await api<TranslationHistory>(
        `/api/nodes/${nodeId}/translations?offset=${offset}`,
      );
      if (controller.signal.aborted) return;
      setRecords((previous) =>
        offset
          ? [
              ...previous,
              ...result.translations.filter((item) => !previous.some((old) => old.id === item.id)),
            ]
          : result.translations,
      );
      setNextOffset(result.nextOffset);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };
  const openRecord = async (id: string) => {
    const controller = begin();
    setBusy('loading');
    try {
      const result = await api<Translation>(`/api/nodes/${nodeId}/translations/${id}`);
      if (controller.signal.aborted) return;
      show(result);
      setHistory(false);
      setStatus('已保存 · 来自翻译记录');
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };
  useEffect(() => {
    setExpanded(!launch.source);
    if (launch.source) void run(launch.source, preferredLanguage(), launch.location || null);
    else void loadHistory();
    return () => operation.current?.abort();
  }, [nodeId, launch]);

  return (
    <TranslationWindow
      launch={launch}
      onClose={props.onClose}
      expanded={expanded || history}
      onExpandedChange={setExpanded}
      canCollapse={!history}
    >
      {(expanded || history) && (
        <div className="translation-controls">
          {history ? (
            <>
              {source && (
                <button
                  className="icon-button"
                  aria-label="返回译文"
                  onClick={() => {
                    operation.current?.abort();
                    setBusy(null);
                    setError('');
                    setHistory(false);
                    setStatus(saved ? '已保存' : '');
                  }}
                >
                  <ArrowLeft size={16} />
                </button>
              )}
              <strong>翻译记录</strong>
              <span className="toolbar-spacer" />
              <button
                className="icon-button"
                aria-label="刷新翻译记录"
                disabled={!!busy}
                onClick={() => void loadHistory()}
              >
                <RotateCw size={16} />
              </button>
            </>
          ) : (
            <>
              <label className="translation-language">
                译为
                <select
                  aria-label="翻译目标语言"
                  value={language}
                  onChange={(event) => {
                    const target = event.target.value as TranslationLanguage;
                    rememberLanguage(target);
                    void run(source, target, location);
                  }}
                >
                  {Object.entries(TRANSLATION_LANGUAGES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="toolbar-spacer" />
              <button className="text-button" onClick={() => void loadHistory()}>
                <History size={15} />
                翻译记录
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="translation-error" role="alert">
          {error}
        </p>
      )}
      {history ? (
        <div className="translation-history" aria-label="本文件的翻译记录">
          {!records.length && !busy && !error && (
            <p className="translation-empty">还没有翻译记录</p>
          )}
          {records.map((record) => (
            <div className="translation-record" key={record.id}>
              <button
                className="translation-record-open"
                disabled={!!busy}
                onClick={() => void openRecord(record.id)}
              >
                <span>{record.excerpt}</span>
                <small>
                  {TRANSLATION_LANGUAGES[record.targetLanguage]}
                  {record.locationLabel && ` · ${record.locationLabel}`} ·{' '}
                  {formatDate(record.savedAt)}
                </small>
              </button>
              <button
                className="icon-button"
                aria-label={`删除翻译：${record.excerpt}`}
                disabled={!!busy}
                onClick={async () => {
                  if (
                    !(await question.confirm(
                      '删除这条翻译？',
                      '原文件不受影响；再次翻译将重新请求 AI。',
                      '删除翻译',
                      true,
                    ))
                  )
                    return;
                  const controller = begin();
                  setBusy('loading');
                  try {
                    await api(`/api/nodes/${nodeId}/translations/${record.id}`, 'DELETE');
                    if (controller.signal.aborted) return;
                    if (saved?.id === record.id) setSaved(null);
                    callbacks.current.onChanged();
                    void loadHistory();
                  } catch (e) {
                    if (!controller.signal.aborted) {
                      setError((e as Error).message);
                      setBusy(null);
                    }
                  }
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {busy === 'loading' && <Spinner />}
          {nextOffset !== null && (
            <button
              className="button compact translation-more"
              disabled={!!busy}
              onClick={() => void loadHistory(nextOffset)}
            >
              更多记录
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="translation-result" aria-label="译文" tabIndex={0}>
            {busy === 'translation' && !content && <Spinner label="正在翻译…" />}
            {content && (
              <MarkdownView
                content={content}
                safeImages
                onNavigate={props.onNavigate}
                onImage={props.onImage}
              />
            )}
            {expanded && (
              <details className="translation-original" key={`${source}:${language}`}>
                <summary>查看原文{location ? ` · ${sourceLabel(location)}` : ''}</summary>
                <pre>{source}</pre>
              </details>
            )}
          </div>
          {expanded && (
            <>
              <div className="translation-state" role="status">
                <span>
                  {busy === 'translation'
                    ? '翻译中…'
                    : status || (content && !saved ? '未保存' : '')}
                </span>
                {location && (
                  <button
                    className="text-button"
                    onClick={() => {
                      const failure = props.onLocate(location);
                      if (failure) setError(failure);
                      else props.onClose();
                    }}
                    title={location.kind === 'pdf' ? location.fileName : undefined}
                  >
                    <Locate size={14} />
                    回到原文
                  </button>
                )}
              </div>
              <footer className="translation-actions">
                <button
                  className="button compact"
                  disabled={!content}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(content);
                      setStatus('已复制译文');
                    } catch {
                      setError('复制失败，请手动选择译文复制。');
                    }
                  }}
                >
                  <Copy size={14} />
                  复制
                </button>
                <button
                  className="button compact"
                  disabled={!content || busy === 'translation'}
                  onClick={() => {
                    const failure = props.onQuote(
                      `原文：\n${source}\n\n译文（${TRANSLATION_LANGUAGES[language]}）：\n${content}`,
                    );
                    if (failure) setError(failure);
                    else props.onClose();
                  }}
                >
                  <Quote size={14} />
                  问青藜
                </button>
                <span className="toolbar-spacer" />
                {busy === 'translation' ? (
                  <button
                    className="button compact"
                    onClick={() => {
                      operation.current?.abort();
                      setBusy(null);
                      setStatus('');
                      setError('已停止翻译。未完成的译文不会保存。');
                    }}
                  >
                    <Square size={13} />
                    停止
                  </button>
                ) : (
                  <button
                    className="button compact"
                    disabled={!source || !!busy}
                    onClick={() => void run(source, language, location, true)}
                  >
                    <RotateCw size={14} />
                    {saved ? '重译' : '重试'}
                  </button>
                )}
              </footer>
            </>
          )}
        </>
      )}
      {question.dialog}
    </TranslationWindow>
  );
}
