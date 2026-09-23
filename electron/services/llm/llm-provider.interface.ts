import { ContextProfile } from '@shared/ipc';
import { LlmProviderId } from '@shared/llm-provider-catalog';

export interface LlmProviderRequest {
  question: string;
  recentTranscript: string[];
  systemPrompt: string;
  userPrompt: string;
  mode: 'short' | 'detailed' | 'simple';
  profile?: ContextProfile;
  knowledgeSnippets?: { title: string; snippet: string }[];
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey?: string;
  thinkingEnabled?: boolean;
  signal?: AbortSignal;
}

export interface LlmStreamResult {
  /** Optional code snippet produced alongside the streamed bullets. */
  code?: string;
}

export interface ILlmProvider {
  readonly id: LlmProviderId;
  readonly label: string;
  readonly requiresApiKey: boolean;

  /**
   * Streams the answer text. Each call to `onDelta` appends to the answer.
   * Resolves when the stream completes, optionally returning extra fields.
   */
  streamAnswer(
    request: LlmProviderRequest,
    onDelta: (text: string) => void
  ): Promise<LlmStreamResult | void>;
}
