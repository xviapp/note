import type { NoteNode } from '../shared/types.ts';
import { ApiError, type Client } from './client.ts';

const NODE_ID = /^[a-zA-Z0-9_-]+$/;
const absent = (error: unknown) =>
  error instanceof ApiError && [400, 404].includes(error.status);
async function byTitlePath(client: Client, titles: string[]): Promise<string> {
  let parent: string | null = null;
  for (const title of titles) {
    const found: NoteNode[] = (await client.children(parent)).filter((node) => node.title === title);
    if (!found.length) throw new Error(`找不到条目：${title}`);
    if (found.length > 1)
      throw new Error(`有多个条目叫「${title}」，请改用 ID：${found.map((node) => node.id).join('、')}`);
    parent = found[0].id;
  }
  return parent!;
}
// A note's link (.../n/ID), its ID, or its titles from the top: 工作/项目.
export async function resolveTarget(client: Client, target: string): Promise<string> {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target),
      id = url.pathname.match(/^\/n\/([a-zA-Z0-9_-]+)\/?$/)?.[1];
    if (!id) throw new Error('这不是页间条目的链接。');
    if (url.origin !== client.server) throw new Error(`这个链接不属于 ${client.server}。`);
    return id;
  }
  if (NODE_ID.test(target)) {
    try {
      return (await client.node(target)).id;
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  const titles = target.split('/').filter(Boolean);
  if (!titles.length) throw new Error('请指定要拉取的条目，或用 --all 拉取全部。');
  return byTitlePath(client, titles);
}
