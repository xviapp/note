import { lazy, Suspense, useRef, useState } from 'react';
import { api, ApiError, lockNote, unlockNote } from '../api';
import type { NoteDetail, NoteNode } from '../../shared/types';
import { defaultEntry, fillTemplate, localDate, type JournalMonth } from '../../shared/journals';
import { Modal, Spinner, useQuestion } from './Primitives';
import { MarkdownView } from './LazyMarkdown';
import type { EditorHandle } from './Editor';

const Editor = lazy(() => import('./Editor'));
const TOKENS = ['日期', '星期', 'date', 'year', 'month', 'day'];

export function JournalTemplates({ journalId, data, selected, offline, onSelect, onChanged, onClose }: {
  journalId: string;
  data: JournalMonth;
  selected: string;
  offline: boolean;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<{ note: NoteDetail | null; title: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const handle = useRef<EditorHandle | null>(null);
  const running = useRef(false);
  const creation = useRef(crypto.randomUUID());
  const savedRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const renameRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const folderId = useRef(data.templateFolderId);
  const question = useQuestion();
  const dirty = !!draft && (draft.title !== (draft.note?.title ?? '') || draft.content !== (draft.note?.content ?? ''));
  const back = async (close = false) => {
    if (running.current) return;
    if (dirty && !(await question.confirm('放弃模板修改？', '未保存的模板修改将丢失。', '放弃修改', true))) return;
    if (draft?.note) lockNote(draft.note.id);
    setDraft(null);
    setUncertain(false);
    setError('');
    if (close) onClose();
  };
  const edit = async (id: string) => {
    setBusy(true); running.current = true; setError('');
    try {
      const note = await api<NoteDetail>(`/api/nodes/${id}`);
      if (note.locked) throw new Error('请先解锁日记本，再编辑模板。');
      setDraft({ note, title: note.title, content: note.content });
      setPreview(false);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); running.current = false; }
  };
  const save = async () => {
    if (!draft || offline || running.current || !draft.title.trim()) return;
    setBusy(true); running.current = true; setError('');
    try {
      if (!draft.note) {
        if (!folderId.current) {
          const folder = await api<NoteNode>('/api/nodes', 'POST', {
            kind: 'folder', title: 'templates', parentId: journalId,
          }, `${creation.current}:folder`);
          folderId.current = folder.id;
        }
        const node = await api<NoteNode>('/api/nodes', 'POST', {
          kind: 'markdown', title: draft.title.trim(), content: draft.content, parentId: folderId.current,
        }, creation.current);
        onSelect(node.id);
      } else {
        let note = draft.note;
        if (draft.title.trim() !== note.title) {
          const payload = { title: draft.title.trim(), revision: note.revision };
          const fingerprint = JSON.stringify(payload);
          if (renameRequest.current?.fingerprint !== fingerprint)
            renameRequest.current = { fingerprint, key: crypto.randomUUID() };
          const renamed = await api<NoteNode>(`/api/nodes/${note.id}`, 'PATCH', payload, renameRequest.current.key);
          note = { ...note, ...renamed };
          setDraft({ ...draft, note });
        }
        if (draft.content !== note.content) {
          const payload = { content: draft.content, attachments: note.attachments.map((item) => item.id), revision: note.revision };
          const fingerprint = JSON.stringify(payload);
          if (savedRequest.current?.fingerprint !== fingerprint)
            savedRequest.current = { fingerprint, key: crypto.randomUUID() };
          await unlockNote(note.id);
          try { await api(`/api/nodes/${note.id}/content`, 'PUT', payload, savedRequest.current.key); }
          finally { lockNote(note.id); }
        }
      }
      await onChanged();
      setDraft(null);
      setUncertain(false);
    } catch (reason) {
      setError((reason as Error).message);
      setUncertain(reason instanceof ApiError && (reason.status === 0 || reason.status >= 500));
    }
    finally { setBusy(false); running.current = false; }
  };
  const remove = async (id: string, title: string) => {
    running.current = true; setBusy(true); setError('');
    try {
      const { count } = await api<{ count: number }>(`/api/nodes/${id}/delete-preview`);
      if (!(await question.confirm('删除模板？', `「${title}」${count > 1 ? `及其下级共 ${count} 项` : ''}将移到回收站，已写的日记不受影响。`, '删除模板', true))) return;
      await api(`/api/nodes/${id}`, 'DELETE', { count });
      if (selected === id) onSelect('');
      await onChanged();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); running.current = false; }
  };
  return (
    <>
      <Modal title={draft ? draft.note ? '编辑模板' : '新建模板' : '日记模板'} className="journal-templates-modal" onClose={() => void back(true)}>
        {draft ? (
          <div className="form-stack">
            <label>模板名称<input value={draft.title} disabled={busy || uncertain} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <div className="template-tokens">
              <span>插入日期：</span>
              {TOKENS.map((token) => <button key={token} className="text-button" disabled={busy || preview || uncertain} onClick={() => handle.current?.insert(`{{${token}}}`)}>{`{{${token}}}`}</button>)}
            </div>
            <div className="template-editor" inert={busy || uncertain}>
              {preview ? <MarkdownView content={fillTemplate(draft.content, localDate())} onNavigate={() => {}} onImage={() => {}} safeImages /> : (
                <Suspense fallback={<Spinner label="正在打开编辑器…" />}>
                  <Editor value={draft.content} kind="markdown" handleRef={handle}
                    onChange={(content) => setDraft((value) => value && { ...value, content })}
                    onSave={() => void save()} onFiles={() => setError('模板中请使用文字或 Markdown 链接。')} />
                </Suspense>
              )}
            </div>
            <small className="muted">模板只用于之后新建的日记，已有日记不受影响。</small>
            <div className="form-actions">
              <button className="button" disabled={busy} onClick={() => void back()}>返回</button>
              <button className="button" disabled={busy} onClick={() => setPreview((value) => !value)}>{preview ? '继续编辑' : '预览今天'}</button>
              <button className="button primary" disabled={busy || offline || !draft.title.trim()} onClick={() => void save()}>{busy ? '正在保存…' : '保存模板'}</button>
            </div>
            {uncertain && <small className="muted">保存结果尚未确认，请重试保存。</small>}
            {error && draft.note && !uncertain && <button className="text-button" disabled={busy} onClick={async () => {
              if (await question.confirm('重新载入模板？', '当前输入将丢弃，载入最新保存的模板。', '重新载入', true))
                await edit(draft.note!.id);
            }}>重新载入模板</button>}
          </div>
        ) : (
          <div className="form-stack">
            <div className="template-item"><span>仅日期标题</span><button className="text-button" onClick={() => onSelect('')} disabled={!selected}>{!selected ? '已选用' : '选用'}</button></div>
            {data.templates.map((item) => <div key={item.id} className="template-item">
              <strong>{item.title.replace(/\.md$/i, '')}</strong>
              <div>
                <button className="text-button" disabled={busy || selected === item.id} onClick={() => onSelect(item.id)}>{selected === item.id ? '已选用' : '选用'}</button>
                <button className="text-button" disabled={busy || offline} onClick={() => void edit(item.id)}>编辑</button>
                <button className="text-button danger-text" disabled={busy || offline} onClick={() => void remove(item.id, item.title)}>删除</button>
              </div>
            </div>)}
            {!data.templates.length && <p className="muted">创建模板，为每天的日记准备固定内容。</p>}
            <button className="button" disabled={busy || offline} onClick={() => {
              creation.current = crypto.randomUUID(); savedRequest.current = null;
              renameRequest.current = null; setUncertain(false);
              setPreview(false); setError('');
              setDraft({ note: null, title: '', content: defaultEntry(localDate()).replace(/^# .*$/m, '# {{日期}} {{星期}}') });
            }}>新建模板</button>
          </div>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </Modal>
      {question.dialog}
    </>
  );
}
