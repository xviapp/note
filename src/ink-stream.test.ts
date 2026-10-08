import { afterEach, expect, it, vi } from 'vitest';
import { inkStream } from './ink-stream';

afterEach(() => vi.useRealTimers());

it('buffers deltas and flushes paragraphs or a bounded wait', () => {
  vi.useFakeTimers();
  const receive = vi.fn();
  const stream = inkStream(receive);
  stream.emit({ type: 'delta', content: '第一' });
  stream.emit({ type: 'delta', content: '段\n\n' });
  expect(receive).toHaveBeenCalledExactlyOnceWith({ type: 'delta', content: '第一段\n\n' });
  stream.emit({ type: 'delta', content: '下一段' });
  vi.advanceTimersByTime(1500);
  expect(receive).toHaveBeenLastCalledWith({ type: 'delta', content: '下一段' });
  expect(vi.getTimerCount()).toBe(0);
});

it('flushes partial text before errors and when a connection is stopped', () => {
  vi.useFakeTimers();
  const receive = vi.fn();
  const stream = inkStream(receive);
  stream.emit({ type: 'delta', content: '保留文字' });
  stream.emit({ type: 'error', error: '连接中断' });
  expect(receive.mock.calls.map(([event]) => event.type)).toEqual(['delta', 'error']);
  stream.emit({ type: 'delta', content: '尾部' });
  stream.flush();
  stream.flush();
  expect(receive).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
