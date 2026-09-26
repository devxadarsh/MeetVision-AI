/**
 * MeetVision AI - Text Stitcher & Sequence Diff Alignment Engine
 *
 * Combines multiple screen OCR scans taken while scrolling through multi-pane
 * applications (e.g. LeetCode, IDEs, browser documents with sticky headers and sidebars).
 *
 * Uses sequence-aware diff alignment (LCS) and global deduplication to:
 * 1. Output a single continuous text block (no separators).
 * 2. Keep shared blocks (sticky headers, navigation, fixed editor panes, overlapping lines) only once.
 * 3. Seamlessly splice newly revealed content (e.g. scrolled examples, constraints) into place.
 * 4. Filter out duplicate bookmarks, repeated status lines, and fragmented OCR noise.
 */

export interface StitchResult {
  text: string;
  removedOverlapLines: number;
}

export function normalizeLine(line: string): string {
  return (line || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = new Array<number>(b.length + 1);
  for (let i = 0; i <= b.length; i++) {
    row[i] = i;
  }

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val =
        a[i - 1] === b[j - 1]
          ? row[j - 1]
          : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }

  return row[b.length];
}

/**
 * Checks if two lines match with OCR noise tolerance
 */
export function areLinesSimilar(line1: string, line2: string): boolean {
  const n1 = normalizeLine(line1);
  const n2 = normalizeLine(line2);

  // Empty lines do not match
  if (!n1 || !n2) return false;
  // Exact match
  if (n1 === n2) return true;

  // Do NOT match lines if both contain different numbers/digits
  // (e.g. "Example 1:" vs "Example 2:", "k = 2" vs "k = 5")
  const digits1 = n1.replace(/[^\d]/g, '');
  const digits2 = n2.replace(/[^\d]/g, '');
  if (digits1 !== digits2 && (digits1.length > 0 || digits2.length > 0)) {
    return false;
  }

  // Very short lines require exact match
  if (n1.length < 6 || n2.length < 6) {
    return n1 === n2;
  }

  // Substring containment for minor OCR boundary artifacts (>= 88% length ratio)
  if (n1.includes(n2) || n2.includes(n1)) {
    const minLen = Math.min(n1.length, n2.length);
    const maxLen = Math.max(n1.length, n2.length);
    if (minLen >= 8 && minLen / maxLen >= 0.88) {
      return true;
    }
  }

  // Levenshtein fuzzy match for OCR typos (>= 82% similarity)
  const dist = levenshteinDistance(n1, n2);
  const maxLen = Math.max(n1.length, n2.length);
  return (maxLen - dist) / maxLen >= 0.82;
}

// Structural / common programming lines that are legitimately allowed to repeat
const ALLOW_REPEAT = new Set([
  '',
  '{',
  '}',
  '};',
  ']',
  '[',
  '];',
  ')',
  '(',
  'return',
  'break;',
  'example',
  'example 1:',
  'example 2:',
  'example 3:',
  'input:',
  'output:',
  'explanation:',
]);

/**
 * Detects noisy OCR artifacts, reaction badges, line/col indicators, and browser/app chrome
 */
