import type { NoteNode } from '../shared/types';
import {
  isJournalDate,
  isJournalMonth,
  monthFolder,
  RECENT_ENTRIES,
  TEMPLATES_FOLDER,
  weekday,
  yearFolder,
  type JournalEntry,
  type JournalMonth,
  type JournalTemplate,
} from '../shared/journals';
import { AppError, idValue } from './http';
import { createNode, getNode, priorOperation } from './library';
import type { Env } from './types';

// A new journal: its row and the folder its templates go in.
export function insertJournal(env: Env, id: string, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare('INSERT INTO journals(node_id) VALUES(?)').bind(id),
    env.DB.prepare(
      `INSERT INTO nodes(id,parent_id,kind,title,position,revision,created_at,updated_at)
       VALUES(?,?,'folder',?,0,1,?,?)`,
    ).bind(crypto.randomUUID(), id, TEMPLATES_FOLDER, now, now),
  ];
}
async function requireJournal(env: Env, id: string) {
  const node = await getNode(env, id);
  if (node.variant !== 'journal') throw new AppError(404, '这个目录不是日记本。');
  return node;
}
export async function journalEntryOf(env: Env, id: string) {
  return env.DB.prepare('SELECT date,journal_id FROM journal_entries WHERE node_id=?')
    .bind(id)
    .first<{ date: string; journal_id: string }>();
}
// Live notes below the journal; an entry moved out of it no longer counts.
const BELOW = `WITH RECURSIVE below(id,depth) AS (
  SELECT id,0 FROM nodes WHERE parent_id=? AND trash_id IS NULL
  UNION ALL SELECT n.id,b.depth+1 FROM nodes n JOIN below b ON n.parent_id=b.id
  WHERE n.trash_id IS NULL AND b.depth<20
)`;
const ENTRY_COLUMNS = `e.node_id id,e.date,n.title,
  CASE WHEN n.metadata_version_id=n.current_version_id THEN n.metadata_excerpt END excerpt
  FROM journal_entries e JOIN nodes n ON n.id=e.node_id JOIN below b ON b.id=n.id`;

export async function journalMonth(env: Env, id: string, url: URL): Promise<JournalMonth> {
  await requireJournal(env, id);
  const month = url.searchParams.get('month') || '';
  if (!isJournalMonth(month)) throw new AppError(400, '月份不正确。');
  const [entries, recent, templates] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `${BELOW} SELECT ${ENTRY_COLUMNS} WHERE e.journal_id=? AND e.date LIKE ? ORDER BY e.date`,
    ).bind(id, id, `${month}-%`),
    env.DB.prepare(
      `${BELOW} SELECT ${ENTRY_COLUMNS} WHERE e.journal_id=? ORDER BY e.date DESC LIMIT ?`,
    ).bind(id, id, RECENT_ENTRIES),
    env.DB.prepare(
      `SELECT t.id,t.title FROM nodes f JOIN nodes t ON t.parent_id=f.id
       WHERE f.parent_id=? AND f.kind='folder' AND f.trash_id IS NULL AND lower(trim(f.title))=?
       AND t.kind='markdown' AND t.trash_id IS NULL ORDER BY t.position,t.id`,
    ).bind(id, TEMPLATES_FOLDER),
  ]);
  return {
    month,
    entries: entries.results as unknown as JournalEntry[],
    recent: recent.results as unknown as JournalEntry[],
    templates: templates.results as unknown as JournalTemplate[],
  };
}

async function existing(env: Env, journal: string, date: string) {
  const row = await env.DB.prepare(
    `${BELOW} SELECT e.node_id,EXISTS(SELECT 1 FROM below b WHERE b.id=e.node_id) live
     FROM journal_entries e WHERE e.journal_id=? AND e.date=?`,
  )
    .bind(journal, journal, date)
    .first<{ node_id: string; live: number }>();
  if (!row) return null;
  if (row.live) return getNode(env, row.node_id);
  // In the trash or moved out: the day is free for a new entry.
  await env.DB.prepare('DELETE FROM journal_entries WHERE node_id=?').bind(row.node_id).run();
  return null;
}
async function folder(env: Env, parent: string, title: string, key: string): Promise<string> {
  const found = await env.DB.prepare(
    `SELECT id FROM nodes WHERE parent_id=? AND kind='folder' AND trash_id IS NULL AND title=?
     AND NOT EXISTS(SELECT 1 FROM node_references r WHERE r.node_id=nodes.id) ORDER BY position,id LIMIT 1`,
  )
    .bind(parent, title)
    .first<{ id: string }>();
  if (found) return found.id;
  return (await createNode(env, { kind: 'folder', title, parentId: parent }, key)).id;
}
// The day's entry: the one already written, or a new note filed in its year
// and month folders. The device sends the body (from a template, sealed in
// an encrypted journal); a repeated request returns the same note.
export async function journalEntry(
  env: Env,
  id: string,
  data: Record<string, unknown>,
  key: string,
): Promise<{ node: NoteNode; created: boolean }> {
  const previous = await priorOperation(env, key, 'create');
  if (previous) return { node: previous, created: true };
  await requireJournal(env, id);
  const date = data.date;
  if (!isJournalDate(date)) throw new AppError(400, '日期不正确。');
  // The device's own day may be ahead of UTC.
  if (date > new Date(Date.now() + 14 * 3600_000).toISOString().slice(0, 10))
    throw new AppError(400, '不能为将来的日期写日记。');
  const found = await existing(env, id, date);
  if (found) return { node: found, created: false };
  const year = await folder(env, id, yearFolder(date), `${key}-year`);
  const month = await folder(env, year, monthFolder(date), `${key}-month`);
  const { content, bodyBlobId, attachments, metadata } = data;
  try {
    const node = await createNode(
      env,
      {
        kind: 'markdown',
        title: date,
        parentId: month,
        ...(bodyBlobId === undefined ? { content: content ?? '' } : { bodyBlobId, metadata }),
        attachments: attachments ?? [],
      },
      key,
      undefined,
      (node, now) => [
        env.DB.prepare(
          'INSERT INTO journal_entries(node_id,journal_id,date,created_at) VALUES(?,?,?,?)',
        ).bind(node, id, date, now),
      ],
    );
    return { node, created: true };
  } catch (error) {
    // Written meanwhile on another device.
    const raced = await existing(env, id, date);
    if (raced) return { node: raced, created: false };
    throw error;
  }
}

// What 青藜 is told about a journal entry.
export async function journalPrompt(env: Env, node: NoteNode): Promise<string> {
  const entry = await journalEntryOf(env, node.id);
  if (!entry) return '';
  const journal = await env.DB.prepare('SELECT title FROM nodes WHERE id=?')
    .bind(idValue(entry.journal_id))
    .first<{ title: string }>();
  return `\n\n当前文件是日记本「${journal?.title ?? ''}」中 ${entry.date}（${weekday(entry.date)}）的日记。`;
}
