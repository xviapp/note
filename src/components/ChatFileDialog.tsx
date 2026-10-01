import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { CHAT_PDF_PAGE_LIMIT, parsePageRange, pageLabel } from '../../shared/chat-files';
import { AI_IMAGE_TOKENS, estimateTextTokens } from '../../shared/ai-context';
import { fileUrl } from '../api';
import {
  prepareBasicFile,
  sourceDescription,
  type AttachmentSource,
  type PreparedChatFile,
} from '../chat-files';
import { Modal, Spinner } from './Primitives';
import { paperParts, type PaperPart } from '../paper';

export function ChatFileDialog({
  source,
  onPrepared,
  onClose,
}: {
  source: AttachmentSource;
  onPrepared: (file: PreparedChatFile) => void;
  onClose: () => void;
}) {
  const [prepared, setPrepared] = useState<PreparedChatFile | null>(null),
    [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [range, setRange] = useState(''),
    [mode, setMode] = useState<'auto' | 'images'>('auto');
  const [progress, setProgress] = useState('');
  const [parts, setParts] = useState<PaperPart[]>([]),
    [partId, setPartId] = useState('');
  const abort = useRef<AbortController | null>(null);
  const meta = useRef<ReturnType<typeof sourceDescription> | null>(null);
  const estimatedTokens = useMemo(
    () =>
      prepared ? estimateTextTokens(prepared.text) + prepared.images.length * AI_IMAGE_TOKENS : 0,
    [prepared],
  );
  useEffect(() => {
    let task: PDFDocumentLoadingTask | undefined;
    const controller = new AbortController();
    abort.current = controller;
    const load = async () => {
      try {
        const description = sourceDescription(source);
        meta.current = description;
        if (source.type === 'note' && source.note.arxiv_id) {
          const choices = paperParts(source.note);
          setParts(choices);
          setPartId('all');
          setPrepared({
            ...description,
            id: crypto.randomUUID(),
            text: choices[0].text,
            images: [],
          });
        } else if (description.kind === 'pdf') {
          const { openPdf } = await import('../pdf-document');
          const input =
            source.type === 'local'
              ? new Uint8Array(await source.file.arrayBuffer())
              : fileUrl(description.sourceId!);
          controller.signal.throwIfAborted();
          task = openPdf(input);
          const document = await task.promise;
          controller.signal.throwIfAborted();
          setPdf(document);
          setRange(
            document.numPages === 1 ? '1' : `1-${Math.min(document.numPages, CHAT_PDF_PAGE_LIMIT)}`,
          );
        } else {
          const result = await prepareBasicFile(source, controller.signal);
          if (!controller.signal.aborted) setPrepared(result);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error && e.name === 'PasswordException'
              ? '此 PDF 有密码保护，请先解密后再附上。'
              : e instanceof Error
                ? e.message
                : '文件读取失败。',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      void task?.destroy().catch(() => {});
    };
  }, [source]);
  const close = () => {
    abort.current?.abort();
    onClose();
  };
  const attach = () => {
    if (!prepared) return;
    try {
      onPrepared(prepared);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法附上文件。');
    }
  };
  const prepare = async () => {
    setError('');
    if (!pdf) {
      if (prepared) onPrepared(prepared);
      return;
    }
    setBusy(true);
    try {
      const pages = parsePageRange(range, pdf.numPages);
      const { preparePdf } = await import('../pdf-attachment');
      const content = await preparePdf(pdf, pages, mode, abort.current!.signal, (page, done) =>
        setProgress(`正在处理第 ${page} 页 · ${done}/${pages.length}`),
      );
      const result = { ...meta.current!, ...content, id: crypto.randomUUID() };
      setPrepared(result);
    } catch (e) {
      if (!abort.current?.signal.aborted)
        setError(e instanceof Error ? e.message : 'PDF 处理失败，请缩小页码范围后重试。');
    } finally {
      if (!abort.current?.signal.aborted) setBusy(false);
    }
  };
  return (
    <Modal title="附上文件" onClose={close} className="chat-file-modal">
      {loading ? (
        <Spinner label="正在读取文件…" />
      ) : (
        <>
          <p className="chat-file-name">{meta.current?.name}</p>
          {parts.length > 0 && (
            <div className="form-stack">
              <label>
                论文范围
                <select
                  value={partId}
                  onChange={(event) => {
                    setPartId(event.target.value);
                    const part = parts.find((value) => value.id === event.target.value);
                    setPrepared(
                      part
                        ? {
                            ...meta.current!,
                            name: `${meta.current!.name}${part.id === 'all' ? '' : ` · ${part.title}`}`.slice(
                              0,
                              200,
                            ),
                            id: crypto.randomUUID(),
                            text: part.text,
                            images: [],
                          }
                        : null,
                    );
                  }}
                >
                  <option value="">选择全文或章节</option>
                  {parts.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.title} · {part.text.length.toLocaleString()} 字符
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-hint">公式以 LaTeX 附上。图片请框选截图，或引用图注提问。</p>
            </div>
          )}
          {pdf && (
            <div className="form-stack">
              <label>
                页码范围
                <input
                  value={range}
                  disabled={busy}
                  inputMode="text"
                  placeholder="1-5,8,10-12"
                  onChange={(e) => {
                    setRange(e.target.value);
                    setPrepared(null);
                  }}
                />
              </label>
              <span className="field-hint">共 {pdf.numPages} 页，可填 1-5,8,10-12。</span>
              <label>
                PDF 处理方式
                <select
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    setMode(e.target.value as 'auto' | 'images');
                    setPrepared(null);
                  }}
                >
                  <option value="auto">文字优先</option>
                  <option value="images">整页图片</option>
                </select>
              </label>
              <p className="field-hint">
                文字优先会把无法提取文字的页转为图片。图表、公式或复杂排版可选整页图片；一次最多 6
                张。
              </p>
            </div>
          )}
          {prepared && (
            <div className="chat-file-preview">
              <p className="field-hint">
                {prepared.pages ? `第 ${pageLabel(prepared.pages)} 页 · ` : ''}
                {prepared.text.length.toLocaleString()} 字符
                {prepared.images.length ? ` · ${prepared.images.length} 张图片` : ''}
                {` · 约 ${estimatedTokens.toLocaleString()} tokens`}
              </p>
              {prepared.text && (
                <details>
                  <summary>查看将发送的文字</summary>
                  <pre>{prepared.text}</pre>
                </details>
              )}
              <div className="chat-file-thumbnails">
                {prepared.images.map((image, index) => (
                  <figure key={index}>
                    <img
                      src={image.data}
                      alt={image.page ? `第 ${image.page} 页预览` : '文件图片预览'}
                    />
                    {image.page && <figcaption>第 {image.page} 页</figcaption>}
                  </figure>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="field-hint" role="status">
          {progress || '正在处理…'}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" onClick={close}>
          取消
        </button>
        {prepared ? (
          <button className="button primary" onClick={attach}>
            附到对话
          </button>
        ) : (
          <button
            className="button primary"
            disabled={loading || busy || !pdf}
            onClick={() => void prepare()}
          >
            {busy ? '处理中…' : '处理所选页面'}
          </button>
        )}
      </div>
    </Modal>
  );
}
