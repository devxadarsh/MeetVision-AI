import { Question, TranscriptSegment } from '@shared/ipc';

export class QuestionDetector {
  private recentQuestions: Array<{ text: string; timestamp: number }> = [];
  private readonly deduplicationWindowMs = 60000; // 60 seconds

  private readonly WH_WORDS = [
    'what',
    'why',
    'how',
    'when',
    'where',
    'who',
    'which',
    'whose',
  ];

  private readonly AUXILIARY_PHRASES = [
    'can you',
    'could you',
    'do we',
    'does it',
    'did we',
    'is there',
    'are we',
    'should we',
    'would you',
    'would it',
    'have you',
    'has anyone',
    'will we',
    'can anyone',
  ];

  evaluate(segment: TranscriptSegment): Question | null {
    if (!segment.isFinal) return null;

    const trimmed = segment.text.trim();
    if (!trimmed) return null;

    // Must be at least 4 words to avoid single-word interjections like "what?"
    const words = trimmed.split(/\s+/);
    if (words.length < 4) return null;

    const lower = trimmed.toLowerCase();
    const isQuestion =
      trimmed.endsWith('?') ||
      this.WH_WORDS.some((w) => lower.startsWith(w + ' ')) ||
      this.AUXILIARY_PHRASES.some((phrase) => lower.startsWith(phrase) || lower.includes(', ' + phrase));

    if (!isQuestion) return null;

    // Check for recent duplicate
    const now = Date.now();
    this.cleanupOldQuestions(now);

    const isDuplicate = this.recentQuestions.some((q) => {
      return this.isSimilar(lower, q.text);
    });

    if (isDuplicate) return null;

    // Record this question for de-duplication
    this.recentQuestions.push({ text: lower, timestamp: now });

    // Ensure clean question formatting ending with '?'
    const cleanText = trimmed.endsWith('?') ? trimmed : `${trimmed}?`;

    return {
      id: `q-${now}-${Math.random().toString(36).substring(2, 6)}`,
      sessionId: 'session-live',
      text: cleanText,
      askedAt: now,
      status: 'answering',
    };
  }

  private isSimilar(a: string, b: string): boolean {
    if (a === b) return true;
    // Simple word-overlap / substring check
    if (a.includes(b) || b.includes(a)) return true;
    return false;
  }

  private cleanupOldQuestions(now: number): void {
    this.recentQuestions = this.recentQuestions.filter(
      (q) => now - q.timestamp < this.deduplicationWindowMs
    );
  }
}
