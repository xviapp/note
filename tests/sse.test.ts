import { expect, it } from 'vitest';
import { sseData } from '../shared/sse';

async function read(chunks: string[], limit: number) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const result = [];
  for await (const data of sseData(stream, limit)) result.push(data);
  return result;
}

it('bounds individual SSE events even when the transport coalesces multiple events', async () => {
  const value = '内容'.repeat(10);
  expect(await read([`data: ${value}\n\ndata: ${value}\n\n`], 20)).toEqual([value, value]);
});

it('bounds multi-line events across chunks and unterminated final events', async () => {
  await expect(read(['data: 123456\n', 'data: 123456\n\n'], 10)).rejects.toThrow('数据流过大');
  await expect(read(['data: 12345', '678901'], 10)).rejects.toThrow('数据流过大');
  expect(await read(['data: first\n', 'data: last'], 10)).toEqual(['first\nlast']);
});
