import { OcrModelId } from '@shared/screenvision-catalog';

export interface OcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrRecognizedLine {
  text: string;
  confidence: number;
  box?: OcrBoundingBox;
}

export interface IOcrEngine {
  readonly id: OcrModelId;
  readonly name: string;
  readonly isInbuilt: boolean;

  /**
   * Performs text detection and recognition on raw image RGBA / PNG / JPEG buffer.
   * Returns cleaned, multi-line extracted text.
   */
  recognize(buffer: Buffer, width?: number, height?: number): Promise<string>;
}
