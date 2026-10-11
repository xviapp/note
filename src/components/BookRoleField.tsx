import { useId, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api';
import { BOOK_ROLE_LIMIT, BOOK_ROLE_PRESETS } from '../../shared/types';

// The book's 青藜 role: pick a reading role, or let 青藜 write a guide for this
// book from its title and author; the text stays editable either way.
export function BookRoleField({
  value,
  onChange,
  title,
  author,
  disabled,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  title: string;
  author: string;
  disabled: boolean;
  rows?: number;
}) {
  const id = useId();
  const [generating, setGenerating] = useState(false),
    [error, setError] = useState('');
  const preset = BOOK_ROLE_PRESETS.find((item) => item.prompt === value)?.id ?? '';
  const generate = async () => {
    setGenerating(true);
    setError('');
    try {
      const result = await api<{ prompt: string }>('/api/books/role-prompt', 'POST', {
        title,
        author,
        role: value,
      });
      onChange(result.prompt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };
  return (
    <div className="book-role-field">
      <label htmlFor={id}>青藜角色</label>
      <div className="book-role-tools">
        <select
          aria-label="阅读角色预设"
          value={preset}
          disabled={disabled || generating}
          onChange={(e) => {
            const picked = BOOK_ROLE_PRESETS.find((item) => item.id === e.target.value);
            if (picked) onChange(picked.prompt);
          }}
        >
          <option value="" disabled>
            选择阅读角色…
          </option>
          {BOOK_ROLE_PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.description}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button compact"
          disabled={disabled || generating || !title.trim()}
          title={title.trim() ? '根据书名、作者和当前角色生成本书阅读指引' : '先填写书名'}
          onClick={() => void generate()}
        >
          <Sparkles size={15} />
          <span>{generating ? '正在生成…' : '让青藜生成'}</span>
        </button>
      </div>
      <textarea
        id={id}
        rows={rows}
        maxLength={BOOK_ROLE_LIMIT}
        value={value}
        placeholder="填写本书的阅读指引"
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || generating}
      />
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : (
        <span className="field-hint">
          用于全书对话。生成会使用 DeepSeek 额度并替换当前内容。
        </span>
      )}
    </div>
  );
}
