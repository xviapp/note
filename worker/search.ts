import { SEARCH_LIMIT, type NoteNode, type SearchResult } from '../shared/types';
import { NODE_COLUMNS } from './library';
import type { Env } from './types';

// Title search for quick jumps. Every space-separated word must appear in the
// title (case-insensitive for ASCII); newest edits come first.
export async function searchNodes(env: Env, url: URL): Promise<{ results: SearchResult[] }> {
  const words = (url.searchParams.get('q') || '')
    .trim()
    .slice(0, 200)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return { results: [] };
  const pattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const matches = await env.DB.prepare(
    `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.trash_id IS NULL AND ${words
      .map(() => "n.title LIKE ? ESCAPE '\\'")
      .join(' AND ')} ORDER BY n.updated_at DESC,n.id LIMIT ?`,
  )
    .bind(...words.map(pattern), SEARCH_LIMIT)
    .all<NoteNode>();
  if (!matches.results.length) return { results: [] };
  // Ancestors of every match in one query, nearest first.
  const ancestors = await env.DB.prepare(
    `WITH RECURSIVE chain(hit,parent_id,title,depth) AS (
      SELECT n.id,n.parent_id,NULL,0 FROM nodes n WHERE n.id IN (${matches.results.map(() => '?').join(',')})
      UNION ALL SELECT c.hit,p.parent_id,p.title,c.depth+1 FROM chain c JOIN nodes p ON p.id=c.parent_id WHERE c.depth<200
    ) SELECT hit,title FROM chain WHERE depth>0 ORDER BY hit,depth DESC`,
  )
    .bind(...matches.results.map((node) => node.id))
    .all<{ hit: string; title: string }>();
  const paths = new Map<string, string[]>();
  for (const row of ancestors.results)
    paths.set(row.hit, [...(paths.get(row.hit) ?? []), row.title]);
  return {
    results: matches.results.map((node) => ({ ...node, path: paths.get(node.id) ?? [] })),
  };
}
