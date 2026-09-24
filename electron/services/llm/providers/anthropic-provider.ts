import { LlmProviderId } from '@shared/llm-provider-catalog';
import { ILlmProvider, LlmProviderRequest, LlmStreamResult } from '../llm-provider.interface';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Anthropic Claude provider using the Messages API with SSE streaming. */
export class AnthropicProvider implements ILlmProvider {
  readonly id: LlmProviderId = 'anthropic';
  readonly label = 'Anthropic Claude';
  readonly requiresApiKey = true;

  async streamAnswer(
    request: LlmProviderRequest,
    onDelta: (text: string) => void
  ): Promise<LlmStreamResult | void> {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': request.apiKey || '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model || 'claude-3-5-sonnet-20241022',
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        system: request.systemPrompt,
        stream: true,
        messages: [{ role: 'user', content: request.userPrompt }],
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Anthropic API returned ${response.status}: ${response.statusText}`);
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
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          if (data.type === 'message_start' && data.message?.usage) {
            inputTokens = data.message.usage.input_tokens;
          }
          if (data.type === 'content_block_delta' && data.delta?.text) {
            streamedChars += data.delta.text.length;
            onDelta(data.delta.text);
          }
          if (data.type === 'message_delta') {
            if (typeof data.delta?.stop_reason === 'string') {
              finishReason = data.delta.stop_reason;
            }
            if (data.usage?.output_tokens) {
              outputTokens = data.usage.output_tokens;
            }
          }
        } catch {
          // Ignore partial stream line parsing.
        }
      }
    }

    if (inputTokens !== undefined || outputTokens !== undefined) {
      totalTokens = (inputTokens || 0) + (outputTokens || 0);
    } else {
      const promptLen = (request.systemPrompt?.length || 0) + (request.userPrompt?.length || 0);
      inputTokens = Math.max(1, Math.round(promptLen / 4));
      outputTokens = Math.max(1, Math.round(streamedChars / 4));
      totalTokens = inputTokens + outputTokens;
    }

    return { finishReason, totalTokens, inputTokens, outputTokens };
  }
}
