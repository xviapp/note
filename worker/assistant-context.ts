import type { NoteNode } from '../shared/types';
import { bookPrompt } from './books';
import { projectPrompt } from './projects';
import type { Env } from './types';

// What each kind of page adds to 青藜's system prompt. The shared prompt covers
// every file; a book contributes its role, the page being discussed and how to
// discuss it, a project its open work. A new type adds its contributor here.
const CONTRIBUTORS: ((env: Env, node: NoteNode) => Promise<string>)[] = [bookPrompt, projectPrompt];

export async function assistantContext(env: Env, node: NoteNode): Promise<string> {
  return (await Promise.all(CONTRIBUTORS.map((contribute) => contribute(env, node)))).join('');
}
