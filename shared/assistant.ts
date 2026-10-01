import type { FileInfo } from './types';
import type { ChatFile, ChatFileInput } from './chat-files';
import type { ChatContextUsage } from './ai-context';

export const AI_MODEL = 'deepseek-flash';
export const AI_PROMPT_LIMIT = 8_000;
export const AI_QUOTE_LIMIT = 20_000;
export const AI_IMAGE_LIMIT = 1_048_576;
export const AI_DEFAULT_MAX_TOKENS = 8192;
export const AI_REPLY_LIMITS = [2048, 4096, 8192, 16384, 32768] as const;

export interface AssistantSettings {
  configured: boolean;
  model: string;
  maxTokens: number;
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
  continueFrom?: string;
  exportedNodeId?: string;
  error?: string;
  createdAt: number;
}
export interface ChatInput {
  content: string;
  quote?: string;
  image?: string;
  files?: ChatFileInput[];
  continueFrom?: string;
}
export interface ChatHistory {
  messages: ChatMessage[];
  nextBefore: number | null;
  busy: boolean;
}
export type ChatEvent =
  | { type: 'start'; user: ChatMessage; assistant: ChatMessage; context?: ChatContextUsage }
  | { type: 'delta'; content: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; error: string; message?: ChatMessage };
