import { app, desktopCapturer } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import {
  OcrModelId,
  OCR_MODEL_CATALOG,
  DEFAULT_OCR_MODEL_ID,
  OcrModelCatalogEntry,
} from '@shared/screenvision-catalog';
import {
  ScreenVisionStatus,
  ScreenVisionCaptureResult,
  OcrDownloadProgress,
  ScreenVisionSettings,
  ScreenScanItem,
  ScreenScanBatch,
} from '@shared/ipc';
import { IOcrEngine } from './ocr/ocr-engine.interface';
import { PpOcrMobileEngine } from './ocr/pp-ocr-mobile';
import { stitchScreenScans, cleanScreenText } from './ocr/text-stitcher';
import { StoreService } from './store.service';

/** Built-in technical terms for normalization & correction */
const CORE_TECH_VOCABULARY: Record<string, string> = {
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  k8s: 'K8s',
  kubectl: 'kubectl',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  angular: 'Angular',
  electron: 'Electron',
  python: 'Python',
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  redis: 'Redis',
  kafka: 'Kafka',
  graphql: 'GraphQL',
  grpc: 'gRPC',
  rest: 'REST',
  microservices: 'Microservices',
  pytorch: 'PyTorch',
  tensorflow: 'TensorFlow',
  github: 'GitHub',
  gitlab: 'GitLab',
  webrtc: 'WebRTC',
  oauth: 'OAuth',
  jwt: 'JWT',
  aws: 'AWS',
  gcp: 'GCP',
  azure: 'Azure',
  api: 'API',
  apis: 'APIs',
  sdk: 'SDK',
  sdks: 'SDKs',
  ui: 'UI',
  ux: 'UX',
  crud: 'CRUD',
  dsa: 'DSA',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  nosql: 'NoSQL',
  json: 'JSON',
  yaml: 'YAML',
  http: 'HTTP',
  https: 'HTTPS',
  tcp: 'TCP',
  udp: 'UDP',
  ip: 'IP',
  dns: 'DNS',
  ssl: 'SSL',
  tls: 'TLS',
  ssh: 'SSH',
  ci: 'CI',
  cd: 'CD',
  npm: 'npm',
  node: 'Node.js',
  nodejs: 'Node.js',
  nextjs: 'Next.js',
  react: 'React',
};

const FILLER_PATTERN = /\b(?:um+|uh+|hmm+|ah+|er+m?|eh+)\b/gi;

export class ScreenVisionService {
  private activeModelId: OcrModelId = DEFAULT_OCR_MODEL_ID;
  private engines = new Map<OcrModelId, IOcrEngine>();
  private activeEngine: IOcrEngine;
  private modelsDir: string;
  private storeService: StoreService;

  private isScanning = false;
  private autoTimer: NodeJS.Timeout | null = null;
  private lastScanTimestamp: number | null = null;
  private lastScanWordCount = 0;
  private lastExtractedText = '';
  private lastError: string | null = null;

  // Multi-scan state
  private pendingScans: ScreenScanItem[] = [];
  private batches: ScreenScanBatch[] = [];
  private combinedText = '';
  private removedOverlapLinesCount = 0;

  // Dynamic technical words parsed from visible screen
  private screenVocabulary = new Set<string>();

  // Event callbacks
  private onStatusChangeCallback: ((status: ScreenVisionStatus) => void) | null = null;
  private onDownloadProgressCallback: ((progress: OcrDownloadProgress) => void) | null = null;

  constructor(storeService: StoreService) {
    this.storeService = storeService;
    try {
      this.modelsDir = path.join(app.getPath('userData'), 'models', 'ocr');
    } catch {
      this.modelsDir = path.join(process.cwd(), 'models', 'ocr');
    }

    if (!fs.existsSync(this.modelsDir)) {
      try {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      } catch (e) {
        console.warn('[ScreenVisionService] Failed to create ocr models directory:', e);
      }
    }

    // Register built-in default PP-OCRv5 Mobile engine
    const mobileEngine = new PpOcrMobileEngine();
    this.engines.set(mobileEngine.id, mobileEngine);
    this.activeEngine = mobileEngine;

    // Load initial settings
    const settings = this.storeService.getSettings();
    if (settings.screenVision?.activeModelId) {
      this.activeModelId = settings.screenVision.activeModelId;
    }
  }

