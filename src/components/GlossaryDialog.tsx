import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  GLOSSARY_LIMIT,
  TERM_CHARS,
  type PaperBlockSource,
  type PaperTerm,
} from '../../shared/paper-translation';
import { Modal } from './Primitives';

// Edits the terms the translation must use. After saving, paragraphs already
// translated with a changed term can be translated again, and only those.
export function GlossaryDialog({
  glossary,
  busy,
  onSave,
  affected,
  onRetranslate,
  onClose,
}: {
  glossary: PaperTerm[] | null;
  busy: boolean;
  onSave: (terms: PaperTerm[]) => Promise<PaperTerm[]>;
  affected: (changedSources: string[]) => PaperBlockSource[];
  onRetranslate: (blocks: PaperBlockSource[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PaperTerm[]>(() => glossary ?? []),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [stale, setStale] = useState<PaperBlockSource[] | null>(null);
  const update = (index: number, field: keyof PaperTerm, value: string) =>
    setRows((list) => list.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const before = new Map(
        (glossary ?? []).map((term) => [term.source.toLowerCase(), term.target]),
      );
      const saved = await onSave(rows.filter((row) => row.source.trim() || row.target.trim()));
      const after = new Map(saved.map((term) => [term.source.toLowerCase(), term.target]));
      // Added, removed or re-rendered terms.
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (source) => before.get(source) !== after.get(source),
      );
      const list = changed.length ? affected(changed) : [];
      if (list.length) setStale(list);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (stale)
    return (
      <Modal title="术语表已保存" onClose={onClose}>
        <p className="glossary-note">
          已翻译的内容中有 {stale.length} 段用到了改动的术语，要按新术语表重新翻译这些段落吗？
        </p>
        <div className="dialog-actions">
          <button className="button" onClick={onClose}>
            以后再说
          </button>
          <button className="button primary" disabled={busy} onClick={() => onRetranslate(stale)}>
            重新翻译 {stale.length} 段
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal title="术语表" className="glossary-modal" onClose={onClose}>
      <p className="glossary-note">
        {glossary === null
          ? '首次翻译时会根据标题、摘要和章节标题自动生成，也可以先手动添加。'
          : '翻译时每一段都按这里的译名处理。'}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <ul className="glossary-rows">
        {rows.map((row, index) => (
          <li key={index}>
            <input
              aria-label={`术语 ${index + 1}`}
              placeholder="原文术语"
              maxLength={TERM_CHARS}
              value={row.source}
              onChange={(event) => update(index, 'source', event.target.value)}
            />
            <span aria-hidden="true">→</span>
            <input
              aria-label={`译名 ${index + 1}`}
              placeholder="译名"
              maxLength={TERM_CHARS}
              value={row.target}
              onChange={(event) => update(index, 'target', event.target.value)}
            />
            <button
              className="icon-button"
              aria-label={`删除术语 ${row.source || index + 1}`}
              onClick={() => setRows((list) => list.filter((_, i) => i !== index))}
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      <button
        className="button compact"
        disabled={rows.length >= GLOSSARY_LIMIT}
        onClick={() => setRows((list) => [...list, { source: '', target: '' }])}
      >
        <Plus size={15} />
        添加术语
      </button>
      <div className="dialog-actions">
        <button className="button" onClick={onClose} disabled={saving}>
          取消
        </button>
        <button className="button primary" onClick={() => void save()} disabled={saving || busy}>
          {saving ? '正在保存…' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