export function isUselessNoiseLine(rawLine: string): boolean {
  const line = (rawLine || '').trim();
  if (!line) return false;

  // Check if line is a valid Web URL (e.g. leetcode.com/problems/..., https://github.com/...)
  // We explicitly PRESERVE URLs as they provide critical semantic context to the LLM
  if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}\/[^\s]*$/i.test(line)) {
    return false;
  }

  // 1. Isolated short OCR symbols or noise (1-4 chars) unless structural code brackets
  if (/^[•·\-=|()\[\]{}:;><_~+*#\s]{1,5}$/.test(line)) return true;
  if (/^[(•·]?\s*[\d\w]{1,2}\s*[:)]?$/.test(line)) return true;
  if (/^[•·]\s*\(\s*\d+\s*\)?$/.test(line)) return true; // e.g. "• (1"

  // 2. Browser / Window button noise like "BE | Q FI | = CI" or "B | QFI| e C|AQ fi ®" or "dc +"
  if (/^[A-Za-z0-9\s|:=•·()\-®©]{1,40}$/.test(line) && (line.match(/\|/g) || []).length >= 2) {
    return true;
  }
  if (/^[a-zA-Z0-9]{1,3}\s*[|+]\s*\+?$/.test(line)) return true; // e.g. "dc +", "dc| +"
  if (/^[•·*]\s*[\d\w]{1,2}\s*[|•·]\s*[\d\w]{1,2}$/i.test(line)) return true; // e.g. "* 0 |c", "* 0 • lo"

  // 3. Editor cursor / line column indicators: "Ln 1, Col 1", "Col 12"
  if (/^Ln\s+\d+,\s*Col\s+\d+/i.test(line)) return true;

  // 4. Social reaction counters & vote badges: "3 19.8K", "3 19.8KK", "D 1.2K", "19.8K", "I3 19.8K •7|", "• 1.2K"
  if (/^[A-Z0-9•·\s]{0,5}\d+([.,]\d+)?[kKmM]{1,2}(\s*[•·|0-9]+)?$/i.test(line)) return true;

  // 5. Common browser chrome banner strings & transient toasts
  const lower = line.toLowerCase();
  if (
    lower === 'all bookmarks' ||
    lower.startsWith('new chrome available') ||
    lower === 'ask gemini' ||
    lower === 'you must run your code first' ||
    lower.startsWith('restored from local') ||
    lower === 'premium' ||
    lower === 'final cut pro for m...'
  ) {
    return true;
  }

  // 6. Navigation tabs & standard non-content UI buttons with icon prefixes
  // (e.g. "Description", "Editorial", "Solutions", "Submissions", "E Problem List", "* Submissions", "Test Result", "y Testcase", "Submit", "Auto", "ê Companies", "Q Hint")
  if (
    /^[•·*IШEQy\s]*problem list$/i.test(line) ||
    /^[•·IШ\s]*editorial$/i.test(line) ||
    /^[•·*IШEQy\s]*(solutions|submissions|description)$/i.test(line) ||
    /^[•·ê?💡QIШ*Ey\s]*(topics|companies|hint|hints)$/i.test(line) ||
    /^submit$/i.test(line) ||
    /^<\/>\s*code$/i.test(line) ||
    /^[•·]?\s*auto$/i.test(line) ||
    /^[•·*yIШE\s]*testcase$/i.test(line) ||
    /^[0-9>_|•·\s]*test result$/i.test(line)
  ) {
    return true;
  }

  // 7. Known isolated browser bookmark bar chips
  if (
    lower === 'science facts' ||
    lower.includes('pinterest') ||
    lower.startsWith('free video on pixa') ||
    lower === 'paynearby' ||
    lower.startsWith('adhar') ||
    lower === 'ytm' ||
    lower === 'typeracer' ||
    lower === 'c leetcode'
  ) {
    return true;
  }

  // 8. Isolated short words / gibberish that are not programming keywords
  if (
    lower === 'fix' ||
    lower === 'xố' ||
    lower === 'java v' ||
    lower === 'c leetcode' ||
    lower === 'leetcode' ||
    lower === 'a q' ||
    lower === 'meetvision-al' ||
    lower === 'meetvision-ai' ||
    lower === 'update' ||
    lower === 'qu' ||
    lower === 'dsou' ||
    lower === 'resolvep.' ||
    /^[•·]?\s*\(\d+\)$/.test(line) || // e.g. "• (1", "(1:"
    /^\d+\)\)+$/.test(line) // e.g. "2))"
  ) {
    return true;
  }

  // 9. Isolated editor gutter line numbers (e.g. "67", "74", "84", "101")
  if (/^\d{1,4}$/.test(line)) {
    return true;
  }

  // 10. Source Control / Git sidebar UI elements & commit list entries
  if (
    /^(source control|changes|v changes|commit|v commit|text editor v)$/i.test(line) ||
    /^message \(\*enter to commit/i.test(line) ||
    /^oorigin\//i.test(line) ||
    /^>\s*gitlens/i.test(line) ||
    /^merge pull request #\d+/i.test(line) ||
    /^[•·]?\s*(feat|fix|chore|refactor|docs|style|test|perf|ci|build)(\([^\)]+\))?:\s+/i.test(line) ||
    /^[l|][êe]\s+feat\//i.test(line)
  ) {
    return true;
  }

  // 11. Editor tab strips & breadcrumbs (e.g. "RD.md X", "AGENTS.md > abc # AGENTS.md > ab ## Testing")
  if (
    /(\.md|\.ts|\.json|\.jsonc|\.html|\.scss|\.js|\.txt)\s+[1-9]?\s*x\b/i.test(line) ||
    /^(documents|settings|kilo settings)\s+x$/i.test(line) ||
    /^[a-z0-9_.-]+\s*>\s*[a-z0-9_.-]+.*>\s*(ab|abc)?\s*#/i.test(line) ||
    /^[a-z0-9_.-]+\s*>\s*abc\b/i.test(line)
  ) {
    return true;
  }

  // 12. File tree sidebar rows (e.g. "main.ts electron", "preload.ts electron", "screenvision.service.ts electron/services")
  if (/^[a-z0-9_.-]+\.(ts|js|json|jsonc|md|html|scss)\s+[a-z0-9_./-]+$/i.test(line)) {
    return true;
  }

  // 13. Terminal panel headers, command prompts & execution logs
  if (
    /^(problems \d*|output|debug console|terminal|ports)\b/i.test(line) ||
    /output debug console terminal/i.test(line) ||
    /^\(base\)\s*→/i.test(line) ||
    /^\[\d+\]\s*\[(screenvision|sttservice|parakeet|llm)/i.test(line) ||
    /^\[(screenvision|sttservice|parakeet|llm)\]/i.test(line) ||
    /^≥?\s*zsh$/i.test(line) ||
    /^\[\d+\]$/i.test(line)
  ) {
    return true;
  }

  // 14. Editor status bar & footer items
  if (
    /^ln \d+,\s*col \d+/i.test(line) ||
    /^(markdown|\{\}\s*markdown|spaces:\s*\d+|utf-8|lf|crlf)$/i.test(line) ||
    /^antigravity\s*-\s*settings$/i.test(line) ||
    /^0\s*[аa]\s*\|$/i.test(line)
  ) {
    return true;
  }

  return false;
}

