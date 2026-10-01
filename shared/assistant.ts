import type { FileInfo } from './types';
import type { ChatFile, ChatFileInput } from './chat-files';

export const AI_MODEL = 'deepseek-flash';
export const AI_PROMPT_LIMIT = 8_000;
export const AI_QUOTE_LIMIT = 20_000;
export const AI_IMAGE_LIMIT = 1_048_576;

export interface AssistantSettings {
  configured: boolean;
  model: string;
}
export interface ChatMessage {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  status: 'pending' | 'completed' | 'interrupted' | 'failed';
  content: string;
  quote?: string;
  image?: FileInfo;
  files?: ChatFile[];
  exportedNodeId?: string;
  error?: string;
  createdAt: number;
}
export interface ChatInput {
  content: string;
  quote?: string;
  image?: string;
  files?: ChatFileInput[];
}
export interface ChatHistory {
  messages: ChatMessage[];
  nextBefore: number | null;
  busy: boolean;
}
export type ChatEvent =
  | { type: 'start'; user: ChatMessage; assistant: ChatMessage }
  | { type: 'delta'; content: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; error: string; message?: ChatMessage };
