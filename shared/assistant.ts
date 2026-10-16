import type { FileInfo } from './types';
import type { ChatFile, ChatFileInput } from './chat-files';
import type { ChatContextUsage } from './ai-context';

// Reserved conversation scope; never a library node.
export const GLOBAL_ASSISTANT_ID = 'qingli-global';

export const AI_MODEL = 'deepseek-flash';
export const AI_PROMPT_LIMIT = 8_000;
export const AI_QUOTE_LIMIT = 20_000;
export const AI_IMAGE_LIMIT = 1_048_576;
// Bound the combined reasoning and answer held while streaming.
export const AI_RESPONSE_CHARACTER_LIMIT = 262_144;
export const AI_DEFAULT_MAX_TOKENS = 8192;
export const AI_REPLY_LIMITS = [2048, 4096, 8192, 16384, 32768] as const;
export const AI_THINKING_LEVELS = ['none', 'low', 'high', 'max'] as const;
export type ThinkingLevel = (typeof AI_THINKING_LEVELS)[number];
export const AI_DEFAULT_THINKING_LEVEL: ThinkingLevel = 'none';

export interface AssistantSettings {
  configured: boolean;
  model: string;
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
}
export interface ChatMessage {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  status: 'pending' | 'completed' | 'interrupted' | 'failed';
  content: string;
  reasoning?: string;
  quote?: string;
  image?: FileInfo;
  files?: ChatFile[];
  // The file's highlights and notes, as sent with the question.
  annotations?: string;
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
  // Include the file's highlights and notes.
  annotations?: boolean;
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
  | { type: 'reasoning'; content: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; error: string; message?: ChatMessage };
