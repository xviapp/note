import type { ChatEvent, ChatInput } from '../shared/assistant';
import { sseData } from '../shared/sse';
import { CHAT_EVENT_CHARACTER_LIMIT } from '../shared/chat-files';
import { keyHeaders, parse } from './api';
import { inkStream } from './ink-stream';

export async function streamChat(
  nodeId: string,
  data: ChatInput,
  key: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/nodes/${nodeId}/assistant`, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': key,
      ...(await keyHeaders(`/api/nodes/${nodeId}/assistant`)),
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) await parse(response);
  if (!response.body) throw new Error('未收到回复，请刷新会话。');
  let finished = false;
  const buffered = document.documentElement.dataset.ink === 'true' ? inkStream(onEvent) : null;
  try {
    for await (const data of sseData(response.body, CHAT_EVENT_CHARACTER_LIMIT)) {
      const event = JSON.parse(data) as ChatEvent;
      if (buffered) buffered.emit(event);
      else onEvent(event);
      if (event.type === 'done' || event.type === 'error') finished = true;
    }
  } finally {
    buffered?.flush();
  }
  if (!finished) throw new Error('连接中断，请刷新会话查看已保存的回复。');
}
