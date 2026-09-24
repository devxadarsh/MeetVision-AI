export interface OpenAiCompatibleChatOptions {
  endpoint: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Pass null to omit the field (some providers reject it in reasoning modes). */
  temperature?: number | null;
  maxTokens: number;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  /** Extra top-level body fields merged into the request. */
  extraBody?: Record<string, unknown>;
}

/**
 * Shared streaming client for OpenAI-compatible `/chat/completions` endpoints
 * (DeepSeek, OpenRouter, and future gateways). Parses SSE `data:` lines and
 * emits `choices[0].delta.content`.
 */
export async function streamOpenAiCompatibleChat(
  options: OpenAiCompatibleChatOptions,
  onDelta: (text: string) => void
): Promise<{ finishReason?: string; totalTokens?: number; inputTokens?: number; outputTokens?: number }> {
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt },
    ],
    ...(options.extraBody || {}),
  };
  if (options.temperature !== null && options.temperature !== undefined) {
    body['temperature'] = options.temperature;
  }

  const response = await fetch(options.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey || ''}`,
      'content-type': 'application/json',
      ...(options.extraHeaders || {}),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `API returned ${response.status}: ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | undefined;
  let totalTokens: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let streamedChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        if (data?.usage) {
          if (typeof data.usage.prompt_tokens === 'number') inputTokens = data.usage.prompt_tokens;
          if (typeof data.usage.completion_tokens === 'number') outputTokens = data.usage.completion_tokens;
          if (typeof data.usage.total_tokens === 'number') totalTokens = data.usage.total_tokens;
        }

        const choice = data?.choices?.[0];
        if (typeof choice?.finish_reason === 'string') {
          finishReason = choice.finish_reason;
        }
        // Never surface chain-of-thought as answer bullets.
        const text = choice?.delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          streamedChars += text.length;
          onDelta(text);
        }
      } catch {
        // Ignore partial or non-JSON stream lines.
      }
    }
  }

  // Fallback token calculation if provider omitted usage in stream
  if (totalTokens === undefined) {
    const promptLen = (options.systemPrompt?.length || 0) + (options.userPrompt?.length || 0);
    inputTokens = Math.max(1, Math.round(promptLen / 4));
    outputTokens = Math.max(1, Math.round(streamedChars / 4));
    totalTokens = inputTokens + outputTokens;
  }

  return { finishReason, totalTokens, inputTokens, outputTokens };
}
