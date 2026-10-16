import { SEARCH_FIELD } from '../shared/annotations';
import { SEARCH_LIMIT, type NoteNode, type SearchResult } from '../shared/types';
import { compareSearch, searchTypes, type SearchSort, type SearchType } from '../shared/search';
import { getNode, KEY_SQL, NODE_COLUMNS, NOT_DISCUSSION, VARIANT_SQL } from './library';
import { AppError } from './http';
import { bodyMatch, EXCERPT_SQL, excerpt } from './note-text';
import type { Env } from './types';

// Filter and rank each source before its limit, then merge the candidates.
// A title match must not crowd newer body matches out of the updated view.
export async function searchNodes(env: Env, url: URL): Promise<{ results: SearchResult[] }> {
  const words = (url.searchParams.get('q') || '').trim().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 8);
  const type = (url.searchParams.get('type') || 'all') as SearchType;
  const sort = (url.searchParams.get('sort') || 'relevance') as SearchSort;
  if (!Object.hasOwn(searchTypes, type) || !['relevance', 'updated'].includes(sort))
    throw new AppError(400, '搜索筛选条件不正确。');
  const parent = url.searchParams.get('parent');
  if (parent) await getNode(env, parent);
  if (!words.length) return { results: [] };
  const prefix = parent ? `WITH RECURSIVE scope(id,depth) AS (
    SELECT id,0 FROM nodes WHERE id=? UNION ALL
    SELECT n.id,s.depth+1 FROM nodes n JOIN scope s ON n.parent_id=s.id WHERE s.depth<200 AND n.trash_id IS NULL
  ) ` : '';
  const scopeParams = parent ? [parent] : [];
  const filter = `n.trash_id IS NULL AND ${NOT_DISCUSSION('n')}
    ${parent ? 'AND n.id IN (SELECT id FROM scope WHERE depth>0)' : ''}
    ${type === 'all' ? '' : type === 'note' ? `AND (${VARIANT_SQL}) IN ('markdown','text','book-page')` : `AND (${VARIANT_SQL})='${type}'`}`;
  const pattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const body = bodyMatch(words), context = EXCERPT_SQL(words[0]);
  const exact = sort === 'relevance' ? 'CASE WHEN lower(n.title)=lower(?) THEN 0 ELSE 1 END,' : '';
  const [titles, bodies, annotated] = await env.DB.batch<
    NoteNode & { search_text?: string; excerpt?: string; excerpt_at?: number; body_length?: number }
  >([
    env.DB.prepare(`${prefix}SELECT ${NODE_COLUMNS} FROM nodes n WHERE ${filter} AND ${words.map(() => "n.title LIKE ? ESCAPE '\\'").join(' AND ')}
      ORDER BY ${exact}n.updated_at DESC,n.id LIMIT ?`)
      .bind(...scopeParams, ...words.map(pattern), ...(exact ? [words.join(' ')] : []), SEARCH_LIMIT),
    env.DB.prepare(`${prefix}SELECT ${NODE_COLUMNS},${context.sql} FROM ${body.from} JOIN nodes n ON n.id=t.node_id
      WHERE ${filter} AND ${body.where.join(' AND ')} AND t.version_id=n.current_version_id AND ${KEY_SQL('n')} IS NULL
      ORDER BY n.updated_at DESC,n.id LIMIT ?`)
      .bind(...scopeParams, ...context.params, ...body.params, SEARCH_LIMIT),
    env.DB.prepare(`${prefix}SELECT ${NODE_COLUMNS},a.search_text FROM annotations a JOIN nodes n ON n.id=a.node_id
      WHERE ${filter} AND ${words.map(() => "a.search_text LIKE ? ESCAPE '\\'").join(' AND ')}
      ORDER BY n.updated_at DESC,n.id LIMIT ?`)
      .bind(...scopeParams, ...words.map(pattern), SEARCH_LIMIT),
  ]);
  const hits: (NoteNode & Pick<SearchResult, 'annotation' | 'excerpt'>)[] = [...titles.results];
  const found = new Map(hits.map((node) => [node.id, node]));
  for (const row of bodies.results) {
    const { excerpt: piece = '', excerpt_at: at = 0, body_length: length = 0, ...node } = row;
    const text = excerpt(piece, at, length), known = found.get(node.id);
    if (known) known.excerpt = text;
    else { const hit = { ...node, excerpt: text }; hits.push(hit); found.set(node.id, hit); }
  }
  const lower = words.map((word) => word.toLowerCase());
  for (const row of annotated.results) {
    const { search_text: text = '', ...node } = row;
    const line = text.split('\n').find((entry) => lower.every((word) => entry.toLowerCase().includes(word)));
    if (!line) continue;
    const [id, quote = '', note = ''] = line.split(SEARCH_FIELD);
    hits.push({ ...node, annotation: { id, quote, note } });
  }
  const selected = hits.sort((a, b) => compareSearch(a, b, words, sort)).slice(0, SEARCH_LIMIT);
  if (!selected.length) return { results: [] };
  const ids = [...new Set(selected.map((node) => node.id))];
  const ancestors = await env.DB.prepare(`WITH RECURSIVE chain(hit,id,parent_id,title,depth) AS (
    SELECT n.id,n.id,n.parent_id,NULL,0 FROM nodes n WHERE n.id IN (${ids.map(() => '?').join(',')})
    UNION ALL SELECT c.hit,p.id,p.parent_id,p.title,c.depth+1 FROM chain c JOIN nodes p ON p.id=c.parent_id WHERE c.depth<200
  ) SELECT hit,id,title FROM chain WHERE depth>0 ORDER BY hit,depth DESC`).bind(...ids).all<{ hit: string; id: string; title: string }>();
  return { results: selected.map((node) => {
    const path = ancestors.results.filter((row) => row.hit === node.id);
    return { ...node, path: path.map((row) => row.title), ancestor_ids: path.map((row) => row.id) };
  }) };
}
