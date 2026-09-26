import { IOcrEngine } from './ocr-engine.interface';
import { OcrModelId } from '@shared/screenvision-catalog';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { resolveBundledBinary } from '../stt/runtimes/runtime-utils';

/**
 * Built-in PP-OCRv5 Mobile Engine
 *
 * Implements lightweight, fast OCR text extraction optimized for computer
 * screens: code editors, browser tabs, slide presentations, and technical diagrams.
 *
 * Architecture:
 * - macOS: Built-in Apple Vision framework (VNRecognizeTextRequest via JXA)
 *   Runs 100% on-device, accelerated by the Apple Neural Engine/GPU, 0MB download.
 * - Windows: Built-in Windows Media OCR (Windows.Media.Ocr.OcrEngine via PowerShell)
 *   Runs 100% on-device on Windows 10/11, 0MB download.
 * - Cross-Platform Fallback: Bundled or system Tesseract CLI if available.
 */
export class PpOcrMobileEngine implements IOcrEngine {
  readonly id: OcrModelId = 'pp-ocrv5-mobile';
  readonly name = 'PP-OCRv5 Mobile (Inbuilt)';
  readonly isInbuilt = true;

  /**
   * Recognizes text from a screenshot image buffer.
   */
  async recognize(buffer: Buffer, _width?: number, _height?: number): Promise<string> {
    if (!buffer || buffer.length === 0) {
      return '';
    }

    const tempImagePath = path.join(
      os.tmpdir(),
      `meetvision-ocr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.png`
    );

    try {
      fs.writeFileSync(tempImagePath, buffer);

      if (process.platform === 'darwin') {
        const macResult = await this.recognizeDarwin(tempImagePath);
        if (macResult && macResult.length > 0) {
          return this.sanitizeOutput(macResult);
        }
      } else if (process.platform === 'win32') {
        const winResult = await this.recognizeWindows(tempImagePath);
        if (winResult && winResult.length > 0) {
          return this.sanitizeOutput(winResult);
        }
      }

      // Fallback: Tesseract if present on machine / bundled
      const fallbackResult = await this.recognizeTesseract(tempImagePath);
      return this.sanitizeOutput(fallbackResult);
    } catch (err) {
      console.warn('[PpOcrMobileEngine] Text recognition error:', err);
      return '';
    } finally {
      try {
        if (fs.existsSync(tempImagePath)) {
          fs.unlinkSync(tempImagePath);
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * macOS: Uses Apple's Vision framework (VNRecognizeTextRequest) via JavaScript for Automation (JXA).
   * Accurate, offline, accelerated by Apple Neural Engine.
   */
  private recognizeDarwin(imagePath: string): Promise<string> {
    return new Promise((resolve) => {
      const script = `ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  var imgUrl = $.NSURL.fileURLWithPath(argv[0]);
  var imgData = $.NSData.dataWithContentsOfURL(imgUrl);
  if (!imgData) return '';
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.usesLanguageCorrection = false;
  var handler = $.VNImageRequestHandler.alloc.initWithDataOptions(imgData, $());
  if (!handler.performRequestsError($([req]), null)) return '';
  var results = req.results;
  var items = [];
  for (var i = 0; i < results.count; i++) {
    var obs = results.objectAtIndex(i);
    var c = obs.topCandidates(1);
    if (c.count > 0) {
      var str = ObjC.unwrap(c.objectAtIndex(0).string);
      var bbox = obs.boundingBox;
      items.push({
        text: str,
        x: bbox.origin.x,
        y: 1.0 - (bbox.origin.y + bbox.size.height), // Convert to top-to-bottom Y
        w: bbox.size.width,
        h: bbox.size.height
      });
    }
  }

  // Detect vertical gutters between multi-column panes (e.g. sidebar vs main document, or LeetCode description vs code editor)
  // Evaluate in content area (y between 0.08 and 0.92) and exclude wide spanning banners/URL bars (w > 0.48)
  var gutters = [];
  var step = 0.003;
  for (var gx = 0.06; gx <= 0.94; gx += step) {
    var spanning = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.y >= 0.08 && it.y <= 0.92 && it.w <= 0.48) {
        if (it.x < gx - 0.003 && (it.x + it.w) > gx + 0.003) {
          spanning++;
        }
      }
    }
    if (spanning === 0) {
      gutters.push(gx);
    }
  }

  // Merge contiguous gutter steps into boundary split points
  var splitPoints = [];
  if (gutters.length > 0) {
    var gStart = gutters[0];
    var gEnd = gutters[0];
    for (var g = 1; g < gutters.length; g++) {
      if (gutters[g] - gEnd < 0.015) {
        gEnd = gutters[g];
      } else {
        if (gEnd - gStart >= 0.006) {
          splitPoints.push((gStart + gEnd) / 2.0);
        }
        gStart = gutters[g];
        gEnd = gutters[g];
      }
    }
    if (gEnd - gStart >= 0.006) {
      splitPoints.push((gStart + gEnd) / 2.0);
    }
  }

  // Segment items into columns and sort strictly top-to-bottom within each column
  var colBounds = [0.0].concat(splitPoints).concat([1.0]);
  var columnBlocks = [];
  for (var c = 0; c < colBounds.length - 1; c++) {
    var left = colBounds[c];
    var right = colBounds[c + 1];
    var colItems = items.filter(function(it) {
      var midX = it.x + it.w / 2.0;
      return midX >= left && midX < right;
    });
    if (colItems.length > 0) {
      colItems.sort(function(a, b) { return a.y - b.y; });
      var lines = [];
      for (var k = 0; k < colItems.length; k++) {
        lines.push(colItems[k].text);
      }
      columnBlocks.push({
        width: right - left,
        lines: lines
      });
    }
  }

  // If there is an overwhelmingly dominant main content pane (width >= 0.40),
  // place it first so document reading flow is preserved before secondary panels
  if (columnBlocks.length > 1) {
    var primary = columnBlocks[0];
    for (var b = 1; b < columnBlocks.length; b++) {
      if (columnBlocks[b].width > primary.width + 0.15) {
        primary = columnBlocks[b];
      }
    }
    if (primary && primary.width >= 0.40 && columnBlocks[0] !== primary) {
      columnBlocks = [primary].concat(columnBlocks.filter(function(cb) { return cb !== primary; }));
    }
  }

  var orderedLines = [];
  for (var b = 0; b < columnBlocks.length; b++) {
    for (var k = 0; k < columnBlocks[b].lines.length; k++) {
      orderedLines.push(columnBlocks[b].lines[k]);
    }
    if (b < columnBlocks.length - 1 && columnBlocks[b].lines.length > 0) {
      orderedLines.push('');
    }
  }

  return orderedLines.join('\\n');
}`;

      execFile(
        'osascript',
        ['-l', 'JavaScript', '-e', script, imagePath],
        { timeout: 7000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve('');
            return;
          }
          resolve(stdout || '');
        }
      );
    });
  }

  /**
   * Windows: Uses Windows 10/11 built-in Windows.Media.Ocr.OcrEngine via PowerShell.
   */
  private recognizeWindows(imagePath: string): Promise<string> {
    return new Promise((resolve) => {
      const psScript = `
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null

$fileTask = [Windows.Storage.StorageFile]::GetFileFromPathAsync("${imagePath.replace(/\\/g, '\\\\')}")
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
Function AwaitTask($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$file = AwaitTask $fileTask ([Windows.Storage.StorageFile])
$streamTask = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
$stream = AwaitTask $streamTask ([Windows.Storage.Streams.IRandomAccessStream])

$decoderTask = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
$decoder = AwaitTask $decoderTask ([Windows.Graphics.Imaging.BitmapDecoder])

$bitmapTask = $decoder.GetSoftwareBitmapAsync()
$bitmap = AwaitTask $bitmapTask ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("en-US"))
}

$ocrTask = $engine.RecognizeAsync($bitmap)
$ocrResult = AwaitTask $ocrTask ([Windows.Media.Ocr.OcrResult])

$linesWithBoxes = @()
foreach ($line in $ocrResult.Lines) {
    $minX = 999999
    $minY = 999999
    foreach ($word in $line.Words) {
        if ($word.BoundingRect.X -lt $minX) { $minX = $word.BoundingRect.X }
        if ($word.BoundingRect.Y -lt $minY) { $minY = $word.BoundingRect.Y }
    }
    $linesWithBoxes += [PSCustomObject]@{
        Text = $line.Text
        X = $minX
        Y = $minY
    }
}

# Sort lines spatially (by column block X, then top-to-bottom Y)
$sorted = $linesWithBoxes | Sort-Object { [Math]::Round($_.X / 400) }, Y
foreach ($l in $sorted) {
    Write-Output $l.Text
}
`;

      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 7000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve('');
            return;
          }
          resolve(stdout || '');
        }
      );
    });
  }

  /**
   * Fallback using Tesseract CLI if installed or bundled under resources/bin.
   */
  private recognizeTesseract(imagePath: string): Promise<string> {
    return new Promise((resolve) => {
      const binary = resolveBundledBinary(['tesseract']);
      if (!binary) {
        resolve('');
        return;
      }

      execFile(
        binary,
        [imagePath, 'stdout', '-l', 'eng', '--psm', '6'],
        { timeout: 7000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve('');
            return;
          }
          resolve(stdout || '');
        }
      );
    });
  }

  /**
   * Cleans OCR lines: trims whitespace, deduplicates sequential lines,
   * removes isolated single symbols, and limits line count to keep context concise.
   */
  private sanitizeOutput(rawText: string): string {
    if (!rawText) return '';

    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 2)
      // Filter out non-alphanumeric noise lines (e.g. random punctuation dots)
      .filter((l) => /[a-zA-Z0-9]/.test(l));

    // Deduplicate sequential identical lines
    const deduped: string[] = [];
    for (const line of lines) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
        deduped.push(line);
      }
    }

    return deduped.slice(0, 150).join('\n');
  }
}
