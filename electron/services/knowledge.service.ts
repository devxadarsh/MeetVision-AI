import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { KnowledgeDoc } from '@shared/ipc';

export interface RetrievedSnippet {
  docId: string;
  title: string;
  snippet: string;
  score: number;
}

const DEFAULT_DOCS: Omit<KnowledgeDoc, 'id' | 'updatedAt'>[] = [
  {
    title: 'Payment Gateway & Retry Policy Architecture',
    category: 'Architecture',
    content: `The payment processing engine implements jittered exponential backoff retries.
Initial retry delay is 500 milliseconds, doubling each attempt up to a maximum cap of 4,000 milliseconds.
Retries are only attempted for idempotent HTTP status codes: 500 (Internal Server Error), 502 (Bad Gateway), 503 (Service Unavailable), and 504 (Gateway Timeout).
4xx client errors (e.g. 400 Bad Request, 401 Unauthorized, 403 Forbidden, 422 Unprocessable) fail immediately without retrying to prevent duplicate charges.
A circuit breaker opens if 5 consecutive failure events occur within a 60-second sliding window, pausing requests for a 30-second cooling off period.`,
  },
  {
    title: 'v2 Microservices Canary Rollout Plan',
    category: 'Deployment',
    content: `Phase 1: Alpha internal dogfooding with engineering team (completed).
Phase 2: 10% canary traffic cohort starting Tuesday 09:00 UTC with automated Datadog latency and error-budget alarms.
Phase 3: 50% traffic cohort on Thursday after reviewing p99 response times (target < 80ms) and error rates (< 0.05%).
Phase 4: 100% full production cutover next Monday with automated blue-green rollback triggers. Zero downtime required.`,
  },
  {
    title: 'Database Caching and Redis Invalidation Strategy',
    category: 'Database',
    content: `Redis cluster caching uses a read-through cache with a 15-minute standard TTL.
Write operations trigger proactive cache invalidation via pub/sub messaging across service instances.
p99 read query latency on user profile and product catalog endpoints is maintained below 45ms.
Database replica pool utilization is kept below 30% average CPU.`,
  },
];

export class KnowledgeService {
  private filePath: string;
  private docs: KnowledgeDoc[] = [];

  constructor() {
    try {
      const userDataDir = app.getPath('userData');
      this.filePath = path.join(userDataDir, 'knowledge_base.json');
      this.load();
    } catch {
      // Fallback for isolated unit testing
      this.filePath = path.join(process.cwd(), 'knowledge_base.json');
      this.load();
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.docs = JSON.parse(raw);
      } else {
        // Seed default documentation for immediate out-of-the-box local RAG
        this.docs = DEFAULT_DOCS.map((d, index) => ({
          ...d,
          id: `doc_${Date.now()}_${index}`,
          updatedAt: Date.now(),
        }));
        this.save();
      }
    } catch (err) {
      console.warn('[KnowledgeService] Failed to load knowledge base file:', err);
      this.docs = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.docs, null, 2), 'utf8');
    } catch (err) {
      console.error('[KnowledgeService] Failed to persist knowledge base:', err);
    }
  }

  listDocs(): KnowledgeDoc[] {
    return [...this.docs];
  }

  addDoc(docInput: Omit<KnowledgeDoc, 'id' | 'updatedAt'>): KnowledgeDoc {
    const doc: KnowledgeDoc = {
      ...docInput,
      id: `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      updatedAt: Date.now(),
    };
    this.docs.unshift(doc);
    this.save();
    return doc;
  }

  removeDoc(id: string): boolean {
    const prevLen = this.docs.length;
    this.docs = this.docs.filter((d) => d.id !== id);
    if (this.docs.length !== prevLen) {
      this.save();
      return true;
    }
    return false;
  }

  clearAll(): void {
    this.docs = [];
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {}
  }

  /**
   * Simple, fast, zero-dependency BM25-style keyword matching algorithm
   * to retrieve the top-k most relevant knowledge base snippets for a meeting question.
   */
  retrieveRelevantSnippets(query: string, topK: number = 3): RetrievedSnippet[] {
    if (!query || this.docs.length === 0) return [];

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const candidates: RetrievedSnippet[] = [];

    for (const doc of this.docs) {
      // Chunk document into paragraphs / sentences
      const paragraphs = doc.content
        .split(/\n\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 20);

      const chunks = paragraphs.length > 0 ? paragraphs : [doc.content];

      for (const chunk of chunks) {
        const chunkTokens = this.tokenize(chunk);
        const titleTokens = this.tokenize(doc.title);

        let matchCount = 0;
        let queryCoverage = 0;

        for (const token of queryTokens) {
          const inChunk = chunkTokens.includes(token);
          const inTitle = titleTokens.includes(token);
          if (inTitle) {
            matchCount += 3; // Boost title matches
            queryCoverage++;
          } else if (inChunk) {
            matchCount += 1;
            queryCoverage++;
          }
        }

        if (matchCount > 0) {
          const lengthPenalty = Math.log(chunkTokens.length + 1) || 1;
          const score = (matchCount * (queryCoverage / queryTokens.length)) / lengthPenalty;

          candidates.push({
            docId: doc.id,
            title: doc.title,
            snippet: chunk,
            score,
          });
        }
      }
    }

    // Rank candidates by descending score
    candidates.sort((a, b) => b.score - a.score);

    // Return top-k unique snippets
    const seen = new Set<string>();
    const topResults: RetrievedSnippet[] = [];

    for (const item of candidates) {
      if (!seen.has(item.snippet)) {
        seen.add(item.snippet);
        topResults.push(item);
        if (topResults.length >= topK) break;
      }
    }

    return topResults;
  }

  private tokenize(text: string): string[] {
    const STOP_WORDS = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'with', 'to',
      'for', 'of', 'by', 'as', 'what', 'how', 'why', 'when', 'where', 'who', 'does',
      'do', 'can', 'could', 'would', 'should', 'are', 'we', 'you', 'it', 'this', 'that',
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  }
}
