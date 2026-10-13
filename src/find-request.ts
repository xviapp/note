// A body match chosen in search: the note it opens goes to the word.
let pending: { nodeId: string; word: string } | null = null;
export function requestFind(nodeId: string, word: string) {
  pending = { nodeId, word };
}
export function takeRequestedFind(nodeId: string) {
  if (pending?.nodeId !== nodeId) return null;
  const { word } = pending;
  pending = null;
  return word;
}
