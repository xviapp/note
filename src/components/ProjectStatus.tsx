import { useRef, useState } from 'react';
import { api, ApiError, lockNote, unlockNote } from '../api';
import { PROJECT_STATUSES, type ProjectContext } from '../../shared/projects';
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
  const pending = useRef<{ status: string; revision: number; key: string } | null>(null);
  const states = PROJECT_STATUSES[project.category];
  const status = note.metadata_status ?? '';
  if (project.category === 'note') return null;
  const change = async (next: string) => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); onBusy(true); setError('');
    if (pending.current?.status !== next || pending.current.revision !== note.revision)
      pending.current = { status: next, revision: note.revision, key: crypto.randomUUID() };
    try {
      await unlockNote(note.id);
      await api(`/api/nodes/${note.id}/project-status`, 'PUT', {
        projectId: project.id, category: project.category, status: next, revision: note.revision,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      }, pending.current.key);
      pending.current = null;
      onSaved();
    } catch (reason) {
      setError((reason as Error).message);
      if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') {
        pending.current = null;
        onRefresh();
      }
    }
    finally { lockNote(note.id); running.current = false; setBusy(false); onBusy(false); }
  };
  return (
    <div className="project-entry-status">
      <label>状态<select aria-label="条目状态" value={Object.hasOwn(states, status) ? status : ''}
        disabled={disabled || busy} onChange={(event) => void change(event.target.value)}>
        {!Object.hasOwn(states, status) && <option value="" disabled>{status ? `待调整：${status}` : '未设置'}</option>}
        {Object.entries(states).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}
