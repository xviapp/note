// A body match chosen in search: the note it opens goes to the word.
let pending: { nodeId: string; word: string } | null = null;
let pageRequest: { nodeId: string; page: number } | null = null;
export function requestFind(nodeId: string, word: string) {
  pending = { nodeId, word };
  pageRequest = null;
  window.dispatchEvent(new Event('note:find'));
}
export function requestPage(nodeId: string, page: number) {
  pageRequest = { nodeId, page };
  pending = null;
  window.dispatchEvent(new Event('note:find'));
}
export function takeRequestedPage(nodeId: string) {
  if (pageRequest?.nodeId !== nodeId) return null;
  const page = pageRequest.page;
  pageRequest = null;
  return page;
}
export function takeRequestedFind(nodeId: string) {
  if (pending?.nodeId !== nodeId) return null;
  const { word } = pending;
  pending = null;
  return word;
}
