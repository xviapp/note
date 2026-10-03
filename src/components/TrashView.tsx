import { useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { type TrashBatch } from '../../shared/types';
import { Empty, Spinner } from './Primitives';
import type { Confirm } from './Primitives';

export function TrashView({
  confirm,
  onChanged,
  onError,
}: {
  confirm: Confirm;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [items, setItems] = useState<TrashBatch[] | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ batches: TrashBatch[] }>('/api/trash')
      .then((data) => {
        if (live) setItems(data.batches);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [revision, onError]);
  async function act(batch: TrashBatch, restore: boolean) {
    if (
      !restore &&
      !(await confirm(
        '永久删除这些内容？',
        `「${batch.title}」及其下级笔记，共 ${batch.node_count} 项内容将永久删除，无法恢复。`,
        '永久删除',
        true,
      ))
    )
      return;
    setBusy(batch.id);
    try {
      const result = await api<{ movedToRoot?: boolean }>(
        `/api/trash/${batch.id}${restore ? '/restore' : ''}`,
        restore ? 'POST' : 'DELETE',
        {},
      );
      if (result.movedToRoot)
        onError(new Error('已恢复到根目录：原来的上级目录已不存在或仍在回收站中。'));
      setRevision((r) => r + 1);
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="collection-page">
      <h1>回收站</h1>
      <p className="page-description">
        保留 7 天，恢复时一并还原下级笔记。删除后仍占用空间，清理完成后释放。
      </p>
      {!items ? (
        <Spinner />
      ) : !items.length ? (
        <Empty icon={<Trash2 />} title="回收站为空" />
      ) : (
        <div className="trash-list">
          {items.map((batch) => {
            const expired = batch.expires_at <= Date.now() || batch.purging !== 0;
            return (
              <div className="trash-row" key={batch.id}>
                <Trash2 size={20} />
                <div>
                  <strong>{batch.title}</strong>
                  <small>
                    {batch.node_count} 项内容 ·{' '}
                    {expired
                      ? '等待清理'
                      : `${Math.max(1, Math.ceil((batch.expires_at - Date.now()) / 86400_000))} 天后清理`}
                  </small>
                </div>
                <button
                  className="button"
                  disabled={expired || busy !== null}
                  onClick={() => act(batch, true)}
                >
                  <RotateCcw size={15} />
                  恢复
                </button>
                <button
                  className="icon-button danger-text"
                  aria-label={`永久删除 ${batch.title}`}
                  disabled={busy !== null}
                  onClick={() => act(batch, false)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
