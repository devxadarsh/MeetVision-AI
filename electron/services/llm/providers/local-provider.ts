import { LlmProviderId } from '@shared/llm-provider-catalog';
import { ILlmProvider, LlmProviderRequest, LlmStreamResult } from '../llm-provider.interface';

/**
 * Offline built-in generator. Produces canned, context-aware talking points
 * with no network access. Used as the default provider and as the automatic
 * fallback when a cloud provider is selected but unavailable.
 */
export class LocalProvider implements ILlmProvider {
  readonly id: LlmProviderId = 'local';
  readonly label = 'Local Streaming Generator';
  readonly requiresApiKey = false;

  async streamAnswer(
    request: LlmProviderRequest,
    onDelta: (text: string) => void
  ): Promise<LlmStreamResult | void> {
    const profile = request.profile;
    const tone = profile?.tone || 'concise';
    const rolePrefix = profile?.role ? `[${profile.role}] ` : '';

    const text = request.question.toLowerCase();
    let bullets: string[] = [];
    let code: string | undefined;

    // Prefer Local Knowledge Base (RAG) snippets when matched.
    if (request.knowledgeSnippets && request.knowledgeSnippets.length > 0) {
      const top = request.knowledgeSnippets[0];
      const lines = top.snippet
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 15);

      if (lines.length >= 2) {
        bullets = [`${rolePrefix}[Doc: ${top.title}] ${lines[0]}`, ...lines.slice(1, 4)];
      }
    }

    if (bullets.length === 0 && (text.includes('retry') || text.includes('payment') || text.includes('504'))) {
      if (tone === 'formal') {
        bullets = [
          `${rolePrefix}The payment pipeline employs exponential backoff with full randomized jitter to avoid thundering herd contention.`,
          'Initial retry interval is configured at 500ms with a 2.0x exponent, capped at 4,000ms across 3 attempts.',
          'Execution is strictly limited to idempotent HTTP status codes (500, 502, 503, 504) and transient network disconnects.',
          'Circuit breaker initiates an open state upon 5 consecutive failures, adhering to a 30-second verification probe window.',
        ];
      } else if (tone === 'friendly') {
        bullets = [
          `${rolePrefix}Great news—the payment retry flow is fully automated so customers won't get double billed!`,
          'It retries up to 3 times with exponential backoff (500ms up to 4s) so servers have time to breathe.',
          'Only safe server errors are retried; if anything is off on the client side, it fails fast cleanly.',
          'Our circuit breaker pauses traffic for 30 seconds if an upstream gateway starts misbehaving.',
        ];
      } else {
        bullets = [
          `${rolePrefix}Three retries with jittered exponential backoff: 500ms base, 4s max cap.`,
          'Only retryable server errors (500, 502, 503, 504) are retried; client 4xx errors fail immediately.',
          'Circuit breaker trips after 5 consecutive failures with a 30-second cooldown.',
        ];
        code = 'retry({ count: 3, delay: (err, i) => Math.min(500 * 2 ** i, 4000) })';
      }
    } else if (text.includes('migration') || text.includes('rollout') || text.includes('canary')) {
      if (tone === 'formal') {
        bullets = [
          `${rolePrefix}Phase 1 internal alpha evaluation completed with 0 recorded anomalies across 48 operational hours.`,
          'Phase 2 involves a 10% canary traffic cohort deployment initiating Tuesday 09:00 UTC under automated telemetry alarms.',
          'Automated monitoring thresholds are calibrated to p99 latency (>250ms) and 5xx error rate (>0.1%).',
          'Phase 4 full production cutover is scheduled for Monday with zero planned maintenance downtime.',
        ];
      } else if (tone === 'friendly') {
        bullets = [
          `${rolePrefix}Rollout is tracking super smoothly! Phase 1 internal testing is already 100% green.`,
          'We begin a gentle 10% canary test this Tuesday morning to verify real-world behavior.',
          'By Thursday we expand to 50%, and wrap up full cutover next Monday without any downtime.',
        ];
      } else {
        bullets = [
          `${rolePrefix}Phase 1 internal alpha completed and verified.`,
          'Phase 2: 10% canary cohort rollout starting Tuesday 09:00 UTC.',
          'Phase 3: 50% on Thursday after monitoring p99 latency and error rates.',
          'Phase 4: Full cutover next Monday with automated rollback triggers.',
        ];
      }
    } else if (text.includes('kyc') || text.includes('timeout') || text.includes('fallback')) {
      if (tone === 'formal') {
        bullets = [
          `${rolePrefix}In the event of verification gateway latency, payloads transition to an asynchronous resilient queue.`,
          'A background verification poll executes with a strict 2-minute SLA guarantee.',
          'Users are granted provisional non-sensitive authorization pending final credential resolution.',
        ];
      } else {
        bullets = [
          `${rolePrefix}Enqueue customer verification into an asynchronous processing queue.`,
          'Issue a background webhook check with a 2-minute SLA guarantee.',
          'Grant immediate partial access while background verification resolves.',
        ];
      }
    } else {
      const glossarySnippet = profile?.glossary?.length
        ? `Aligns with domain parameters: ${profile.glossary.slice(0, 3).join(', ')}.`
        : 'Aligned with production architecture guidelines.';

      if (tone === 'formal') {
        bullets = [
          `${rolePrefix}Directly addresses requirements regarding "${request.question.replace(/\?$/, '')}".`,
          glossarySnippet,
          'Validated against current infrastructure constraints with zero regression exposure.',
        ];
      } else if (tone === 'friendly') {
        bullets = [
          `${rolePrefix}Here is the key takeaway on "${request.question.replace(/\?$/, '')}":`,
          glossarySnippet,
          'We have verified this in our staging setup and are ready to proceed with confidence.',
        ];
      } else {
        bullets = [
          `${rolePrefix}Direct response for ${request.question.replace(/\?$/, '')}.`,
          glossarySnippet,
          'Production-tested pattern with minimal regression risk.',
        ];
      }
    }

    // Vary the depth of the offline fallback by answer mode.
    const modeLimit =
      request.mode === 'detailed' ? bullets.length : request.mode === 'simple' ? 2 : 3;
    bullets = bullets.slice(0, Math.max(1, modeLimit));

    const fullText = bullets.map((b) => `• ${b}`).join('\n');
    const words = fullText.split(' ');

    for (let i = 0; i < words.length; i++) {
      onDelta((i === 0 ? '' : ' ') + words[i]);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    const promptLen = (request.systemPrompt?.length || 0) + (request.userPrompt?.length || 0);
    const inputTokens = Math.max(1, Math.round(promptLen / 4));
    const outputTokens = Math.max(1, Math.round(fullText.length / 4));
    const totalTokens = inputTokens + outputTokens;

    return { code, totalTokens, inputTokens, outputTokens };
  }
}
