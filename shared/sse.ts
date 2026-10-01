// Both provider and browser streams may split a UTF-8 character or an SSE line.
export async function* sseData(
  stream: ReadableStream<Uint8Array>,
  maxEventCharacters = 1_048_576,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [];
  let eventCharacters = 0;
  const append = (line: string) => {
    const value = line.slice(5).replace(/^ /, '').replace(/\r$/, '');
    eventCharacters += value.length + (data.length ? 1 : 0);
    if (eventCharacters > maxEventCharacters) throw new Error('数据流过大。');
    data.push(value);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > maxEventCharacters + 6) throw new Error('数据流过大。');
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          eventCharacters = 0;
        } else if (line.startsWith('data:')) append(line);
      }
      if (buffer.length + eventCharacters > maxEventCharacters + 6) throw new Error('数据流过大。');
      if (done) break;
    }
    if (buffer.startsWith('data:')) append(buffer);
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
