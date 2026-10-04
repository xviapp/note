import type { TranslationLanguage } from './translation';

// Whole-paper translation goes paragraph by paragraph, a batch per request,
// so a long paper fits the Workers request limits and resumes where it stopped.
export const PAPER_BATCH_CHARS = 4000;
export const PAPER_BATCH_BLOCKS = 30;
// Longer paragraphs are rare; they are sent alone and may reach this size.
export const PAPER_BLOCK_CHARS = 6000;
// Formulas, citations and links stay out of the text the model sees, as ⟦n⟧.
export const placeholder = (index: number) => `⟦${index}⟧`;
export const PLACEHOLDER = /⟦(\d+)⟧/g;

export interface PaperBlockSource {
  // SHA-256 of `text`, so a re-imported paper reuses unchanged paragraphs.
  hash: string;
  text: string;
}
export interface PaperTranslation {
  language: TranslationLanguage;
  // Translated text by source hash.
  blocks: Record<string, string>;
  updatedAt: number | null;
}
