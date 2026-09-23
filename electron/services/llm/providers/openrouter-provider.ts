import { LlmProviderId } from '@shared/llm-provider-catalog';
import { ILlmProvider, LlmProviderRequest, LlmStreamResult } from '../llm-provider.interface';
import { streamOpenAiCompatibleChat } from '../openai-compatible';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * OpenRouter provider. A single OpenAI-compatible gateway that routes to many
 * upstream models, so the model id is taken verbatim from settings and may be
 * any OpenRouter model id.
 */
export class OpenRouterProvider implements ILlmProvider {
  readonly id: LlmProviderId = 'openrouter';
  readonly label = 'OpenRouter';
  readonly requiresApiKey = true;

  async streamAnswer(
    request: LlmProviderRequest,
    onDelta: (text: string) => void
  ): Promise<LlmStreamResult | void> {
    await streamOpenAiCompatibleChat(
      {
        endpoint: OPENROUTER_ENDPOINT,
        apiKey: request.apiKey,
        model: request.model || 'deepseek/deepseek-v4-flash',
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
        // Optional attribution headers OpenRouter uses for app ranking.
        extraHeaders: {
          'HTTP-Referer': 'https://meetvision.ai',
          'X-Title': 'MeetVision AI',
        },
      },
      onDelta
    );
  }
}
