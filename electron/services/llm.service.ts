import { Question, AnswerChunk, ContextProfile, CodeLanguage } from '@shared/ipc';
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
  codeLanguage?: CodeLanguage;
  knowledgeSnippets?: { title: string; snippet: string }[];
  screenContext?: string;
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

const STREAM_TIMEOUT_MS = 45000;

type AnswerMode = 'short' | 'detailed' | 'simple';

/**
 * Question intent. The intent selects the answer's structure and a base token
 * budget, so a system-design or coding question is not forced into talking-point
 * bullets.
 */
type AnswerIntent = 'talking-points' | 'design' | 'coding';

/** Per-mode guidance for talking-point answers. */
const MODE_INSTRUCTIONS: Record<AnswerMode, { bullets: string; style: string }> = {
  short: {
    bullets: '3 bullet points',
    style: 'Keep each bullet to one tight line (about 15 words) and lead with the single most useful fact.',
  },
  detailed: {
    bullets: '5 to 7 bullet points',
    style:
      'Include concrete specifics such as numbers, names, ordered steps, trade-offs, and a short example or caveat where it helps.',
  },
  simple: {
    bullets: '2 to 3 bullet points',
    style:
      'Use plain, everyday language and short sentences. Avoid jargon and unexplained acronyms; if a term is needed, explain it in a few words.',
  },
};

const INTENT_KEYWORDS: Record<'coding' | 'design', string[]> = {
  coding: [
    'array', 'string', 'linked list', 'tree', 'graph', 'dynamic programming', 'dp',
    'binary search', 'sort', 'sorting', 'complexity', 'big o', 'leetcode', 'write a function',
    'implement', 'algorithm', 'recursion', 'recursive', 'hashmap', 'hash map', 'stack', 'queue',
    'heap', 'regex', 'debug', 'compile', 'syntax error', 'time limit', 'two pointer',
    'sliding window', 'bfs', 'dfs', 'trie', 'memoization', 'greedy',
  ],
  design: [
    'design', 'architect', 'architecture', 'system design', 'scal', 'throughput', 'latency',
    'trade-off', 'tradeoff', 'microservice', 'database', 'schema', 'cache', 'load balanc',
    'kafka', 'redis', 'queue', 'sharding', 'partition', 'consistency', 'availability',
    'cap theorem', 'cdn', 'rate limit', 'api gateway', 'deploy', 'migration', 'capacity',
    'fault toleran', 'message broker', 'service mesh', 'high availability', 'replication',
  ],
};

/** Base output-token ceiling per intent; the mode scales it up or down. */
const INTENT_BASE_TOKENS: Record<AnswerIntent, number> = {
  'talking-points': 500,
  design: 1300,
  coding: 1000,
};

const MODE_TOKEN_FACTOR: Record<AnswerMode, number> = { short: 0.8, simple: 0.65, detailed: 1.3 };

const HARD_TOKEN_CEILING = 1800;
const MIN_TOKEN_FLOOR = 300;

const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  auto: 'Auto',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  java: 'Java',
  cpp: 'C++',
  csharp: 'C#',
  go: 'Go',
  rust: 'Rust',
};

/** Scores the question text and picks an answer intent. */
export function classifyQuestion(text: string): AnswerIntent {
  const haystack = (text || '').toLowerCase();
  const score = (words: string[]) => words.reduce((n, w) => (haystack.includes(w) ? n + 1 : n), 0);

  const coding = score(INTENT_KEYWORDS.coding);
  const design = score(INTENT_KEYWORDS.design);

  if (coding === 0 && design === 0) return 'talking-points';
  if (coding >= design) return 'coding';
  return 'design';
}

/** Dynamic output-token ceiling: intent base × mode factor, floored at the user's setting. */
export function tokensFor(intent: AnswerIntent, mode: AnswerMode, userCeiling?: number): number {
  const base = Math.round(INTENT_BASE_TOKENS[intent] * MODE_TOKEN_FACTOR[mode]);
  const userFloor = Math.min(Math.max(userCeiling || 0, MIN_TOKEN_FLOOR), HARD_TOKEN_CEILING);
  return Math.max(Math.min(base, HARD_TOKEN_CEILING), userFloor);
}

