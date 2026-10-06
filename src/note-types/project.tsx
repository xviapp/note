import { variantOf } from '../../shared/types';
import { ProjectPanel, ReferencePanel } from '../components/ProjectPanel';
import type { TypeContext, TypeView } from './view';

// A project: its todo, issue and note overview instead of a plain list. Its
// items tell 青藜 about the project's open work (see worker/assistant-context.ts).
export function useProjectView(ctx: TypeContext): TypeView | null {
  const { note } = ctx;
  if (!note) return null;
  const variant = variantOf(note);
  if (variant === 'project')
    return {
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
    return { assistant: { context: <span>已带上：所在项目的未完成待办与未关闭问题</span> } };
  return null;
}
