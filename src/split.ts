import { TEXT_KINDS, type NoteNode } from '../shared/types';

// Notes a split view can show: text, papers, PDFs and images.
export const splittable = (node: Pick<NoteNode, 'kind' | 'arxiv_id'>) =>
  !!node.arxiv_id || [...TEXT_KINDS, 'pdf', 'image'].includes(node.kind);
