/**
 * ScreenVision OCR Model Catalog
 *
 * Defines the supported OCR models for cross-platform screen understanding
 * on Windows and macOS as specified in docs/ScreenVision.md.
 *
 * PP-OCRv5 Mobile is the default inbuilt engine.
 * Additional free models can be downloaded as needed.
 */

export type OcrModelId =
  | 'pp-ocrv5-mobile'
  | 'pp-ocrv5-server'
  | 'tesseract-fast'
  | 'trocr-mobile'
  | 'paddleocr-multilingual';

export interface OcrModelArtifactFile {
  path: string;
  bytes: number;
}

export interface OcrModelCatalogEntry {
  id: OcrModelId;
  name: string;
  subtitle: string;
  description: string;
  isInbuilt: boolean;
  architecture: string;
  downloadSizeMb: number;
  accuracy: 'standard' | 'high' | 'ultra';
  speed: 'instant' | 'fast' | 'moderate';
  repo?: string;
  sentinel?: string;
  files?: OcrModelArtifactFile[];
  notes?: string[];
}

export const DEFAULT_OCR_MODEL_ID: OcrModelId = 'pp-ocrv5-mobile';

export const OCR_MODEL_CATALOG: readonly OcrModelCatalogEntry[] = [
  {
    id: 'pp-ocrv5-mobile',
    name: 'PP-OCRv5 Mobile',
    subtitle: 'Default Inbuilt Engine • Real-time Speed',
    description:
      'Ultra-compact mobile OCR engine optimized for instant low-latency screen frame recognition on desktop CPU and GPU. Pre-bundled out of the box with zero setup.',
    isInbuilt: true,
    architecture: 'PP-LCNetV2 + SVTR-LCNet (Lightweight Mobile)',
    downloadSizeMb: 0,
    accuracy: 'high',
    speed: 'instant',
    notes: [
      'Inbuilt by default — ready to use immediately without downloading external weights.',
      'Optimized for coding IDEs, presentation slides, meeting chat windows, and browser text.',
    ],
  },
  {
    id: 'pp-ocrv5-server',
    name: 'PP-OCRv5 Server',
    subtitle: 'High Precision • Dense Technical Layouts',
    description:
      'Full-capacity server OCR model providing superior character accuracy for complex multi-column diagrams, dense technical documentation, and small terminal fonts.',
    isInbuilt: false,
    architecture: 'ResNet34_vd + SVTR Full',
    downloadSizeMb: 46,
    accuracy: 'ultra',
    speed: 'fast',
    repo: 'MeetVisionAI/pp-ocrv5-server',
    sentinel: 'inference.pdmodel',
    files: [
      { path: 'inference.pdmodel', bytes: 28400000 },
      { path: 'inference.pdiparams', bytes: 19800000 },
    ],
    notes: ['Recommended when viewing complex system architecture diagrams or dense log consoles.'],
  },
  {
    id: 'tesseract-fast',
    name: 'Tesseract Fast',
    subtitle: 'Open Source Standard • Compact Footprint',
    description:
      'Optimized integer LSTM neural network trained on English technical text and source code. Reliable fallback with minimal memory overhead.',
    isInbuilt: false,
    architecture: 'LSTM Sequence-to-Sequence',
    downloadSizeMb: 15,
    accuracy: 'standard',
    speed: 'fast',
    repo: 'tesseract-ocr/tessdata_fast',
    sentinel: 'eng.traineddata',
    files: [{ path: 'eng.traineddata', bytes: 15400000 }],
    notes: ['Classic open source engine, very lightweight and reliable for plain English text.'],
  },
  {
    id: 'trocr-mobile',
    name: 'TrOCR Mobile',
    subtitle: 'Vision Transformer • Semantic OCR',
    description:
      'End-to-end Transformer OCR combining a vision encoder with an autoregressive language decoder for understanding stylized code, markdown, and handwriting.',
    isInbuilt: false,
    architecture: 'DeiT Vision Encoder + RoBERTa Decoder',
    downloadSizeMb: 85,
    accuracy: 'ultra',
    speed: 'moderate',
    repo: 'microsoft/trocr-small-printed',
    sentinel: 'pytorch_model.bin',
    files: [
      { path: 'pytorch_model.bin', bytes: 87500000 },
      { path: 'config.json', bytes: 4200 },
    ],
    notes: ['Deep transformer attention model, ideal for technical presentations and code snippets.'],
  },
  {
    id: 'paddleocr-multilingual',
    name: 'PaddleOCR Multilingual',
    subtitle: 'Broad Language Coverage • CJK + Latin',
    description:
      'Multi-script recognition model supporting over 80 languages including Japanese, Chinese, Korean, Hindi, and Cyrillic alongside English.',
    isInbuilt: false,
    architecture: 'MobileNetV3 + SVTR Multi-script',
    downloadSizeMb: 38,
    accuracy: 'high',
    speed: 'fast',
    repo: 'PaddlePaddle/PaddleOCR-MultiLingual',
    sentinel: 'multilingual.pdmodel',
    files: [
      { path: 'multilingual.pdmodel', bytes: 22100000 },
      { path: 'multilingual.pdiparams', bytes: 17800000 },
    ],
    notes: ['Best choice for international meetings with non-English or bilingual screen content.'],
  },
];
