import { beforeEach, expect, it, vi } from 'vitest';
import { clearDrafts, draftEpoch } from './note-drafts';
import { readSentHistory, recordSent } from './sent-history';

beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });
const receipt = { id: 'clips:one', summary: '散步时想到的事', detail: '随手记' };
it('persists one receipt per confirmed operation and keeps its original send time', () => {
  const started = draftEpoch();
  recordSent(receipt, started);
  const first = readSentHistory();
  recordSent({ ...receipt, summary: '重试后的摘要' }, started);
  expect(readSentHistory()).toEqual(first);
  expect(first[0]).toMatchObject(receipt);
});
it('expires old receipts and bounds storage to the newest 500 operations', () => {
  vi.useFakeTimers();
  for (let i = 0; i < 503; i++) {
    vi.setSystemTime(new Date(2026, 9, 14, 0, 0, i));
    recordSent({ ...receipt, id: String(i) }, draftEpoch());
  }
  expect(readSentHistory()).toHaveLength(500);
  expect(readSentHistory()[0]!.id).toBe('502');
  expect(localStorage.getItem('note-draft:sent:0')).toBeNull();
  vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
  expect(readSentHistory()).toEqual([]);
  vi.useRealTimers();
});
it('clears on sign-out and rejects a send started before sign-out', () => {
  const started = draftEpoch();
  recordSent(receipt, started);
  clearDrafts();
  recordSent(receipt, started);
  expect(readSentHistory()).toEqual([]);
});
it('does not fail the send when history storage is full', () => {
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
  try { expect(() => recordSent(receipt, draftEpoch())).not.toThrow(); }
  finally { set.mockRestore(); }
});
