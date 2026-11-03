import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitLine, Progress } from './progress.ts';

const stream = (isTTY: boolean) => {
  const written: string[] = [];
  return {
    written,
    isTTY,
    columns: 20,
    write: (text: string) => {
      written.push(text);
      return true;
    },
  } as unknown as ConstructorParameters<typeof Progress>[0] & { written: string[] };
};
describe('Progress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('overwrites one line on a terminal and shows the latest after a burst', () => {
    const out = stream(true);
    const progress = new Progress(out);
    progress.update('一');
    progress.update('二');
    progress.update('三');
    expect(out.written).toEqual(['\r\x1b[K一']);
    vi.advanceTimersByTime(100);
    expect(out.written).toEqual(['\r\x1b[K一', '\r\x1b[K三']);
    progress.clear();
    expect(out.written.at(-1)).toBe('\r\x1b[K');
  });
  it('writes occasional whole lines when piped, and nothing to erase', () => {
    const out = stream(false);
    const progress = new Progress(out);
    progress.update('一');
    progress.update('二');
    vi.advanceTimersByTime(2100);
    progress.clear();
    expect(out.written).toEqual(['一\n', '二\n']);
  });
  it('drops a pending line when cleared', () => {
    const out = stream(true);
    const progress = new Progress(out);
    progress.update('一');
    progress.update('二');
    progress.clear();
    vi.advanceTimersByTime(1000);
    expect(out.written).not.toContain('\r\x1b[K二');
  });
  it('stays quiet during a question', async () => {
    const out = stream(true);
    const progress = new Progress(out);
    let answer: () => void = () => {};
    const asked = progress.during(() => new Promise<void>((resolve) => (answer = resolve)));
    progress.update('问题期间');
    vi.advanceTimersByTime(1000);
    expect(out.written).toEqual([]);
    answer();
    await asked;
    progress.update('之后');
    expect(out.written).toEqual(['\r\x1b[K之后']);
  });
  it('removes control characters from names', () => {
    const out = stream(false);
    new Progress(out).update('a\x1b[31mb\x9bc');
    expect(out.written).toEqual(['a?[31mb?c\n']);
  });
});
describe('fitLine', () => {
  it('leaves short lines alone and cuts long ones by display width', () => {
    expect(fitLine('abc', 10)).toBe('abc');
    expect(fitLine('abcdefghijkl', 6)).toBe('abcde…');
    expect(fitLine('页间页间页间', 6)).toBe('页间…');
  });
});
