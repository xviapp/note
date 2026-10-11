import { useEffect, useState, type FormEvent } from 'react';
import type { Clip } from '../../shared/clips';
import type { NoteNode } from '../../shared/types';
import { api, fileUrl, scopeOf, upload } from '../api';
import { clipFile } from '../clip-image';
import { NodePicker } from './Tree';
import { markdownLink } from './LinkDialog';
import { useShareDestination } from '../use-share-destination';
import { useOffline } from '../connectivity';

// Moves a clip into the library as a Markdown note, then removes the clip.
export function ClipToNote({
  item,
  onCancel,
  onDone,
}: {
  item: Clip;
  onCancel: () => void;
  onDone: (node: NoteNode) => void;
}) {
  const firstLine = item.text.split('\n').find((line) => line.trim())?.trim() ?? '';
  const [title, setTitle] = useState(
    firstLine.slice(0, 60) || `随手记 ${new Date(item.created_at).toLocaleDateString('zh-CN')}`,
  );

  const offline = useOffline();
  const { destination, parent, error: destinationError, retry: retryDestination, select: selectDestination } =
    useShareDestination(item.id, !offline);
  const [plainTarget, setPlainTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // An encrypted clip put in a plain place is no longer encrypted.
  useEffect(() => {
    let live = true;
    if (!item.key_id) return;
    void scopeOf(parent)
      .then((key) => live && setPlainTarget(!key))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item.key_id, parent]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || offline || !destination || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const parts: string[] = [];
      const attachments: string[] = [];
      // The image is uploaded again into the note's place, sealed as it requires.
      if (item.file) {
        const file = await upload(await clipFile(item.file), parent);
        attachments.push(file.id);
        parts.push(`![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})`);
      }
      if (item.text) parts.push(item.text);
      if (item.source_id && item.source_title)
        parts.push(`来源：${markdownLink({ id: item.source_id, title: item.source_title })}`);
      const node = await api<NoteNode>('/api/nodes', 'POST', {
        kind: 'markdown',
        title: title.trim(),
        parentId: parent,
        content: `${parts.join('\n\n')}\n`,
        attachments,
      });
      await api(`/api/clips/${item.id}`, 'DELETE').catch(() => {});
      onDone(node);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form-stack clips-convert" onSubmit={(event) => void submit(event)}>
      <p>转为 Markdown 笔记后，这条随手记会被移除。</p>
      <label>
        标题
        <input
          value={title}
          maxLength={200}
          required
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
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
          <p role="status">{offline ? '联网后可读取保存目录。' : destinationError || '正在读取默认保存目录…'}</p>
        )}
        {destinationError && !offline && (
          <button type="button" className="text-button" onClick={retryDestination}>重新加载保存目录</button>
        )}
      </fieldset>
      {plainTarget && (
        <p className="field-hint">这条随手记已加密，目标位置未加密，转为笔记后将以明文保存。</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          返回
        </button>
        <button className="button primary" disabled={busy || offline || !destination || !title.trim()}>
          {busy ? '正在保存…' : '转为笔记'}
        </button>
      </div>
    </form>
  );
}
