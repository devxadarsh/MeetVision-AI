/**
 * Pluggable LLM provider catalog.
 *
 * Single source of truth for both the Electron main process (dispatch + key
 * resolution) and the Angular settings UI (provider/model dropdowns, key
 * fields). Adding a provider means adding one entry here and one
 * `ILlmProvider` implementation under `electron/services/llm/providers/`.
 *
 * This file must stay free of Node built-ins and Electron imports: it is
 * imported by the renderer.
 */

export type LlmProviderId = 'deepseek' | 'openrouter' | 'anthropic' | 'local';

export interface LlmModelInfo {
  id: string;
  label: string;
  note?: string;
}

export interface LlmProviderCatalogEntry {
  id: LlmProviderId;
  label: string;
  description: string;
  /** True when the provider cannot run without a stored API key. */
  requiresApiKey: boolean;
  /** Environment variable used as a fallback key source in development. */
  envKey?: string;
  defaultModel: string;
  models: LlmModelInfo[];
  /** True when the provider exposes a reasoning/thinking-mode toggle. */
  supportsReasoningToggle: boolean;
  /**
   * True when the provider is a gateway whose model list is not exhaustive, so
   * the settings UI offers a free-text custom model id as well.
   */
  allowCustomModel?: boolean;
}

export const LLM_PROVIDERS: readonly LlmProviderCatalogEntry[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Cloud answer synthesis via the DeepSeek OpenAI-compatible API.',
    requiresApiKey: true,
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
    supportsReasoningToggle: true,
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek Flash (Recommended)', note: 'Fast, low-latency answers.' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (Deep Analysis)', note: 'Slower, higher-quality reasoning.' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Cloud answer synthesis via OpenRouter, which routes to many providers and models.',
    requiresApiKey: true,
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'deepseek/deepseek-v4-flash',
    supportsReasoningToggle: false,
    allowCustomModel: true,
    models: [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (Recommended)', note: 'Fast and cheap.' },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: 'Higher-quality reasoning.' },
      { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (Fast)' },
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct' },
      { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash' },
      { id: 'openrouter/auto', label: 'OpenRouter Auto (router picks)' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Cloud answer synthesis via the Claude Messages API.',
    requiresApiKey: true,
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-3-5-sonnet-20241022',
    supportsReasoningToggle: false,
    models: [
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Recommended)' },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Fastest)' },
      { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Deep Analysis)' },
    ],
  },
  {
    id: 'local',
    label: 'Local Streaming Generator',
    description: 'Offline built-in generator. No key, no network, instant.',
    requiresApiKey: false,
    defaultModel: 'local',
    supportsReasoningToggle: false,
    models: [{ id: 'local', label: 'Built-in offline generator' }],
  },
] as const;

export const DEFAULT_LLM_PROVIDER: LlmProviderId = 'deepseek';

export function getLlmProviderEntry(id: string | undefined): LlmProviderCatalogEntry | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

export function getLlmProviderLabel(id: string | undefined): string {
  return getLlmProviderEntry(id)?.label ?? getLlmProviderEntry(DEFAULT_LLM_PROVIDER)!.label;
}
