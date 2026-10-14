import { useState } from 'react';
import { useSentHistory } from '../sent-history';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useOutbox, type OutboxGroup, type OutboxItem } from '../outbox';
import { Spinner, type Confirm } from './Primitives';

const time = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 设置 → 待发送: what was saved on this device but has not reached the server,
// from every outbox (今日记 for a locked journal, 随手记, Android's 随手记 window).
export function OutboxSettings({ confirm, onNavigate, history = false }: { confirm: Confirm; onNavigate: (id: string) => void; history?: boolean }) {
  const { groups, refresh } = useOutbox();
  const sent = useSentHistory();
  const [busy, setBusy] = useState('');
  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await task();
    } finally {
      setBusy('');
      await refresh();
    }
  };
  const remove = async (group: OutboxGroup, item: OutboxItem) => {
    if (!(await confirm('删除这条内容？', '它还没传到服务器，删除后找不回来。', '删除', true)))
      return;
    await run(`${group.source.key}:${item.id}`, () => group.source.remove(item.id));
  };
  if (history) return (
    <section className="settings-section outbox-settings">
      <p className="field-hint">本机最近 30 天的发送记录，最多保留 500 条。</p>
      {!sent.length ? <p className="outbox-empty">暂无发送记录</p> : (
        <section className="outbox-group" aria-label="发送历史">
          <ul>
            {sent.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.summary}</strong>
                  <small>{item.detail} · {time(item.sentAt)} 已发送</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
  if (!groups) return <Spinner />;
  const filled = groups.filter((group) => group.items.length);
  return (
    <section className="settings-section outbox-settings">
      <p className="field-hint">
        这些内容还没传到服务器，联网后会自动发送。
      </p>
      {!filled.length && <p className="outbox-empty">没有待发送的内容。</p>}
      {filled.map((group) => (
        <section className="outbox-group" key={group.source.key} aria-label={group.source.label}>
          <header>
            <h3>
              {group.source.label}
              <span className="outbox-count">{group.items.length}</span>
            </h3>
            <button className="button compact" disabled={!!busy} onClick={() => void run(group.source.key, () => group.source.retry())}>
              <RotateCcw size={14} />
              {busy === group.source.key ? '正在发送…' : '重试'}
            </button>
          </header>
          <ul>
            {group.items.map((item) => (
              <li key={item.id} className={item.failed ? 'is-failed' : ''}>
                <div>
                  <strong>{item.summary}</strong>
                  <small>{[item.detail, time(item.createdAt)].filter(Boolean).join(' · ')}</small>
                  <small className="outbox-status" role={item.failed ? 'alert' : undefined}>{item.status}</small>
                </div>
                <div className="outbox-actions">
                  {item.open && (
                    <button className="button compact" onClick={() => onNavigate(item.open!.id)}>
                      {item.open.label}
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`删除 ${item.summary}`}
                    title="删除"
                    disabled={!!busy}
                    onClick={() => void remove(group, item)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