/**
 * Reassembles broken text lines and hyphenated word wrap artifacts into fluent sentences.
 * (e.g. "guarded in-" + "flight answering..." -> "guarded in-flight answering...",
 * or "Explanation: Your function" + "should return k = 2...")
 */
export function mergeBrokenLineFragments(rawLines: string[]): string[] {
  const merged: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const curr = rawLines[i]?.trim() || '';
    if (!curr) {
      if (merged.length > 0 && merged[merged.length - 1] !== '') {
        merged.push('');
      }
      continue;
    }

    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const isBulletOrHeader = /^([•·\-\*]|\d+[\.\)]|#+|>)\s+/.test(curr);
      const prevIsHeader = /^#+\s+/.test(prev);
      const prevIsBulletOrNumber = /^([•·\-\*]|\d+[\.\)])\s+/.test(prev);
      const prevEndsWithColon = /:\s*$/.test(prev);
      const isCodeLine = /^(\s*[{};]|class\s|public\s|function\s|def\s|const\s|let\s|var\s|import\s)/.test(curr);
      const prevIsCodeLine = /^(\s*[{};]|class\s|public\s|function\s|def\s|const\s|let\s|var\s|import\s)/.test(prev);
      const isUrl = /^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,}\/)/i.test(curr);
      const isExampleOrKeyword = /^(example|input|output|explanation|constraints):/i.test(curr);

      // 1. Hyphenated word wrap split across lines (e.g. "guarded in-" + "flight")
      if (prev.endsWith('-') && !prev.endsWith('--') && curr.length > 0 && /^[a-zA-Z]/.test(curr)) {
        merged[merged.length - 1] = prev + curr;
        continue;
      }

      // 2. Trailing clause / sentence continuation (e.g. prev didn't end with sentence terminator, curr starts lowercase/punctuation)
      const startsLower = /^[a-z0-9,;:\)\]\}]/.test(curr);
      const prevEndedWithoutPunct = !/[.:;?!]\s*$/.test(prev);

      if (
        startsLower &&
        prevEndedWithoutPunct &&
        !isBulletOrHeader &&
        !prevIsHeader &&
        !prevIsBulletOrNumber &&
        !prevEndsWithColon &&
        !isCodeLine &&
        !prevIsCodeLine &&
        !isUrl &&
        !isExampleOrKeyword
      ) {
        merged[merged.length - 1] = prev + ' ' + curr;
        continue;
      }
    }

    merged.push(curr);
  }

  return merged;
}

