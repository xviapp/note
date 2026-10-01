import type { ChatEvent, ChatInput } from '../shared/assistant';
import { sseData } from '../shared/sse';
import { CHAT_EVENT_CHARACTER_LIMIT } from '../shared/chat-files';
import { parse } from './api';

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
    headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
    body: JSON.stringify(data),
  });
  if (!response.ok) await parse(response);
  if (!response.body) throw new Error('未收到回复，请刷新会话。');
  let finished = false;
  for await (const data of sseData(response.body, CHAT_EVENT_CHARACTER_LIMIT)) {
    const event = JSON.parse(data) as ChatEvent;
    onEvent(event);
    if (event.type === 'done' || event.type === 'error') finished = true;
  }
  if (!finished) throw new Error('连接中断，请刷新会话查看已保存的回复。');
}