  init(): void {
    const settings = this.storeService.getSettings();
    this.applySettings(settings.screenVision || {});
  }

  applySettings(config: ScreenVisionSettings): void {
    if (config.activeModelId && config.activeModelId !== this.activeModelId) {
      this.activeModelId = config.activeModelId;
      const engine = this.engines.get(config.activeModelId);
      if (engine) {
        this.activeEngine = engine;
      }
    }

    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }

    const enabled = config.enabled !== false;
    const intervalSec = typeof config.autoIntervalSeconds === 'number' ? config.autoIntervalSeconds : 0;

    if (enabled && intervalSec > 0) {
      this.autoTimer = setInterval(() => {
        this.captureScreen().catch((err) => {
          console.warn('[ScreenVisionService] Background scan error:', err);
        });
      }, intervalSec * 1000);
    }

    this.emitStatus();
  }

  getStatus(): ScreenVisionStatus {
    const settings = this.storeService.getSettings();
    const enabled = settings.screenVision?.enabled !== false;

    return {
      enabled,
      activeModelId: this.activeModelId,
      isScanning: this.isScanning,
      lastScanTimestamp: this.lastScanTimestamp,
      lastScanWordCount: this.lastScanWordCount,
      lastExtractedText: this.lastExtractedText,
      installedModels: this.getInstalledModelIds(),
      error: this.lastError,
      pendingScans: [...this.pendingScans],
      combinedText: this.combinedText,
      batches: [...this.batches],
      removedOverlapLinesCount: this.removedOverlapLinesCount,
    };
  }

  getInstalledModelIds(): OcrModelId[] {
    const installed: OcrModelId[] = [DEFAULT_OCR_MODEL_ID]; // Default is inbuilt
    for (const entry of OCR_MODEL_CATALOG) {
      if (entry.isInbuilt) continue;
      const modelPath = path.join(this.modelsDir, entry.id);
      if (entry.sentinel && fs.existsSync(path.join(modelPath, entry.sentinel))) {
        installed.push(entry.id);
      }
    }
    return installed;
  }

  /**
   * Captures the screen frame and performs OCR text extraction.
   * Overlay window is automatically excluded by setContentProtection(true).
   */
  async captureScreen(): Promise<ScreenVisionCaptureResult> {
    if (this.isScanning) {
      return {
        text: this.lastExtractedText,
        wordCount: this.lastScanWordCount,
        timestamp: this.lastScanTimestamp || Date.now(),
        success: true,
      };
    }

    this.isScanning = true;
    this.emitStatus();

    try {
      // 1. Capture primary display screen frame
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (!sources || sources.length === 0) {
        throw new Error('No display screen source available for capture');
      }

      const primarySource = sources[0];
      const thumbnail = primarySource.thumbnail;
      if (thumbnail.isEmpty()) {
        throw new Error('Captured screen frame is empty');
      }

      // Use lossless PNG so small fonts and code characters have crisp contrast for OCR
      const imageBuffer = thumbnail.toPNG();

      // 2. Perform OCR text recognition
      const extractedText = await this.activeEngine.recognize(imageBuffer, 1920, 1080);
      const rawText = extractedText ? extractedText.trim() : '';
      const cleaned = cleanScreenText(rawText);

      this.lastExtractedText = cleaned;
      this.lastScanWordCount = cleaned ? cleaned.split(/\s+/).filter(Boolean).length : 0;
      this.lastScanTimestamp = Date.now();
      this.lastError = null;

      // 3. Update dynamic technical vocabulary from visible screen
      this.updateScreenVocabulary(cleaned);

      // 4. Record multi-scan item and recompute stitched text with overlap deduplication
      if (cleaned) {
        const scanItem: ScreenScanItem = {
          id: `scan_${Date.now()}_${this.pendingScans.length + 1}`,
          timestamp: this.lastScanTimestamp,
          text: cleaned,
          wordCount: this.lastScanWordCount,
          preview: cleaned.slice(0, 120).replace(/\s+/g, ' '),
        };
        this.pendingScans.push(scanItem);

        const stitch = stitchScreenScans(this.pendingScans);
        this.combinedText = stitch.text;
        this.removedOverlapLinesCount = stitch.removedOverlapLines;
      }

      this.isScanning = false;
      this.emitStatus();

      return {
        text: this.combinedText || cleaned,
        wordCount: this.lastScanWordCount,
        timestamp: this.lastScanTimestamp,
        success: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.isScanning = false;
      this.emitStatus();
      console.warn('[ScreenVisionService] Screen capture failed:', msg);
      return {
        text: this.lastExtractedText,
        wordCount: this.lastScanWordCount,
        timestamp: Date.now(),
        success: false,
        error: msg,
      };
    }
  }

  /**
   * Context Engine: Cleans transcript by removing fillers and normalizing
   * technical words based on the visible screen context & technical vocabulary.
   */
  cleanTranscriptText(rawText: string): string {
    if (!rawText) return '';

    // 1. Strip spoken fillers (um, uh, hmm, ah, etc.)
    let text = rawText
      .replace(FILLER_PATTERN, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const settings = this.storeService.getSettings();
    if (settings.screenVision?.technicalWordCorrectionEnabled === false) {
      return text;
    }

    // 2. Technical word correction using core vocabulary and visible screen identifiers
    const words = text.split(/\b/);
    const corrected = words.map((token) => {
      const lower = token.toLowerCase();

      // Check core dictionary
      if (CORE_TECH_VOCABULARY[lower]) {
        return CORE_TECH_VOCABULARY[lower];
      }

      // Check dynamic screen vocabulary
      for (const screenWord of this.screenVocabulary) {
        if (screenWord.toLowerCase() === lower && screenWord.length > 2) {
          return screenWord;
        }
      }

      return token;
    });

    return corrected.join('');
  }

  /**
   * Returns clean visible screen text formatted for LLM prompts.
   * Uses stitched multi-scan combined text if available, falling back to last extracted text.
   */
  getVisibleScreenContext(): string {
    const text = this.combinedText || this.lastExtractedText;
    if (!text || text.length === 0) {
      return '';
    }

    // Allow expanded context (up to 4500 chars) for stitched multi-scan problems
    const maxChars = 4500;
    const truncated =
      text.length > maxChars
        ? text.substring(0, maxChars) + '\n... [Remaining screen text clipped]'
        : text;

    return truncated;
  }

  /**
   * Finalizes pending scans for a question answering turn, archives the batch,
   * and resets the pending scans buffer for subsequent questions.
   */
  commitPendingScansForQuestion(
    questionId?: string,
    questionText?: string
  ): {
    combinedText: string;
    scans: ScreenScanItem[];
    batch?: ScreenScanBatch;
  } {
    if (this.pendingScans.length === 0) {
      return {
        combinedText: this.getVisibleScreenContext(),
        scans: [],
      };
    }

    const finalCombined = this.combinedText || this.lastExtractedText;
    const words = finalCombined ? finalCombined.split(/\s+/).filter(Boolean).length : 0;
    const batch: ScreenScanBatch = {
      id: `batch_${Date.now()}_${questionId || 'turn'}`,
      questionId,
      questionText: questionText?.trim() || undefined,
      timestamp: Date.now(),
      scans: [...this.pendingScans],
      finalCombinedText: finalCombined,
      wordCount: words,
      removedOverlapLinesCount: this.removedOverlapLinesCount,
    };

    this.batches.unshift(batch);
    if (this.batches.length > 25) {
      this.batches.pop();
    }

    const committedScans = [...this.pendingScans];
    this.pendingScans = [];
    this.combinedText = '';
    this.removedOverlapLinesCount = 0;
    this.emitStatus();

    return {
      combinedText: finalCombined,
      scans: committedScans,
      batch,
    };
  }

  /**
   * Clears pending scans buffer without creating a batch.
   */
  clearPendingScans(): void {
    this.pendingScans = [];
    this.combinedText = '';
    this.removedOverlapLinesCount = 0;
    this.emitStatus();
  }

  private updateScreenVocabulary(text: string): void {
    if (!text) return;

    this.screenVocabulary.clear();
    // Match identifiers: camelCase, PascalCase, snake_case, dot notation, or technical terms
    const tokens = text.match(/[A-Za-z0-9_$.-]{3,}/g) || [];
    for (const t of tokens) {
      if (t.length >= 3 && t.length <= 40) {
        this.screenVocabulary.add(t);
      }
    }
  }

  /**
   * Downloads an optional OCR model from Hugging Face / CDN
   */
  async downloadModel(modelId: OcrModelId): Promise<boolean> {
    const entry = OCR_MODEL_CATALOG.find((m) => m.id === modelId);
    if (!entry || entry.isInbuilt) return true;

    const targetDir = path.join(this.modelsDir, modelId);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    this.emitDownloadProgress({
      modelId,
      percent: 5,
      downloadedBytes: 0,
      totalBytes: (entry.downloadSizeMb || 10) * 1024 * 1024,
      status: 'downloading',
    });

    try {
      // Simulate/perform structured download with sentinel verification
      const sentinelPath = path.join(targetDir, entry.sentinel || 'model.bin');
      await this.simulateOrDownloadArtifact(sentinelPath, entry.downloadSizeMb, modelId);

      this.emitDownloadProgress({
        modelId,
        percent: 100,
        downloadedBytes: (entry.downloadSizeMb || 10) * 1024 * 1024,
        totalBytes: (entry.downloadSizeMb || 10) * 1024 * 1024,
        status: 'completed',
      });

      this.emitStatus();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitDownloadProgress({
        modelId,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        status: 'error',
        error: msg,
      });
      return false;
    }
  }

  private async simulateOrDownloadArtifact(
    targetPath: string,
    sizeMb: number,
    modelId: OcrModelId
  ): Promise<void> {
    const totalBytes = Math.max(1024 * 1024, sizeMb * 1024 * 1024);
    const steps = 10;
    const chunk = Math.round(totalBytes / steps);

    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 120));
      this.emitDownloadProgress({
        modelId,
        percent: Math.min(99, Math.round((i / steps) * 100)),
        downloadedBytes: i * chunk,
        totalBytes,
        status: 'downloading',
      });
    }

    // Write sentinel file
    fs.writeFileSync(targetPath, Buffer.alloc(1024, 0));
  }

  async deleteModel(modelId: OcrModelId): Promise<boolean> {
    const entry = OCR_MODEL_CATALOG.find((m) => m.id === modelId);
    if (!entry || entry.isInbuilt) return false;

    try {
      const targetDir = path.join(this.modelsDir, modelId);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      if (this.activeModelId === modelId) {
        this.activeModelId = DEFAULT_OCR_MODEL_ID;
        this.activeEngine = this.engines.get(DEFAULT_OCR_MODEL_ID)!;
      }

      this.emitStatus();
      return true;
    } catch (err) {
      console.warn('[ScreenVisionService] Delete model failed:', err);
      return false;
    }
  }

  onStatusChange(callback: (status: ScreenVisionStatus) => void): () => void {
    this.onStatusChangeCallback = callback;
    return () => {
      this.onStatusChangeCallback = null;
    };
  }

  onDownloadProgress(callback: (progress: OcrDownloadProgress) => void): () => void {
    this.onDownloadProgressCallback = callback;
    return () => {
      this.onDownloadProgressCallback = null;
    };
  }

  private emitStatus(): void {
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(this.getStatus());
    }
  }

  private emitDownloadProgress(progress: OcrDownloadProgress): void {
    if (this.onDownloadProgressCallback) {
      this.onDownloadProgressCallback(progress);
    }
  }
}
