export const TRANSLATION_LIMIT = 10_000;
export const TRANSLATION_LANGUAGES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
} as const;
export type TranslationLanguage = keyof typeof TRANSLATION_LANGUAGES;
export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && Object.hasOwn(TRANSLATION_LANGUAGES, value);
}
export interface TextSourceLocation {
  kind: 'text';
  versionId?: string;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}
export interface PdfSourceRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfSourceLocation {
  kind: 'pdf';
  fileId: string;
  fileName?: string;
  page: number;
  endPage: number;
  rects: PdfSourceRect[];
}
export type SourceLocation = TextSourceLocation | PdfSourceLocation;
export function sourceLabel(location: SourceLocation | null): string {
  if (!location) return '';
  if (location.kind === 'text') return '正文';
  return `PDF · 第 ${location.page}${location.endPage > location.page ? `–${location.endPage}` : ''} 页`;
}
export interface Translation {
  id: string;
  source: string;
  content: string;
  targetLanguage: TranslationLanguage;
  savedAt: number;
  location: SourceLocation | null;
}
export interface TranslationSummary {
  id: string;
  excerpt: string;
  targetLanguage: TranslationLanguage;
  savedAt: number;
  locationLabel: string;
}
export interface TranslationHistory {
  translations: TranslationSummary[];
  nextOffset: number | null;
}
export type TranslationEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; translation: Translation; cached: boolean }
  | { type: 'error'; error: string };
