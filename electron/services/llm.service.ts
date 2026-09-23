import { Question, AnswerChunk, ContextProfile } from '@shared/ipc';
import { DEFAULT_LLM_PROVIDER, LlmProviderId, getLlmProviderLabel } from '@shared/llm-provider-catalog';
import { LlmRegistry } from './llm/llm-registry';
import { LlmProviderRequest, LlmStreamResult } from './llm/llm-provider.interface';

export interface LlmStreamOptions {
  mode?: 'short' | 'detailed' | 'simple';
  profile?: ContextProfile;
  apiKey?: string;
  providerId?: LlmProviderId;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  knowledgeSnippets?: { title: string; snippet: string }[];
}

export interface ILlmService {
  generateAnswerStream(
    question: Question,
    recentTranscript: string[],
    options: LlmStreamOptions,
    onChunk: (chunk: AnswerChunk) => void
  ): Promise<void>;
  getProviderName(): string;
}

interface BuiltPrompts {
  systemPrompt: string;
  userPrompt: string;
}

const STREAM_TIMEOUT_MS = 30000;

/**
 * Provider-agnostic LLM facade. Selects a provider from the registry, builds a
 * shared prompt, and streams the answer. Falls back to the offline local
 * generator when a cloud provider is unconfigured or errors.
 */
export class LlmService implements ILlmService {
  private readonly registry = new LlmRegistry();
  private providerName = getLlmProviderLabel(DEFAULT_LLM_PROVIDER);

  getProviderName(): string {
    return this.providerName;
  }

  setProviderName(name: string): void {
    this.providerName = name;
  }

  async generateAnswerStream(
    question: Question,
    recentTranscript: string[],
    options: LlmStreamOptions = {},
    onChunk: (chunk: AnswerChunk) => void
  ): Promise<void> {
    const mode = options.mode || 'short';
    const { systemPrompt, userPrompt } = this.buildPrompts(question, recentTranscript, options);

    const requestedId = options.providerId || DEFAULT_LLM_PROVIDER;
    let provider = this.registry.get(requestedId);

    if (!provider) {
      console.warn(`[LlmService] Unknown provider "${requestedId}", using local generator.`);
      provider = this.registry.get('local');
    }

    if (provider && provider.requiresApiKey && !options.apiKey) {
      console.warn(`[LlmService] No API key for "${provider.id}", using local generator.`);
      provider = this.registry.get('local');
    }

    const request: LlmProviderRequest = {
      question: question.text,
      recentTranscript,
      systemPrompt,
      userPrompt,
      mode,
      profile: options.profile,
      knowledgeSnippets: options.knowledgeSnippets,
      model: options.model || 'deepseek-flash',
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.3,
      maxTokens: options.maxTokens || 500,
      apiKey: options.apiKey,
      thinkingEnabled: options.thinkingEnabled,
    };

    const emit = (text: string) => onChunk({ questionId: question.id, delta: text, mode });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

    try {
      const result = await provider!.streamAnswer({ ...request, signal: controller.signal }, emit);
      this.emitComplete(question.id, mode, result, onChunk);
    } catch (err) {
      console.warn(`[LlmService] Provider "${provider?.id}" failed, falling back to local generator:`, err);
      const fallback = this.registry.get('local');
      if (fallback) {
        const result = await fallback.streamAnswer({ ...request, signal: undefined }, emit);
        this.emitComplete(question.id, mode, result, onChunk);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private emitComplete(
    questionId: string,
    mode: 'short' | 'detailed' | 'simple',
    result: LlmStreamResult | void,
    onChunk: (chunk: AnswerChunk) => void
  ): void {
    onChunk({ questionId, delta: '', isComplete: true, mode, code: result?.code });
  }

  private buildPrompts(
    question: Question,
    recentTranscript: string[],
    options: LlmStreamOptions
  ): BuiltPrompts {
    const mode = options.mode || 'short';
    const profile = options.profile;

    const rolePrompt = profile?.role ? `User Role: ${profile.role}.\n` : '';
    const projectPrompt = profile?.projectSummary ? `Project Context: ${profile.projectSummary}\n` : '';
    const glossaryPrompt = profile?.glossary?.length
      ? `Domain Glossary: ${profile.glossary.join(', ')}.\n`
      : '';
    const tonePrompt = profile?.tone ? `Tone: ${profile.tone.toUpperCase()}.\n` : '';

    const systemPrompt = `You are MeetVision AI, an expert meeting assistant providing concise talking points to the user in real time.
${rolePrompt}${projectPrompt}${glossaryPrompt}${tonePrompt}
Mode: ${mode.toUpperCase()}.
Formatting rules:
- Provide 3 to 5 concise bullet points.
- Tailor the depth and perspective to the user's role and domain context.
- Maintain the specified tone (${profile?.tone || 'concise'}).
- Each bullet point must begin with "• ".
- If the question asks for code or syntax, include a short code block at the end.
- Do not include greetings, pleasantries, or markdown headers.`;

    const knowledgeText =
      options.knowledgeSnippets && options.knowledgeSnippets.length > 0
        ? `Relevant Knowledge Base Documentation:\n${options.knowledgeSnippets
            .map((s) => `[Doc: ${s.title}]\n${s.snippet}`)
            .join('\n\n')}\n\n`
        : '';

    const contextText =
      recentTranscript.length > 0
        ? `Recent meeting context:\n${recentTranscript.join('\n')}\n\n`
        : '';

    return {
      systemPrompt,
      userPrompt: `${knowledgeText}${contextText}Question asked: "${question.text}"`,
    };
  }
}
