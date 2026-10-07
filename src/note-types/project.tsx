import { variantOf } from '../../shared/types';
import { ProjectPanel, ReferencePanel } from '../components/ProjectPanel';
import type { TypeContext, TypeView } from './view';
import { QuickAppend } from '../components/QuickAppend';
import { ProjectStatus } from '../components/ProjectStatus';

// A project: its todo, issue and note overview instead of a plain list. Its
// items tell 青藜 about the project's open work (see worker/assistant-context.ts).
export function useProjectView(ctx: TypeContext): TypeView | null {
  const { note } = ctx;
  if (!note) return null;
  const variant = variantOf(note);
  if (variant === 'project')
    return {
      menu: <button onClick={ctx.refresh}>刷新项目</button>,
      children: !ctx.editing && (
        <ProjectPanel
          id={note.id}
          refresh={ctx.refreshKey}
          offline={ctx.offline}
          onChanged={ctx.onChanged}
          onNavigate={ctx.onNavigate}
        />
      ),
    };
  if (variant === 'reference')
    return { children: !ctx.editing && <ReferencePanel note={note} onOpen={ctx.onOpen} /> };
  if (note.project_category && variant === 'markdown')
    return {
      records: note.project_category === 'note' ? undefined : note.project_category,
      headingActions: !ctx.editing && ctx.projectContext && (
        <ProjectStatus note={note} project={ctx.projectContext} disabled={ctx.offline || ctx.appending}
          onBusy={ctx.setAppending} onSaved={ctx.onAppended} onRefresh={ctx.refresh} />
      ),
      footer: !ctx.editing && <QuickAppend id={note.id} keyId={note.key_id} kind={note.project_category} disabled={ctx.offline} blocked={ctx.appending}
        label={note.project_category === 'issue' ? '补充讨论' : note.project_category === 'todo' ? '记录进展' : '追加笔记'}
        placeholder={note.project_category === 'issue' ? '补充分析、讨论或解决结果…' : note.project_category === 'todo' ? '记录进展、遇到的阻碍或完成结果…' : '补充想法或笔记内容…'}
        onBusy={ctx.setAppending} onSaved={ctx.onAppended} />,
      assistant: { context: <span>当前项目条目：{note.project_category === 'issue' ? '问题' : note.project_category === 'todo' ? '待办' : '笔记'}</span> },
    };
  return null;
}
