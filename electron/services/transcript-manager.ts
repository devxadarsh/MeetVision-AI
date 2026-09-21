import { TranscriptSegment } from '@shared/ipc';

export type TranscriptListener = (segment: TranscriptSegment) => void;

export class TranscriptManager {
  private listeners: Set<TranscriptListener> = new Set();
  private history: TranscriptSegment[] = [];
  private maxHistory = 300; // Ring buffer to prevent memory growth during long meetings
  private lastTextBySpeaker: Map<string, string> = new Map();

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(segment: TranscriptSegment): void {
    // 1. Sanitize text
    let cleanText = (segment.text || '')
      .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|APPLAUSE|SILENCE)\]/gi, '')
      .replace(/\((?:blank_audio|music|noise|applause|silence|inaudible)\)/gi, '')
      .replace(/<\|.*?\|>/g, '') // remove special tokens
      .trim();

    const speaker = segment.speaker || 'Other';

    if (!cleanText) {
      if (segment.isFinal) {
        // Broadcast empty final segment so UI clears interim indicator
        const emptyFinal: TranscriptSegment = { ...segment, text: '', speaker };
        for (const listener of this.listeners) {
          try {
            listener(emptyFinal);
          } catch {}
        }
      }
      return;
    }

    // 2. Repetition & Duplicate Suppression for final segments
    if (segment.isFinal) {
      const lastSeen = this.lastTextBySpeaker.get(speaker);
      if (lastSeen && lastSeen.toLowerCase() === cleanText.toLowerCase()) {
        return; // Skip identical duplicate phrase
      }
      this.lastTextBySpeaker.set(speaker, cleanText);
    }

    const sanitizedSegment: TranscriptSegment = {
      ...segment,
      text: cleanText,
      speaker,
    };

    // 3. Ring buffer history: only keep final transcribed segments
    if (sanitizedSegment.isFinal) {
      this.history.push(sanitizedSegment);
      if (this.history.length > this.maxHistory) {
        this.history.splice(0, this.history.length - this.maxHistory);
      }
    }

    // 4. Notify all subscribers (UI windows, QuestionDetector)
    for (const listener of this.listeners) {
      try {
        listener(sanitizedSegment);
      } catch (err) {
        console.warn('[TranscriptManager] Error in transcript listener:', err);
      }
    }
  }

  getHistory(): TranscriptSegment[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
    this.lastTextBySpeaker.clear();
    this.listeners.clear();
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}
