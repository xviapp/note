import { api, ApiError } from './api';
import type { ArxivImportProgress, NoteNode } from '../shared/types';

// Papers with many images import over several requests; the server returns
// signed progress until the note is created. `resume` holds the last
// continuation, so a retry after a failed step picks up where it stopped.
export async function importPaper(
  request: { title: string; parentId: string | null; url: string },
  key: string,
  resume: { current: string | null },
  onProgress: (progress: ArxivImportProgress) => void,
): Promise<NoteNode> {
  let result = resume.current
    ? null
    : await api<NoteNode | ArxivImportProgress>('/api/import/arxiv', 'POST', request, key);
  for (;;) {
    if (result && !('continuation' in result)) return result;
    if (result) {
      resume.current = result.continuation;
      onProgress(result);
    }
    try {
      result = await api<NoteNode | ArxivImportProgress>('/api/import/arxiv/continue', 'POST', {
        continuation: resume.current,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) resume.current = null;
      throw e;
    }
  }
}
