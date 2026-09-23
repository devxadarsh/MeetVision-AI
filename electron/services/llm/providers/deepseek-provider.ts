import { LlmProviderId } from '@shared/llm-provider-catalog';
import { ILlmProvider, LlmProviderRequest, LlmStreamResult } from '../llm-provider.interface';
import { streamOpenAiCompatibleChat } from '../openai-compatible';

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * DeepSeek provider. Uses the OpenAI-compatible chat completions endpoint with
 * SSE streaming. Thinking mode is on by default server-side, so it is explicitly
 * disabled unless the user enables it; reasoning tokens are never emitted as
 * answer text.
 */
export class DeepseekProvider implements ILlmProvider {
  readonly id: LlmProviderId = 'deepseek';
  readonly label = 'DeepSeek';
  readonly requiresApiKey = true;

  async streamAnswer(
    request: LlmProviderRequest,
    onDelta: (text: string) => void
  ): Promise<LlmStreamResult | void> {
    const thinking = Boolean(request.thinkingEnabled);

    const result = await streamOpenAiCompatibleChat(
      {
        endpoint: DEEPSEEK_ENDPOINT,
        apiKey: request.apiKey,
        model: request.model || 'deepseek-flash',
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        // temperature is ignored by DeepSeek while thinking mode is active.
        temperature: thinking ? null : request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
        extraBody: thinking
          ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
          : { thinking: { type: 'disabled' } },
      },
      onDelta
    );

    return { finishReason: result.finishReason };
  }
}
