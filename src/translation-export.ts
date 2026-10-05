import { api } from './api';
import type { NoteDetail } from '../shared/types';
import {
  TRANSLATION_LANGUAGES,
  type Translation,
  type TranslationHistory,
} from '../shared/translation';
import { saveChildNote } from './child-note';

// Where a record sits in its file, for reading order: PDF page and height,
// or the offset in the text. Records without a place come last, newest first.
const order = (translation: Translation): [number, number, number] => {
  const location = translation.location;
  if (!location) return [2, 0, -translation.savedAt];
  if (location.kind === 'pdf')
    return [0, location.page, Math.min(...location.rects.map((rect) => rect.y), 1)];
  return [1, location.start, 0];
};
const quote = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

// Saves every selection translation of a note as one Markdown child note,
// source quoted above each translation, in reading order.
export async function exportTranslations(nodeId: string) {
  const note = await api<NoteDetail>(`/api/nodes/${nodeId}`);
  const ids: string[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page: TranslationHistory = await api<TranslationHistory>(
      `/api/nodes/${nodeId}/translations?offset=${offset}`,
    );
    ids.push(...page.translations.map((record) => record.id));
    offset = page.nextOffset;
  }
  if (!ids.length) throw new Error('还没有翻译记录可以导出。');
  const records: Translation[] = [];
  for (const id of ids)
    records.push(await api<Translation>(`/api/nodes/${nodeId}/translations/${id}`));
  records.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const title = `${note.title}（翻译记录）`;
  const content =
    `> 《${note.title}》的 ${records.length} 条翻译记录，按原文顺序排列。\n\n` +
    records
      .map((record) => {
        const place = record.location?.kind === 'pdf' ? `第 ${record.location.page} 页 · ` : '';
        return `### ${place}${TRANSLATION_LANGUAGES[record.targetLanguage]}\n\n${quote(record.source)}\n\n${record.content.trim()}`;
      })
      .join('\n\n---\n\n') +
    '\n';
  const updated = await saveChildNote(nodeId, title, content);
  return { title, count: records.length, updated };
}