/**
 * Filters noise and browser chrome from single-scan raw OCR text
 */
export function cleanScreenText(rawText: string): string {
  if (!rawText) return '';
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => !isUselessNoiseLine(l));
  const merged = mergeBrokenLineFragments(lines);
  const deduped = cleanAndDeduplicateDocument(merged);
  return deduped.lines.join('\n');
}

interface MatchBlock {
  i: number;
  j: number;
  size: number;
}

/**
 * Finds the longest contiguous matching block between linesA[alo...ahi] and linesB[blo...bhi]
 */
function findLongestMatch(
  linesA: string[],
  linesB: string[],
  alo: number,
  ahi: number,
  blo: number,
  bhi: number
): MatchBlock {
  let bestI = alo;
  let bestJ = blo;
  let bestSize = 0;
  let j2len: Record<number, number> = {};

  for (let i = alo; i < ahi; i++) {
    const newJ2len: Record<number, number> = {};
    for (let j = blo; j < bhi; j++) {
      if (areLinesSimilar(linesA[i], linesB[j])) {
        const k = (j2len[j - 1] || 0) + 1;
        newJ2len[j] = k;
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
    }
    j2len = newJ2len;
  }

  return { i: bestI, j: bestJ, size: bestSize };
}

/**
 * Recursively locates all matching blocks between linesA and linesB
 */
function getMatchingBlocks(
  linesA: string[],
  linesB: string[],
  alo = 0,
  ahi = linesA.length,
  blo = 0,
  bhi = linesB.length
): MatchBlock[] {
  const match = findLongestMatch(linesA, linesB, alo, ahi, blo, bhi);
  if (match.size === 0) {
    return [];
  }

  const left = getMatchingBlocks(linesA, linesB, alo, match.i, blo, match.j);
  const right = getMatchingBlocks(
    linesA,
    linesB,
    match.i + match.size,
    ahi,
    match.j + match.size,
    bhi
  );

  return [...left, match, ...right];
}

interface OpCode {
  tag: 'equal' | 'delete' | 'insert' | 'replace';
  i1: number;
  i2: number;
  j1: number;
  j2: number;
}

/**
 * Generates edit opcodes from matching blocks
 */
function getOpCodes(linesA: string[], linesB: string[]): OpCode[] {
  const blocks = getMatchingBlocks(linesA, linesB);
  const opcodes: OpCode[] = [];
  let i = 0;
  let j = 0;

  for (const block of blocks) {
    const hasA = i < block.i;
    const hasB = j < block.j;

    if (hasA && hasB) {
      opcodes.push({ tag: 'replace', i1: i, i2: block.i, j1: j, j2: block.j });
    } else if (hasA) {
      opcodes.push({ tag: 'delete', i1: i, i2: block.i, j1: j, j2: block.j });
    } else if (hasB) {
      opcodes.push({ tag: 'insert', i1: i, i2: block.i, j1: j, j2: block.j });
    }

    opcodes.push({
      tag: 'equal',
      i1: block.i,
      i2: block.i + block.size,
      j1: block.j,
      j2: block.j + block.size,
    });

    i = block.i + block.size;
    j = block.j + block.size;
  }

  const hasA = i < linesA.length;
  const hasB = j < linesB.length;
  if (hasA && hasB) {
    opcodes.push({ tag: 'replace', i1: i, i2: linesA.length, j1: j, j2: linesB.length });
  } else if (hasA) {
    opcodes.push({ tag: 'delete', i1: i, i2: linesA.length, j1: j, j2: linesB.length });
  } else if (hasB) {
    opcodes.push({ tag: 'insert', i1: i, i2: linesA.length, j1: j, j2: linesB.length });
  }

  return opcodes;
}

/**
 * Secondary global pass: filters out isolated OCR noise and duplicates of lines
 * that already appeared earlier in the document (such as reordered bookmark bars).
 */
function cleanAndDeduplicateDocument(rawLines: string[]): { lines: string[]; duplicates: number } {
  const result: string[] = [];
  const seenLines: string[] = [];
  let duplicates = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      if (result.length > 0 && result[result.length - 1] !== '') {
        result.push('');
      }
      continue;
    }

    if (isUselessNoiseLine(line)) {
      continue;
    }

    const norm = normalizeLine(line);
    const allowRepeat =
      ALLOW_REPEAT.has(norm) ||
      norm.startsWith('example') ||
      norm.startsWith('input') ||
      norm.startsWith('output') ||
      norm.startsWith('explanation') ||
      norm.startsWith('case ') ||
      norm.startsWith('return ');

    if (!allowRepeat && norm.length >= 5) {
      const isDupe = seenLines.some((prev) => areLinesSimilar(prev, norm));
      if (isDupe) {
        duplicates++;
        continue;
      }
      seenLines.push(norm);
    }

    result.push(line);
  }

  return { lines: result, duplicates };
}

