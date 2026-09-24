import { LlmProviderId } from '@shared/llm-provider-catalog';
import { ILlmProvider } from './llm-provider.interface';
import { DeepseekProvider } from './providers/deepseek-provider';
import { OpenRouterProvider } from './providers/openrouter-provider';
import { AnthropicProvider } from './providers/anthropic-provider';
import { LocalProvider } from './providers/local-provider';

/** Registry of LLM providers keyed by id. Add new providers here. */
export class LlmRegistry {
  private readonly providers = new Map<LlmProviderId, ILlmProvider>();

  constructor() {
    this.register(new DeepseekProvider());
    this.register(new OpenRouterProvider());
    this.register(new AnthropicProvider());
    this.register(new LocalProvider());
  }

  register(provider: ILlmProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: LlmProviderId | undefined): ILlmProvider | undefined {
    if (!id) return undefined;
    return this.providers.get(id);
  }

  list(): ILlmProvider[] {
    return Array.from(this.providers.values());
  }
}
