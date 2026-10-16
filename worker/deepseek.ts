import {
  AI_MODEL,
  AI_DEFAULT_MAX_TOKENS,
  AI_REPLY_LIMITS,
  AI_DEFAULT_THINKING_LEVEL,
  AI_THINKING_LEVELS,
  AI_RESPONSE_CHARACTER_LIMIT,
  type AssistantSettings,
  type ThinkingLevel,
} from '../shared/assistant';
import { sseData } from '../shared/sse';
import { AppError, integer, textValue } from './http';
import type { Env } from './types';

const BASE_URL = 'https://api.deepseek.com';
let baseUrl = BASE_URL;
// Called per request; end-to-end tests use a local stand-in for DeepSeek.
export function configureProvider(env: Env) {
  baseUrl = env.DEEPSEEK_BASE_URL || BASE_URL;
}
export function toBase64(bytes: Uint8Array): string {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`note:ai-key:v1:${env.APP_SECRET}`),
  );
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function validateKey(value: unknown): string {
  const key = textValue(value, 'API Key', 512).trim();
  if (!/^[\x21-\x7e]+$/.test(key)) throw new AppError(400, 'API Key 不能包含空白或中文字符。');
  return key;
}
export async function aiSettings(env: Env): Promise<AssistantSettings> {
  const row = await env.DB.prepare(
    'SELECT max_tokens,thinking_level FROM ai_settings WHERE id=1',
  ).first<{
    max_tokens: number;
    thinking_level: ThinkingLevel;
  }>();
  return {
    configured: !!row,
    model: AI_MODEL,
    maxTokens: row?.max_tokens ?? AI_DEFAULT_MAX_TOKENS,
    thinkingLevel: row?.thinking_level ?? AI_DEFAULT_THINKING_LEVEL,
  };
}
export async function saveAiSettings(
  env: Env,
  data: Record<string, unknown>,
): Promise<AssistantSettings> {
  const current = await aiSettings(env);
  const maxTokens =
    data.maxTokens === undefined ? current.maxTokens : integer(data.maxTokens, '回复长度');
  if (!AI_REPLY_LIMITS.some((limit) => limit === maxTokens))
    throw new AppError(400, '请选择支持的回复长度。');
  const thinkingLevel =
    data.thinkingLevel === undefined ? current.thinkingLevel : data.thinkingLevel;
  if (!AI_THINKING_LEVELS.some((level) => level === thinkingLevel))
    throw new AppError(400, '请选择支持的思考深度。');
  if (data.apiKey === undefined && current.configured) {
    await env.DB.prepare('UPDATE ai_settings SET max_tokens=?,thinking_level=? WHERE id=1')
      .bind(maxTokens, thinkingLevel)
      .run();
    return aiSettings(env);
  }
  const key = validateKey(data.apiKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(env),
    new TextEncoder().encode(key),
  );
  await env.DB.prepare(
    'INSERT INTO ai_settings(id,encrypted_key,max_tokens,thinking_level) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,max_tokens=excluded.max_tokens,thinking_level=excluded.thinking_level',
  )
    .bind(`${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`, maxTokens, thinkingLevel)
    .run();
  return aiSettings(env);
}
export async function readApiKey(env: Env): Promise<string> {
  const row = await env.DB.prepare('SELECT encrypted_key FROM ai_settings WHERE id=1').first<{
    encrypted_key: string;
  }>();
  if (!row) throw new AppError(400, '请先在设置中配置 DeepSeek API Key。', 'AI_NOT_CONFIGURED');
  try {
    const [iv, ciphertext] = row.encrypted_key.split('.');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) },
      await encryptionKey(env),
      fromBase64(ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new AppError(400, 'AI 密钥无法读取，请在设置中重新保存 API Key。', 'AI_KEY_UNREADABLE');
  }
}
async function providerFetch(
  path: string,
  key: string,
  signal: AbortSignal,
  data?: unknown,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: data ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AppError(502, '暂时无法连接 DeepSeek，请稍后重试。');
  }
  if (!response.ok) {
    // Estimates can differ from the provider's tokenizer. Classify that error
    // without exposing arbitrary provider response text (or retrying/truncating).
    if (response.status === 400 || response.status === 413) {
      const detail = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      const error = detail?.error;
      if (
        error &&
        /context[_ ](?:length|window)|maximum context|too many tokens|token limit/i.test(
          `${error.code ?? ''} ${error.message ?? ''}`,
        )
      )
        throw new AppError(
          413,
          'DeepSeek 实际分词后超出上下文容量，请减少附件、缩小 PDF 页码范围或降低回复长度后重试。',
          'AI_CONTEXT_LIMIT',
        );
    } else await response.body?.cancel();
    const labels: Record<number, string> = {
      400: 'DeepSeek 未能接受这些内容，请减少附件、缩短问题或重新截图。',
      401: 'DeepSeek API Key 无效，请在设置中更新。',
      402: 'DeepSeek 账户余额不足，请检查账户。',
      403: 'DeepSeek 拒绝了此密钥的请求，请检查账户权限。',
      429: 'DeepSeek 请求过于频繁，请稍后重试。',
    };
    throw new AppError(
      502,
      labels[response.status] || 'DeepSeek 暂时无法响应，请稍后重试。',
      'AI_PROVIDER_ERROR',
    );
  }
  return response;
}
export async function testAiSettings(
  env: Env,
  data: Record<string, unknown>,
): Promise<{ ok: true }> {
  const key = data.apiKey ? validateKey(data.apiKey) : await readApiKey(env);
  const response = await providerFetch('/models', key, AbortSignal.timeout(15_000));
  const result = (await response.json()) as { data?: { id: string }[] };
  if (!result.data?.some((model) => model.id === AI_MODEL))
    throw new AppError(400, `当前账户无法使用 ${AI_MODEL}，请检查 DeepSeek 模型权限。`);
  return { ok: true };
}
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
}
export async function* deepseekReply(
  key: string,
  messages: ProviderMessage[],
  signal: AbortSignal,
  maxTokens: number,
  // Ask for a JSON object reply (the prompt must describe its shape).
  json = false,
  thinkingLevel: ThinkingLevel = AI_DEFAULT_THINKING_LEVEL,
  onReasoning?: (content: string) => void,
): AsyncGenerator<string> {
  const response = await providerFetch('/chat/completions', key, signal, {
    model: AI_MODEL,
    messages,
    stream: true,
    max_tokens: maxTokens,
    thinking: { type: thinkingLevel === 'none' ? 'disabled' : 'enabled' },
    ...(thinkingLevel === 'none' ? {} : { reasoning_effort: thinkingLevel }),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  if (!response.body) throw new AppError(502, 'DeepSeek 没有返回回复。');
  let ended = false,
    finish = '',
    length = 0,
    reasoningLength = 0;
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') {
      ended = true;
      break;
    }
    const chunk = JSON.parse(data) as {
      error?: unknown;
      choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    };
    if (chunk.error) throw new AppError(502, 'DeepSeek 生成失败，请稍后重试。');
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const reasoning = choice?.delta?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning) {
      reasoningLength += reasoning.length;
      if (reasoningLength + length > AI_RESPONSE_CHARACTER_LIMIT)
        throw new AppError(502, '回复内容过大，已停止生成，可查看已有内容。');
      onReasoning?.(reasoning);
    }
    const value = choice?.delta?.content;
    if (typeof value === 'string' && value) {
      length += value.length;
      if (reasoningLength + length > AI_RESPONSE_CHARACTER_LIMIT)
        throw new AppError(502, '回复内容过大，已停止生成，可查看已有内容。');
      yield value;
    }
  }
  if (finish === 'length' && !length && thinkingLevel !== 'none')
    throw new AppError(
      502,
      '思考已用完本次生成额度，尚未生成回答。请在设置中提高单次回复上限或降低思考深度后重试。',
      'AI_LENGTH_LIMIT',
    );
  if (finish === 'length')
    throw new AppError(502, '已达到本次回复长度上限，可点击「继续生成」。', 'AI_LENGTH_LIMIT');
  if (!ended || finish !== 'stop' || !length)
    throw new AppError(502, '回复未完整接收，已有内容已保留。');
}
