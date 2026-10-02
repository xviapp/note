import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Modal } from './Primitives';
import { NodePicker } from './Tree';
import { importShare, type IncomingShare } from '../shared-import';
import { useOffline } from '../connectivity';
import type { NoteNode } from '../../shared/types';

export function ShareImport({ onImported }: { onImported: (nodes: NoteNode[]) => void }) {
  const [share, setShare] = useState<IncomingShare | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const offline = useOffline();
  const load = async () => {
    const { device } = await import('../mobile');
    const result = await device.getPendingShare();
    setShare(result.share);
    setMessage('');
    setParent(null);
    if (result.share) {
      setTitle(
        (
          result.share.title ||
          result.share.files[0]?.name ||
          result.share.text?.split('\n')[0] ||
          '分享内容'
        ).slice(0, 200),
      );
      setText(result.share.text || '');
    }
  };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const refresh = () => {
      if (!share) void load().catch(() => {});
    };
    refresh();
    window.addEventListener('note:share', refresh);
    return () => window.removeEventListener('note:share', refresh);
  }, [share?.id]);
  const discard = async () => {
    if (busy || !share) return;
    const { device } = await import('../mobile');
    await device.discardShare({ id: share.id });
    await load();
  };
  if (!share) return null;
  return (
    <Modal
      title="保存到页间"
      onClose={() => {
        void discard();
      }}
    >
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || offline || share.error) return;
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
              <ul>
                {share.files.map((file) => (
                  <li key={file.id}>{file.name}</li>
                ))}
              </ul>
            )}
            {!!share.text && (
              <label>
                文字或链接
                <textarea
                  value={text}
                  disabled={busy}
                  rows={4}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            )}
            <fieldset disabled={busy}>
              <legend>保存位置</legend>
              <NodePicker value={parent} parentsOnly onSelect={(id) => setParent(id)} />
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
          <button
            className="button primary"
            disabled={busy || offline || !!share.error || (!text.trim() && !share.files.length)}
          >
            {busy ? '正在保存…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
