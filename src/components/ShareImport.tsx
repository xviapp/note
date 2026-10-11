import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Modal } from './Primitives';
import { NodePicker } from './Tree';
import {
  importShare,
  incomingShareTitle,
  incomingShareFilePath,
  type IncomingShare,
} from '../shared-import';
import { useOffline } from '../connectivity';
import type { NoteNode } from '../../shared/types';
import { useShareDestination } from '../use-share-destination';

import { addClip } from '../clips';

export function ShareImport({
  onImported,
  onClipped,
}: {
  onImported: (nodes: NoteNode[]) => void;
  onClipped: () => void;
}) {
  const [share, setShare] = useState<IncomingShare | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const loading = useRef(false);
  // A share that arrives while one load is reading the inbox is read right after.
  const missed = useRef(false);
  const operating = useRef(false);
  const offline = useOffline();
  const { destination, parent, error: destinationError, retry: retryDestination, select: selectDestination } =
    useShareDestination(share?.id ?? null, !offline);
  const load = async (): Promise<void> => {
    if (loading.current) {
      missed.current = true;
      return;
    }
    loading.current = true;
    missed.current = false;
    let found = false;
    try {
      const { device } = await import('../mobile');
      const result = await device.getPendingShare();
      found = !!result.share;
      setShare(result.share);
      setMessage('');

      if (result.share) {
        setTitle(incomingShareTitle(result.share));
        setText(result.share.text || '');
      }
    } finally {
      loading.current = false;
    }
    // With a share already open, the next one waits until this one is saved or cancelled.
    if (missed.current && !found) return load();
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const refresh = () => {
      if (!share) void load().catch(() => {});
    };
    refresh();
    window.addEventListener('note:share', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('note:share', refresh);
      window.removeEventListener('focus', refresh);
    };
    // Keyed by the share's id, which also decides whether refresh() loads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [share?.id]);
  const discard = async () => {
    if (operating.current || !share) return;
    operating.current = true;
    setBusy(true);
    try {
      const { device } = await import('../mobile');
      await device.discardShare({ id: share.id });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法取消，请重试。');
    } finally {
      operating.current = false;
      setBusy(false);
    }
  };
  if (!share) return null;
  return (
    <Modal
      title="保存到页间"
      className="share-import-modal"
      onClose={() => {
        void discard();
      }}
    >
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (operating.current || offline || share.error || !destination) return;
          operating.current = true;
          setBusy(true);
          setMessage('');
          try {
            const nodes = await importShare(share, { title, text, parent }, setMessage);
            const { device } = await import('../mobile');
            await device.discardShare({ id: share.id });
            onImported(nodes);
            await load();
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            operating.current = false;
            setBusy(false);
          }
        }}
      >
        {share.error ? (
          <p role="alert" className="inline-error">
            {share.error}
          </p>
        ) : (
          <>
            <label>
              标题
              <input
                value={title}
                required
                maxLength={200}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            {share.files.length > 0 && (
              <ul className="share-import-files">
                {share.files.map((file) => (
                  <ShareFilePreview key={file.id} share={share} file={file} />
                ))}
              </ul>
            )}
            {(!!share.text || !share.files.length) && (
              <label>
                正文
                <textarea
                  aria-label="正文"
                  value={text}
                  disabled={busy}
                  rows={8}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            )}
            <fieldset disabled={busy}>
              <legend>保存位置</legend>
              {destination ? (
                <>
                  <p className="destination-summary">保存到：{destination.title}</p>
                  <NodePicker
                    value={parent}
                    parentsOnly
                    initialPath={destination.path}
                    onSelect={selectDestination}
                  />
                </>
              ) : (
                !offline && <p role="status">{destinationError || '正在读取默认保存目录…'}</p>
              )}
              {destinationError && !offline && (
                <button
                  type="button"
                  className="text-button"
                  onClick={retryDestination}
                >
                  重新加载保存目录
                </button>
              )}
            </fieldset>
          </>
        )}
        {offline && <p role="status">联网后可以保存，分享内容已暂存到本机。</p>}
        {message && <p role="status">{message}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              void discard();
            }}
          >
            取消
          </button>
          {/* Plain text can be kept as a clip instead, offline too. */}
          {!share.error && !share.files.length && (
            <button
              type="button"
              className="button"
              disabled={busy || !text.trim()}
              onClick={async () => {
                if (operating.current) return;
                operating.current = true;
                setBusy(true);
                setMessage('');
                try {
                  await addClip(text);
                  const { device } = await import('../mobile');
                  await device.discardShare({ id: share.id });
                  onClipped();
                  await load();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  operating.current = false;
                  setBusy(false);
                }
              }}
            >
              存入随手记
            </button>
          )}
          <button
            className="button primary"
            disabled={
              busy ||
              offline ||
              !destination ||
              !!share.error ||
              !title.trim() ||
              (!text.trim() && !share.files.length)
            }
          >
            {busy ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ShareFilePreview({
  share,
  file,
}: {
  share: IncomingShare;
  file: IncomingShare['files'][number];
}) {
  const [failed, setFailed] = useState(false);
  let path = '';
  try {
    path = incomingShareFilePath(share, file);
  } catch {
    /* Import will report the invalid payload before saving. */
  }
  const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mime);
  return (
    <li>
      {path && image && !failed && (
        <img src={path} alt={file.name} onError={() => setFailed(true)} />
      )}
      <span>{file.name}</span>
      {failed && <span className="field-hint">无法预览，保存时会重新读取图片。</span>}
    </li>
  );
}
