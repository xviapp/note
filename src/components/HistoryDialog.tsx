import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatDate } from '../api';
import { TEXT_KINDS, type FileInfo, type NoteDetail, type VersionInfo } from '../../shared/types';
import { Modal, Spinner } from './Primitives';
import { MarkdownView } from './LazyMarkdown';
import type { Heading } from './MarkdownView';
import { Attachments } from './Attachments';
import { diffLines } from '../line-diff';

export function HistoryDialog({
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
    [selected, setSelected] = useState(''),
    [mode, setMode] = useState<'preview' | 'diff'>('preview');
  const [preview, setPreview] = useState<{ content: string; attachments: FileInfo[] } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [headings, setHeadings] = useState<Heading[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  const canDiff = TEXT_KINDS.includes(note.kind);
  const diff = useMemo(
    () => (canDiff && mode === 'diff' && preview ? diffLines(preview.content, note.content) : []),
    [canDiff, mode, preview, note.content],
  );
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
      <div className="history-toolbar">
        <p className="dialog-copy">保留当前版本与最近 5 个历史版本。</p>
        {canDiff && (
          <div className="history-mode-tabs" role="group" aria-label="预览方式">
            <button
              type="button"
              aria-pressed={mode === 'preview'}
              className={mode === 'preview' ? 'active' : ''}
              onClick={() => setMode('preview')}
            >
              渲染预览
            </button>
            <button
              type="button"
              aria-pressed={mode === 'diff'}
              className={mode === 'diff' ? 'active' : ''}
              onClick={() => setMode('diff')}
            >
              文本差异
            </button>
          </div>
        )}
      </div>
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
              {canDiff && mode === 'diff' ? (
                preview.content === note.content ? (
                  <p className="diff-empty">与当前版本正文一致。</p>
                ) : (
                  <div className="version-diff" aria-label="版本差异对比">
                    <p className="version-diff-legend">
                      对比所选版本与当前版本：<code>-</code> 为所选版本原有内容，<code>+</code> 为当前版本新增内容。
                    </p>
                    <div className="version-diff-lines">
                      {diff.map((entry, index) =>
                        entry.type === 'skip' ? (
                          <div key={`skip-${index}`} className="diff-line diff-skip">
                            ⋯ 省略 {entry.count} 行相同内容
                          </div>
                        ) : (
                          <div key={index} className={`diff-line diff-${entry.type}`}>
                            <span className="diff-num" aria-hidden="true">
                              {entry.oldNumber ?? ''}
                            </span>
                            <span className="diff-num" aria-hidden="true">
                              {entry.newNumber ?? ''}
                            </span>
                            <span className="diff-sign" aria-hidden="true">
                              {entry.type === 'add' ? '+' : entry.type === 'del' ? '-' : ' '}
                            </span>
                            <span className="diff-text">{entry.text || ' '}</span>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )
              ) : note.kind === 'markdown' ? (
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