/**
 * Provider-agnostic LLM facade. Classifies the question, selects a matching
 * prompt/token budget, then streams the answer through the chosen provider.
 * Falls back to the offline local generator when a cloud provider is
 * unconfigured or errors.
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
    const intent = classifyQuestion(question.text);
    const { systemPrompt, userPrompt } = this.buildPrompts(question, recentTranscript, options, intent);

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
      maxTokens: tokensFor(intent, mode, options.maxTokens),
      apiKey: options.apiKey,
      thinkingEnabled: options.thinkingEnabled,
    };

    let streamedChars = 0;
    const emit = (text: string) => {
      streamedChars += (text || '').length;
      onChunk({ questionId: question.id, delta: text, mode });
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    const promptLength = (systemPrompt?.length || 0) + (userPrompt?.length || 0);
    const finalPrompt = `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER CONTEXT & TARGET QUESTION]\n${userPrompt}`;

    try {
      const result = await provider!.streamAnswer({ ...request, signal: controller.signal }, emit);
      this.emitComplete(question.id, mode, result, onChunk, promptLength, streamedChars, finalPrompt);
    } catch (err) {
      console.warn(`[LlmService] Provider "${provider?.id}" failed, falling back to local generator:`, err);
      const fallback = this.registry.get('local');
      if (fallback) {
        const result = await fallback.streamAnswer({ ...request, signal: undefined }, emit);
        this.emitComplete(question.id, mode, result, onChunk, promptLength, streamedChars, finalPrompt);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private emitComplete(
    questionId: string,
    mode: 'short' | 'detailed' | 'simple',
    result: LlmStreamResult | void,
    onChunk: (chunk: AnswerChunk) => void,
    promptLength: number = 0,
    streamedLength: number = 0,
    finalPrompt?: string
  ): void {
    const finish = result?.finishReason;
    const estInput = Math.max(1, Math.round(promptLength / 4));
    const estOutput = Math.max(1, Math.round(streamedLength / 4));

    const inputTokens = result?.inputTokens ?? estInput;
    const outputTokens = result?.outputTokens ?? estOutput;
    const totalTokens = result?.totalTokens ?? (inputTokens + outputTokens);

    console.log(
      `[LlmService] Answer completed for question "${questionId}" | Tokens: total=${totalTokens}, input=${inputTokens}, output=${outputTokens}`
    );

    onChunk({
      questionId,
      delta: '',
      isComplete: true,
      mode,
      code: result?.code,
      truncated: finish === 'length' || finish === 'max_tokens',
      totalTokens,
      inputTokens,
      outputTokens,
      finalPrompt,
    });
  }

  private buildPrompts(
    question: Question,
    recentTranscript: string[],
    options: LlmStreamOptions,
    intent: AnswerIntent
  ): BuiltPrompts {
    const mode = options.mode || 'short';
    const profile = options.profile;
    const tone = profile?.tone || 'concise';

    const contextBlock = [
      profile?.role ? `User Role: ${profile.role}.` : '',
      profile?.projectSummary ? `Project Context: ${profile.projectSummary}` : '',
      profile?.glossary?.length ? `Domain Glossary: ${profile.glossary.join(', ')}.` : '',
      profile?.tone ? `Tone: ${profile.tone.toUpperCase()}.` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const knowledgeText =
      options.knowledgeSnippets && options.knowledgeSnippets.length > 0
        ? `[Relevant Knowledge Base Documentation]\n${options.knowledgeSnippets
            .map((s) => `[Doc: ${s.title}]\n${s.snippet}`)
            .join('\n\n')}\n\n`
        : '';

    const screenText =
      options.screenContext && options.screenContext.trim().length > 0
        ? `[Visible Screen Context (ScreenVision OCR)]\n"""\n${options.screenContext.trim()}\n"""\n\n`
        : '';

    const contextText =
      recentTranscript.length > 0
        ? `[Live Conversation Context (Speaker Turn History)]\n${recentTranscript.join('\n')}\n\n`
        : '';

    const speakerTag = question.speaker ? ` (Asked by: ${question.speaker})` : '';

    return {
      systemPrompt: this.systemPromptFor(intent, mode, contextBlock, tone, options.codeLanguage),
      userPrompt: `${knowledgeText}${screenText}${contextText}[Target Question / Statement to Answer]${speakerTag}:\n"${question.text}"`,
    };
  }

  private systemPromptFor(
    intent: AnswerIntent,
    mode: AnswerMode,
    contextBlock: string,
    tone: string,
    codeLanguage?: CodeLanguage
  ): string {
    const context = contextBlock ? `\n${contextBlock}\n` : '';

    if (intent === 'coding') {
      const language = codeLanguage || 'auto';
      const fence = language === 'auto' ? '' : language;
      const languageRule =
        language === 'auto'
          ? 'Choose the most widely expected language for the question and state it (prefer Python unless the question names a language).'
          : `Write the solution in ${CODE_LANGUAGE_LABELS[language]}.`;

      return `You are MeetVision AI, a senior engineer answering a CODING / DSA question in real time.${context}
Respond in this exact order:
- Approach: 2-4 bullets (each beginning with "• ") explaining the algorithm and why it works.
- Code: exactly ONE complete, runnable solution inside a single fenced block, e.g. \`\`\`${fence} ... \`\`\`. Do not split the solution across multiple blocks and do not use pseudo-code.
- Complexity: one line, "Time: O(...) | Space: O(...)".
- Edge cases: 2-4 bullets.
${languageRule}
Maintain a ${tone} tone. No greetings or filler.`;
    }

    if (intent === 'design') {
      return `You are MeetVision AI, a senior software architect answering a SYSTEM DESIGN question in real time.${context}
Respond in short labelled sections:
- Overview: 1-2 sentences.
- Key components: 3-5 bullets (each beginning with "• ").
- Data flow: how a request moves through the system, 2-4 bullets.
- Trade-offs: consistency vs availability, cost, and scaling, 2-4 bullets.
- Risks & edge cases: 2-4 bullets.
Add at most ONE fenced code or schema block (\`\`\`lang ... \`\`\`) if it materially helps.
Be concrete and specific with real numbers or named technologies where possible. Maintain a ${tone} tone. No greetings or filler.`;
    }

    const modeSpec = MODE_INSTRUCTIONS[mode];
    return `You are MeetVision AI, an expert meeting assistant providing real-time talking points.${context}
Answer depth: ${mode.toUpperCase()} — provide ${modeSpec.bullets}.
Style:
- ${modeSpec.style}
- Tailor the depth and perspective to the user's role and domain context.
- Maintain the specified tone (${tone}).
- Each bullet point must begin with "• ".
- Lead with the direct answer. No greetings, filler, or markdown headers.
- If the question asks for code or syntax, include a short fenced code block at the end.`;
  }
}
