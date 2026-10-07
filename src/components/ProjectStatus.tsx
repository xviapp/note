import { useRef, useState } from 'react';
import { api, ApiError, lockNote, uncertainFailure, unlockNote } from '../api';
import { CONCLUSION_LABELS, FINISHED_STATUSES, PROJECT_STATUSES, type ProjectContext } from '../../shared/projects';
import { Modal } from './Primitives';
import type { NoteDetail } from '../../shared/types';

export function ProjectStatus({ note, project, disabled, onBusy, onSaved, onRefresh }: {
  note: NoteDetail;
  project: ProjectContext;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const pending = useRef<{ status: string; revision: number; conclusion: string; key: string } | null>(null);
  // Finishing asks for an optional conclusion, kept until it is saved.
  const [finishing, setFinishing] = useState(false);
  const [conclusion, setConclusion] = useState('');
  const states = PROJECT_STATUSES[project.category];
  const status = note.metadata_status ?? '';
  if (project.category === 'note') return null;
  const finished = FINISHED_STATUSES[project.category];
  const change = async (next: string, text = '') => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); onBusy(true); setError('');
    try {
      // The server rewrites the current body itself, so the change is based on the
      // latest revision rather than the page's copy, which may lag just after an
      // append. A retry of the same change resends the same request.
      if (pending.current?.status !== next || pending.current.conclusion !== text) {
        const { revision } = await api<NoteDetail>(`/api/nodes/${note.id}`);
        pending.current = { status: next, revision, conclusion: text, key: crypto.randomUUID() };
      }
      await unlockNote(note.id);
      await api(`/api/nodes/${note.id}/project-status`, 'PUT', {
        projectId: project.id, category: project.category, status: next, revision: pending.current.revision,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        ...(text.trim() ? { conclusion: text.trim() } : {}),
      }, pending.current.key);
      pending.current = null;
      if (next === finished) setConclusion('');
      onSaved();
    } catch (reason) {
      setError((reason as Error).message);
      if (!uncertainFailure(reason)) pending.current = null;
      if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') onRefresh();
    }
    finally { lockNote(note.id); running.current = false; setBusy(false); onBusy(false); }
  };
  return (
    <div className="project-entry-status">
      <label>状态<select aria-label="条目状态" value={Object.hasOwn(states, status) ? status : ''}
        disabled={disabled || busy} onChange={(event) => {
          if (event.target.value === finished) setFinishing(true);
          else void change(event.target.value);
        }}>
        {!Object.hasOwn(states, status) && <option value="" disabled>{status ? `待调整：${status}` : '未设置'}</option>}
        {Object.entries(states).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {finishing && (
        <Modal title={project.category === 'issue' ? '关闭问题' : '完成待办'} onClose={() => setFinishing(false)}>
          <form className="form-stack" onSubmit={(event) => {
            event.preventDefault();
            setFinishing(false);
            void change(finished!, conclusion);
          }}>
            <label>
              {CONCLUSION_LABELS[project.category]}（可选）
              <textarea rows={4} value={conclusion} autoFocus maxLength={20_000}
                placeholder={project.category === 'issue' ? '问题如何解决，或为何关闭…' : '完成了什么，留下哪些结果…'}
                onChange={(event) => setConclusion(event.target.value)} />
            </label>
            <span className="field-hint">会和状态变化一起记在正文末尾，留空也可以。</span>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setFinishing(false)}>取消</button>
              <button type="submit" className="button primary">{project.category === 'issue' ? '关闭问题' : '标记完成'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
