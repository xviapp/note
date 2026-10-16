import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatHistory, ChatMessage } from '../../shared/assistant';
import { RESUME_CHECK_MS, useAssistantConversation } from './useAssistantConversation';

const { api, cachedApi, streamChat } = vi.hoisted(() => ({ api: vi.fn(), cachedApi: vi.fn(), streamChat: vi.fn() }));
vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), api, cachedApi }));
vi.mock('../assistant', () => ({ streamChat }));

const message = (id: string, role: ChatMessage['role'], status: ChatMessage['status'], content: string): ChatMessage =>
  ({ id, sequence: 0, role, status, content, createdAt: 0 });
let reply: ChatMessage;
beforeEach(() => {
  reply = message('a1', 'assistant', 'pending', '');
  cachedApi.mockReset().mockResolvedValue(undefined);
  api.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/ai/settings') return { configured: true, model: 'deepseek-flash', maxTokens: 1000 };
    return { messages: reply.status === 'pending' ? [] : [message('u1', 'user', 'completed', '问'), reply], nextBefore: null, busy: false } satisfies ChatHistory;
  });
  // A stream that delivers its start and then goes silent, as a frozen connection does.
  streamChat.mockReset().mockImplementation(
    (_id: string, _data: unknown, _key: string, signal: AbortSignal, onEvent: (event: ChatEvent) => void) => {
      onEvent({ type: 'start', user: message('u1', 'user', 'completed', '问'), assistant: reply });
      onEvent({ type: 'delta', content: '一半' });
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    },
  );
});
afterEach(cleanup);

const conversation = () =>
  renderHook(() =>
    useAssistantConversation({
      scopeId: 'n1', visible: true, onSend: () => {}, onChanged: () => {}, onNavigate: () => {},
    }),
  );

it('keeps streamed reasoning separate from the answer and preserves it if saving failed', async () => {
  let emit!: (event: ChatEvent) => void;
  let finish!: () => void;
  streamChat.mockImplementation(
    (_id: string, _data: unknown, _key: string, _signal: AbortSignal, onEvent: typeof emit) => {
      emit = onEvent;
      onEvent({ type: 'start', user: message('u1', 'user', 'completed', '问'), assistant: reply });
      return new Promise<void>((resolve) => { finish = resolve; });
    },
  );
  const view = conversation();
  await waitFor(() => expect(view.result.current.settings?.configured).toBe(true));
  act(() => view.result.current.composer.setPrompt('问'));
  act(() => void view.result.current.send());
  await waitFor(() => expect(emit).toBeDefined());
  act(() => {
    emit({ type: 'reasoning', content: '先分析，' });
    emit({ type: 'reasoning', content: '再比较。' });
  });
  expect(view.result.current.messages.at(-1)).toMatchObject({ content: '', reasoning: '先分析，再比较。', status: 'pending' });
  act(() => emit({ type: 'delta', content: '正式回答' }));
  expect(view.result.current.messages.at(-1)).toMatchObject({ content: '正式回答', reasoning: '先分析，再比较。' });
  reply = message('a1', 'assistant', 'failed', '');
  act(() => {
    emit({ type: 'error', error: '回复未能保存' });
    finish();
  });
  await waitFor(() => expect(view.result.current.sending).toBe(false));
  await waitFor(() => expect(view.result.current.messages.at(-1)).toMatchObject({
    content: '正式回答', reasoning: '先分析，再比较。', status: 'failed',
  }));
});

it('shows the saved reply when the stream died while the app was in the background', async () => {
  const view = conversation();
  await waitFor(() => expect(view.result.current.settings?.configured).toBe(true));
  act(() => view.result.current.composer.setPrompt('问'));
  act(() => void view.result.current.send());
  await waitFor(() => expect(view.result.current.sending).toBe(true));
  vi.useFakeTimers();
  try {
    window.dispatchEvent(new Event('pagehide'));
    reply = message('a1', 'assistant', 'completed', '完整的回答');
    window.dispatchEvent(new Event('focus'));
    await act(() => vi.advanceTimersByTimeAsync(RESUME_CHECK_MS));
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(view.result.current.sending).toBe(false));
  await waitFor(() => expect(view.result.current.messages.at(-1)?.content).toBe('完整的回答'));
  expect(view.result.current.error).toBe('');
});

