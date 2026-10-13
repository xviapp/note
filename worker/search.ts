import { SEARCH_FIELD } from '../shared/annotations';
import { SEARCH_LIMIT, type NoteNode, type SearchResult } from '../shared/types';
import { KEY_SQL, NODE_COLUMNS, NOT_DISCUSSION } from './library';
import { bodyMatch, EXCERPT_SQL, excerpt } from './note-text';
import type { Env } from './types';

// Title search for quick jumps, then note bodies, then highlights and notes.
// Every space-separated word must appear in the title, the body (unencrypted
// notes, see note-text.ts) or one annotation (case-insensitive for ASCII);
// newest edits come first.
export async function searchNodes(env: Env, url: URL): Promise<{ results: SearchResult[] }> {
  const words = (url.searchParams.get('q') || '')
    .trim()
    .slice(0, 200)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return { results: [] };
  const pattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const body = bodyMatch(words),
    context = EXCERPT_SQL(words[0]);
  const [titles, bodies, annotated] = await env.DB.batch<
    NoteNode & { search_text?: string; excerpt?: string; excerpt_at?: number; body_length?: number }
  >([
    env.DB.prepare(
      `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.trash_id IS NULL AND ${NOT_DISCUSSION('n')} AND ${words
        .map(() => "n.title LIKE ? ESCAPE '\\'")
        .join(' AND ')} ORDER BY n.updated_at DESC,n.id LIMIT ?`,
    ).bind(...words.map(pattern), SEARCH_LIMIT),
    env.DB.prepare(
      `SELECT ${NODE_COLUMNS},${context.sql} FROM ${body.from} JOIN nodes n ON n.id=t.node_id
       WHERE ${body.where.join(' AND ')} AND n.trash_id IS NULL AND ${NOT_DISCUSSION('n')}
         AND t.version_id=n.current_version_id AND ${KEY_SQL('n')} IS NULL
       ORDER BY n.updated_at DESC,n.id LIMIT ?`,
    ).bind(...context.params, ...body.params, SEARCH_LIMIT),
    env.DB.prepare(
      `SELECT ${NODE_COLUMNS},a.search_text FROM annotations a JOIN nodes n ON n.id=a.node_id
       WHERE n.trash_id IS NULL AND ${words
         .map(() => "a.search_text LIKE ? ESCAPE '\\'")
         .join(' AND ')} ORDER BY a.updated_at DESC,n.id LIMIT ?`,
    ).bind(...words.map(pattern), SEARCH_LIMIT),
  ]);
  // The first annotation of each file that holds every word.
  const lower = words.map((word) => word.toLowerCase());
  const hits: (NoteNode & Pick<SearchResult, 'annotation' | 'excerpt'>)[] = [...titles.results];
  // A body match adds its context, or the note when its title did not match.
  const found = new Map(hits.map((node) => [node.id, node]));
  for (const row of bodies.results) {
    const { excerpt: piece = '', excerpt_at: at = 0, body_length: length = 0, ...node } = row;
    const text = excerpt(piece, at, length);
    const known = found.get(node.id);
    if (known) known.excerpt = text;
    else if (hits.length < SEARCH_LIMIT) hits.push({ ...node, excerpt: text });
  }
  for (const row of annotated.results) {
    const { search_text: text = '', ...node } = row;
    const line = text
      .split('\n')
      .find((entry) => lower.every((word) => entry.toLowerCase().includes(word)));
    if (!line || hits.length >= SEARCH_LIMIT) continue;
    const [id, quote = '', note = ''] = line.split(SEARCH_FIELD);
    hits.push({ ...node, annotation: { id, quote, note } });
  }
  if (!hits.length) return { results: [] };
  const ids = [...new Set(hits.map((node) => node.id))];
  // Ancestors of every match in one query, nearest first.
  const ancestors = await env.DB.prepare(
    `WITH RECURSIVE chain(hit,parent_id,title,depth) AS (
      SELECT n.id,n.parent_id,NULL,0 FROM nodes n WHERE n.id IN (${ids.map(() => '?').join(',')})
      UNION ALL SELECT c.hit,p.parent_id,p.title,c.depth+1 FROM chain c JOIN nodes p ON p.id=c.parent_id WHERE c.depth<200
    ) SELECT hit,title FROM chain WHERE depth>0 ORDER BY hit,depth DESC`,
  )
    .bind(...ids)
    .all<{ hit: string; title: string }>();
  const paths = new Map<string, string[]>();
  for (const row of ancestors.results)
    paths.set(row.hit, [...(paths.get(row.hit) ?? []), row.title]);
  return {
    results: hits.map((node) => ({ ...node, path: paths.get(node.id) ?? [] })),
  };
}
