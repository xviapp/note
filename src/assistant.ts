import type { ChatEvent, ChatInput } from '../shared/assistant';
import { CHAT_EVENT_CHARACTER_LIMIT } from '../shared/chat-files';
import { streamApi } from './api';

export async function streamChat(
  nodeId: string,
  data: ChatInput,
  key: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  return streamApi<ChatEvent>({
    path: `/api/nodes/${nodeId}/assistant`,
    data,
    key,
    signal,
    onEvent,
    maxEventCharacters: CHAT_EVENT_CHARACTER_LIMIT,
    emptyMessage: '未收到回复，请刷新会话。',
    interruptedMessage: '连接中断，请刷新会话查看已保存的回复。',
  });
}
