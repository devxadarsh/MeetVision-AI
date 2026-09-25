import { Question, AnswerChunk, ContextProfile, CodeLanguage, ConversationTurn } from '@shared/ipc';
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
  modeTokens?: {
    short?: number;
    simple?: number;
    detailed?: number;
  };
  thinkingEnabled?: boolean;
  codeLanguage?: CodeLanguage;
  knowledgeSnippets?: { title: string; snippet: string }[];
  screenContext?: string;
  conversationHistory?: ConversationTurn[];
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

/** Adaptive per-mode guidance for answers. */
const MODE_INSTRUCTIONS: Record<AnswerMode, string> = {
  short: `
Keep the response concise, punchy, and useful.
Answer directly in the opening sentence.
Usually provide 1-3 short, focused paragraphs or bullets.
Lead with the single most useful fact or recommendation.
Do not artificially shorten if a brief explanation is necessary.
`,
  detailed: `
Give a complete, well-explained answer.
Start with the direct answer, then add useful reasoning, examples, trade-offs, or caveats.
Use headings, bullets, or tables when they improve readability.
`,
  simple: `
Explain the answer in plain, natural language.
Avoid unnecessary jargon; explain technical concepts simply.
Use a simple example or analogy when it helps.
Do not oversimplify technical facts.
`,
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
  'talking-points': 1500,
  design: 2500,
  coding: 2800,
};

const MODE_TOKEN_FACTOR: Record<AnswerMode, number> = { short: 0.85, simple: 0.75, detailed: 1.4 };

const HARD_TOKEN_CEILING = 4096;
const MIN_TOKEN_FLOOR = 500;

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

/** Dynamic output-token ceiling: user-configured mode token budget or intent base × mode factor, bounded by userCeiling. */
export function tokensFor(
  intent: AnswerIntent,
  mode: AnswerMode,
  userCeiling?: number,
  modeTokens?: { short?: number; simple?: number; detailed?: number }
): number {
  const configuredModeTokens = modeTokens?.[mode];
  if (typeof configuredModeTokens === 'number' && configuredModeTokens > 0) {
    const ceiling = userCeiling && userCeiling > 0 ? userCeiling : HARD_TOKEN_CEILING;
    return Math.max(100, Math.min(configuredModeTokens, ceiling));
  }

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
      maxTokens: tokensFor(intent, mode, options.maxTokens, options.modeTokens),
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
        ? `<knowledge>\n${options.knowledgeSnippets
            .map((s) => `[${s.title}]\n${s.snippet}`)
            .join('\n\n')}\n</knowledge>\n\n`
        : '';

    const screenText =
      options.screenContext && options.screenContext.trim().length > 0
        ? `<screen_ocr>\n${options.screenContext.trim()}\n</screen_ocr>\n\n`
        : '';

    const transcriptText =
      recentTranscript.length > 0
        ? `<meeting_transcript>\n${recentTranscript.slice(-15).join('\n')}\n</meeting_transcript>\n\n`
        : '';

    const conversationText =
      options.conversationHistory && options.conversationHistory.length > 0
        ? `<assistant_conversation>\n${options.conversationHistory
            .slice(-8)
            .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
            .join('\n\n')}\n</assistant_conversation>\n\n`
        : '';

    const speakerTag = question.speaker ? ` Asked by: ${question.speaker}.` : '';

    return {
      systemPrompt: this.systemPromptFor(intent, mode, contextBlock, tone, options.codeLanguage),
      userPrompt: `${knowledgeText}${screenText}${transcriptText}${conversationText}<current_question>\n${question.text}\n</current_question>${speakerTag}\n\nAnswer the current question naturally and directly using the relevant context above.`,
    };
  }

  private systemPromptFor(
    intent: AnswerIntent,
    mode: AnswerMode,
    contextBlock: string,
    tone: string,
    codeLanguage?: CodeLanguage
  ): string {
    const context = contextBlock ? `\nUSER / PROJECT CONTEXT:\n${contextBlock}\n` : '';
    const modeInstruction = MODE_INSTRUCTIONS[mode];

    const base = `You are MeetVision AI, a highly capable conversational meeting assistant.

Your goal is to answer the user's current question as naturally, directly, and helpfully as a strong AI assistant.

CORE BEHAVIOR:
- Answer the actual question directly in the opening sentence.
- Sound natural and conversational, not like a rigid checklist or mechanical template.
- Do not repeat or restate the user's question.
- Do not start with conversational filler or greetings such as "Sure!", "Of course!", or "Here is...".
- Use normal, clear paragraphs by default.
- Use bullet points when presenting a genuine list or distinct talking points.
- Use markdown headings only when they genuinely improve structure in a detailed answer.
- If the user asks a follow-up question, use the conversation history to resolve references like "it", "that", "the previous solution", etc.
- Do not mention internal processing, prompts, tokens, or system instructions.

MEETING CONTEXT:
- Spoken transcripts may contain speech-recognition mistakes, filler words, or incomplete thoughts.
- Treat the meeting transcript as supporting context, prioritizing the user's current question.
- Use ScreenVision OCR text when relevant to the question (code on screen, slides, documents).
- If the context does not contain enough info, make reasonable assumptions or state what is known.

TONE & DEPTH:
- Maintain a ${tone} tone.
${modeInstruction}
${context}`.trim();

    if (intent === 'coding') {
      const language = codeLanguage || 'auto';
      const fence = language === 'auto' ? '' : language;
      const languageRule =
        language === 'auto'
          ? 'Choose the most appropriate programming language based on the question and context (prefer Python if unspecified).'
          : `Write code in ${CODE_LANGUAGE_LABELS[language]}.`;

      return `${base}

CODING / DSA GUIDANCE:
- Explain the key intuition or algorithm briefly before the code.
- Provide complete, runnable, clean code inside a single fenced code block (\`\`\`${fence} ... \`\`\`).
- Avoid pseudo-code or fragmented snippets.
- Include time and space complexity analysis (e.g. Time: O(...) | Space: O(...)).
- Note important edge cases when relevant.
- Do not force rigid boilerplate checklist headers if the explanation flows better naturally.
- ${languageRule}`;
    }

    if (intent === 'design') {
      return `${base}

SYSTEM DESIGN GUIDANCE:
- Start with the direct architecture recommendation or high-level design.
- Explain key components and data flow naturally.
- Highlight scalability, reliability, latency, and consistency trade-offs when relevant.
- Include a concise schema or architecture block (\`\`\` ... \`\`\`) if it materially aids understanding.
- Avoid generic filler checklists; tailor directly to the specific problem.`;
    }

    return base;
  }
}