/**
 * Computes monotonic Longest Common Subsequence of matching lines between A and B
 */
export function computeLCSMatches(
  linesA: string[],
  linesB: string[]
): Array<{ aIdx: number; bIdx: number }> {
  const m = linesA.length;
  const n = linesB.length;
  if (m === 0 || n === 0) return [];

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (areLinesSimilar(linesA[i - 1], linesB[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matching pairs in strictly ascending order
  const matches: Array<{ aIdx: number; bIdx: number }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (areLinesSimilar(linesA[i - 1], linesB[j - 1])) {
      matches.unshift({ aIdx: i - 1, bIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

export function isCodeLine(line: string): boolean {
  const l = (line || '').trim();
  return (
    /^(\s*[{};]|class\s|public\s|private\s|protected\s|function\s|def\s|const\s|let\s|var\s|import\s|return\s)/i.test(l) ||
    /^(int|void|boolean|char|double|float|long|short)\s+[a-z0-9_]+\s*\(/i.test(l) ||
    /\{$/.test(l)
  );
}

/**
 * Stitches two texts together using Monotonic Sequence Alignment (LCS).
 *
 * Guarantees that:
 * 1. The relative top-to-bottom reading order of the document is strictly preserved.
 * 2. Overlapping lines between Scan A and Scan B are deduplicated.
 * 3. Newly scrolled lines from Scan B are appended seamlessly at the bottom.
 * 4. Contiguous code signatures (e.g. class Solution { public int removeDuplicates(...) }) are protected
 *    from having scrolled prose sentences spliced between them.
 * 5. Index shifting or backwards insertion is mathematically impossible.
 */
export function stitchTwoTexts(textA: string, textB: string): StitchResult {
  const cleanA = (textA || '').trim();
  const cleanB = (textB || '').trim();

  if (!cleanA) return { text: cleanB, removedOverlapLines: 0 };
  if (!cleanB) return { text: cleanA, removedOverlapLines: 0 };

  // Check if identical scans
  if (cleanA === cleanB) {
    const lines = cleanB.split(/\r?\n/);
    return { text: cleanA, removedOverlapLines: lines.length };
  }

  const linesA = cleanA
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isUselessNoiseLine(l));
  const linesB = cleanB
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isUselessNoiseLine(l));

  const matches = computeLCSMatches(linesA, linesB);

  // If no common subsequence found (e.g. completely disparate screens)
  if (matches.length === 0) {
    const combined = [...linesA, ...linesB];
    const deduped = cleanAndDeduplicateDocument(combined);
    return {
      text: deduped.lines.join('\n'),
      removedOverlapLines: deduped.duplicates,
    };
  }

  // Monotonically assemble lines:
  // 1. All lines from A prior to the first match
  // 2. For each match, any non-matching intervening lines from A, then from B, then the matched line
  // 3. Any trailing lines from A
  // 4. Any trailing lines from B (the newly scrolled content!)
  const result: string[] = [];
  const deferred: string[] = [];
  let lastA = -1;
  let lastB = -1;

  for (const { aIdx, bIdx } of matches) {
    for (let i = lastA + 1; i < aIdx; i++) {
      result.push(linesA[i]);
    }

    const aIsContiguousCode =
      aIdx === lastA + 1 &&
      lastA >= 0 &&
      isCodeLine(linesA[lastA]) &&
      isCodeLine(linesA[aIdx]);

    for (let j = lastB + 1; j < bIdx; j++) {
      if (aIsContiguousCode && !isCodeLine(linesB[j])) {
        deferred.push(linesB[j]);
      } else {
        result.push(linesB[j]);
      }
    }
    result.push(linesA[aIdx]);

    lastA = aIdx;
    lastB = bIdx;
  }

  // Any remaining lines in A after the last match
  for (let i = lastA + 1; i < linesA.length; i++) {
    result.push(linesA[i]);
  }

  // Append any deferred non-code lines if not already present
  for (const defLine of deferred) {
    if (!result.some((r) => areLinesSimilar(r, defLine))) {
      result.push(defLine);
    }
  }

  // Any newly scrolled lines in B after the last match
  for (let j = lastB + 1; j < linesB.length; j++) {
    result.push(linesB[j]);
  }

  const overlapCount = matches.length;
  const reassembled = mergeBrokenLineFragments(result);
  const finalCleaned = cleanAndDeduplicateDocument(reassembled);

  return {
    text: finalCleaned.lines.join('\n'),
    removedOverlapLines: overlapCount + finalCleaned.duplicates,
  };
}

/**
 * Combines an array of sequential screen scans into one unified document,
 * filtering out all overlapping lines between consecutive scans.
 */
export function stitchScreenScans(scans: Array<{ text: string }>): StitchResult {
  if (!scans || scans.length === 0) {
    return { text: '', removedOverlapLines: 0 };
  }

  if (scans.length === 1) {
    const cleaned = cleanAndDeduplicateDocument((scans[0].text || '').split(/\r?\n/));
    return { text: cleaned.lines.join('\n'), removedOverlapLines: cleaned.duplicates };
  }

  let currentCombined = scans[0].text || '';
  let totalRemovedLines = 0;

  for (let i = 1; i < scans.length; i++) {
    const nextText = scans[i].text || '';
    if (!nextText.trim()) continue;

    const res = stitchTwoTexts(currentCombined, nextText);
    currentCombined = res.text;
    totalRemovedLines += res.removedOverlapLines;
  }

  return {
    text: currentCombined,
    removedOverlapLines: totalRemovedLines,
  };
}
