import {
  isTranslationLanguage,
  type SourceLocation,
  type TranslationEvent,
  type TranslationLanguage,
} from '../shared/translation';
import { streamApi } from './api';

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
  return streamApi<TranslationEvent>({
    path: `/api/nodes/${nodeId}/translations`,
    data: { source, targetLanguage, refresh, location },
    signal,
    onEvent,
    allowJson: true,
    emptyMessage: '未收到译文，请重试。',
    interruptedMessage: '连接中断，译文尚未确认保存。可从翻译记录查看。',
  });
}