it('keeps waiting while the server is still writing the reply', async () => {
  const view = conversation();
  await waitFor(() => expect(view.result.current.settings?.configured).toBe(true));
  act(() => view.result.current.composer.setPrompt('问'));
  act(() => void view.result.current.send());
  await waitFor(() => expect(view.result.current.sending).toBe(true));
  vi.useFakeTimers();
  try {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('focus'));
    await act(() => vi.advanceTimersByTimeAsync(RESUME_CHECK_MS));
  } finally {
    vi.useRealTimers();
  }
  expect(view.result.current.sending).toBe(true);
  act(() => view.result.current.cancel());
  await waitFor(() => expect(view.result.current.error).toBe('已停止生成。'));
});

it('keeps asking after coming back until the server has finished the reply', async () => {
  const view = conversation();
  await waitFor(() => expect(view.result.current.settings?.configured).toBe(true));
  act(() => view.result.current.composer.setPrompt('问'));
  act(() => void view.result.current.send());
  await waitFor(() => expect(view.result.current.sending).toBe(true));
  vi.useFakeTimers();
  try {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('focus'));
    await act(() => vi.advanceTimersByTimeAsync(RESUME_CHECK_MS * 3));
    expect(view.result.current.sending).toBe(true);
    reply = message('a1', 'assistant', 'completed', '完整的回答');
    await act(() => vi.advanceTimersByTimeAsync(RESUME_CHECK_MS));
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(view.result.current.sending).toBe(false));
  await waitFor(() => expect(view.result.current.messages.at(-1)?.content).toBe('完整的回答'));
  expect(view.result.current.error).toBe('');
});

it('stops asking once the app goes to the background again', async () => {
  const view = conversation();
  await waitFor(() => expect(view.result.current.settings?.configured).toBe(true));
  act(() => view.result.current.composer.setPrompt('问'));
  act(() => void view.result.current.send());
  await waitFor(() => expect(view.result.current.sending).toBe(true));
  vi.useFakeTimers();
  try {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('focus'));
    await act(() => vi.advanceTimersByTimeAsync(RESUME_CHECK_MS));
    window.dispatchEvent(new Event('pagehide'));
    const asked = api.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(RESUME_CHECK_MS * 3));
    expect(api.mock.calls.length).toBe(asked);
  } finally {
    vi.useRealTimers();
  }
  act(() => view.result.current.cancel());
  await waitFor(() => expect(view.result.current.error).toBe('已停止生成。'));
});

it('shows the cached conversation until the server answers', async () => {
  let answer!: (history: ChatHistory) => void;
  api.mockImplementation((path: string) =>
    path === '/api/ai/settings'
      ? Promise.resolve({ configured: true, model: 'deepseek-flash', maxTokens: 1000 })
      : new Promise((resolve) => { answer = resolve; }));
  cachedApi.mockImplementation(async (path: string) =>
    path.endsWith('/assistant')
      ? { messages: [message('u0', 'user', 'completed', '上次的问题')], nextBefore: null, busy: false }
      : undefined);
  const view = conversation();
  await waitFor(() => expect(view.result.current.messages.map((m) => m.content)).toEqual(['上次的问题']));
  expect(view.result.current.loading).toBe(false);
  act(() => answer({ messages: [message('u2', 'user', 'completed', '服务器上的')], nextBefore: null, busy: false }));
  await waitFor(() => expect(view.result.current.messages.map((m) => m.content)).toEqual(['服务器上的']));
});
