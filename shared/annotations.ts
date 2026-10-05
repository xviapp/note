import type { SourceLocation } from './translation';

// Highlights and margin notes on a file, kept as one document per file.
export const ANNOTATION_COUNT = 1000;
export const ANNOTATION_QUOTE_CHARS = 4000;
export const ANNOTATION_NOTE_CHARS = 5000;

export interface Annotation {
  id: string;
  // The selected text as shown, for the list and exports.
  quote: string;
  // Empty for a plain highlight.
  note: string;
  location: SourceLocation;
  createdAt: number;
  updatedAt: number;
}
export interface AnnotationList {
  annotations: Annotation[];
  updatedAt: number | null;
}
