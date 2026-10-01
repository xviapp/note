// deepseek-flash (DeepSeek-V4.1-Flash), verified 2026-10-02:
// https://api-docs.deepseek.com/zh-cn/api/list-models/
export const AI_CONTEXT_WINDOW = 1_048_576;
export const AI_IMAGE_TOKENS = 1024;
export const AI_CONTEXT_MESSAGE_LIMIT = 20;

export interface ChatContextUsage {
  estimatedInputTokens: number;
  inputBudget: number;
  reservedOutputTokens: number;
  contextWindow: number;
  omittedHistory: boolean;
}

// This is deliberately an estimate, not a tokenizer or a billing counter.
// DeepSeek's guide gives ~0.3 tokens/English character and ~0.6/Chinese
// character. Count punctuation/code and uncommon Unicode more conservatively.
// https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/
export function estimateTextTokens(text: string): number {
  let tenths = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char === ' ' ||
      char === '\n' ||
      char === '\r' ||
      char === '\t'
    )
      tenths += 3;
    else if (code >= 48 && code <= 57) tenths += 5;
    else if (code >= 0x4e00 && code <= 0x9fff) tenths += 6;
    else if (code <= 0x7f) tenths += 10;
    else tenths += code <= 0x7ff ? 20 : code <= 0xffff ? 30 : 40;
  }
  return Math.ceil(tenths / 10);
}

export function inputTokenBudget(maxTokens: number, contextWindow = AI_CONTEXT_WINDOW): number {
  // Reserve output, a protocol allowance, and 20% above estimated input.
  return Math.max(0, Math.floor((contextWindow - maxTokens - 1024) / 1.2));
}

export function contextLimitMessage(inputTokens: number, maxTokens: number): string {
  return `本次内容预计需要 ${inputTokens.toLocaleString('zh-CN')} tokens，超过可用输入预算 ${inputTokenBudget(maxTokens).toLocaleString('zh-CN')} tokens（已预留 ${maxTokens.toLocaleString('zh-CN')} tokens 回复及估算余量）。请减少附件、缩小 PDF 页码范围，或在设置中降低回复长度。`;
}
