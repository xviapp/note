import {
  isTranslationLanguage,
  type SourceLocation,
  type TranslationEvent,
  type TranslationLanguage,
} from '../shared/translation';
import { sseData } from '../shared/sse';
import { parse } from './api';

export interface TranslationLaunch {
  source?: string;
  anchor?: { left: number; top: number; bottom: number };
  host?: HTMLElement;
  location?: SourceLocation | null;
}
export function preferredLanguage(): TranslationLanguage {
  try {
    const value = localStorage.getItem('translation-language');
    if (isTranslationLanguage(value)) return value;
  } catch {
    /* Preferences are optional when browser storage is disabled. */
  }
  return 'zh-CN';
}
export function rememberLanguage(value: TranslationLanguage) {
  try {
    localStorage.setItem('translation-language', value);
  } catch {
    /* Optional preference. */
  }
}
export async function translateText(
  nodeId: string,
  source: string,
  targetLanguage: TranslationLanguage,
  refresh: boolean,
  location: SourceLocation | null,
  signal: AbortSignal,
  onEvent: (event: TranslationEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/nodes/${nodeId}/translations`, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/json', 'x-idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ source, targetLanguage, refresh, location }),
  });
  if (!response.ok) await parse(response);
  if (response.headers.get('content-type')?.includes('application/json')) {
    const event = await parse<TranslationEvent>(response);
    signal.throwIfAborted();
    onEvent(event);
    return;
  }
  if (!response.body) throw new Error('未收到译文，请重试。');
  let finished = false;
  for await (const data of sseData(response.body)) {
    signal.throwIfAborted();
    const event = JSON.parse(data) as TranslationEvent;
    onEvent(event);
    if (event.type === 'done' || event.type === 'error') finished = true;
  }
  if (!finished) throw new Error('连接中断，译文尚未确认保存。可从翻译记录查看。');
}
