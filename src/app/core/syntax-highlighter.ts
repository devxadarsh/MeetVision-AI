/**
 * LeetCode Syntax Highlighter Utility
 *
 * Provides fast, zero-dependency tokenization and syntax coloring formatted
 * after the dark theme on the LeetCode coding platform:
 * - Classes & Data Structures: Teal (#4ec9b0)
 * - Methods & Functions: Bright Yellow / Gold (#dcdcaa)
 * - Variables & Parameters: Light Sky Blue (#9cdcfe)
 * - Keywords: Pink / Magenta (#c678dd)
 * - Strings: Warm Coral / Amber (#ce9178)
 * - Numbers: Mint Green (#b5cea8)
 * - Booleans / Nullish: Deep Sky Blue (#569cd6)
 * - Comments: Olive Green italic (#6a9955)
 * - Operators: Cyan (#56b6c2)
 * - Types: Teal (#4ec9b0)
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LEETCODE_TOKEN_REGEX = new RegExp(
  [
    /* 1. Block comments */ '(/\\*[\\s\\S]*?\\*/)',
    /* 2. Line comments */ '(//[^\n]*|#(?!include|define|pragma|ifdef|ifndef|endif)[^\n]*)',
    /* 3. Strings (including triple-quoted docstrings) */ '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)',
    /* 4. Numbers */ '(\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
    /* 5. Keywords */ '(\\b(?:class|def|function|return|if|else|elif|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|new|async|await|yield|import|export|from|as|in|of|extends|implements|interface|enum|type|struct|fn|mut|impl|pub|package|public|private|protected|static|final|const|let|var|val)\\b)',
    /* 6. Booleans & Nullish */ '(\\b(?:true|false|True|False|null|None|nil|undefined|NaN|Infinity)\\b)',
    /* 7. Primitive types */ '(\\b(?:int|float|double|bool|boolean|char|void|number|string|any|unknown|never|byte|short|long)\\b)',
    /* 8. Methods / functions */ '(\\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\\s*\\())',
    /* 9. Classes & Types (PascalCase) */ '(\\b[A-Z][a-zA-Z0-9_$]*\\b)',
    /* 10. this / self */ '(\\b(?:this|self|super)\\b)',
    /* 11. Variables & Identifiers */ '(\\b[a-zA-Z_$][a-zA-Z0-9_$]*\\b)',
    /* 12. Operators */ '(===|!==|==|!=|<=|>=|=>|->|\\+\\+|--|\\+=|-=|\\*=|/=|&&|\\|\\||<<|>>|[+\\-*/%=&|^!<>?:])',
  ].join('|'),
  'g'
);

export function highlightLeetCodeSnippet(code: string): string {
  if (!code) return '';

  let html = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  LEETCODE_TOKEN_REGEX.lastIndex = 0;

  while ((match = LEETCODE_TOKEN_REGEX.exec(code)) !== null) {
    if (match.index > lastIndex) {
      html += escapeHtml(code.slice(lastIndex, match.index));
    }

    const token = match[0];
    const escaped = escapeHtml(token);

    if (match[1] || match[2]) {
      // Comments: Olive Green italic (#6a9955)
      html += `<span class="lc-comment" style="color: #6a9955; font-style: italic;">${escaped}</span>`;
    } else if (match[3]) {
      // Strings: Warm Coral / Amber (#ce9178)
      html += `<span class="lc-string" style="color: #ce9178;">${escaped}</span>`;
    } else if (match[4]) {
      // Numbers: Mint Green (#b5cea8)
      html += `<span class="lc-number" style="color: #b5cea8;">${escaped}</span>`;
    } else if (match[5]) {
      // Keywords: Pink / Magenta (#c678dd)
      html += `<span class="lc-keyword" style="color: #c678dd; font-weight: 600;">${escaped}</span>`;
    } else if (match[6]) {
      // Booleans / Nullish: Deep Sky Blue (#569cd6)
      html += `<span class="lc-boolean" style="color: #569cd6;">${escaped}</span>`;
    } else if (match[7]) {
      // Types: Teal (#4ec9b0)
      html += `<span class="lc-type" style="color: #4ec9b0; font-weight: 600;">${escaped}</span>`;
    } else if (match[8]) {
      // Methods & Functions: Bright Yellow-Gold (#dcdcaa)
      html += `<span class="lc-method" style="color: #dcdcaa;">${escaped}</span>`;
    } else if (match[9]) {
      // Classes: Teal (#4ec9b0)
      html += `<span class="lc-class" style="color: #4ec9b0; font-weight: 600;">${escaped}</span>`;
    } else if (match[10]) {
      // this / self: Deep Sky Blue (#569cd6)
      html += `<span class="lc-self" style="color: #569cd6;">${escaped}</span>`;
    } else if (match[11]) {
      // Variables & Parameters: Light Sky Blue (#9cdcfe)
      html += `<span class="lc-variable" style="color: #9cdcfe;">${escaped}</span>`;
    } else if (match[12]) {
      // Operators: Cyan (#56b6c2)
      html += `<span class="lc-operator" style="color: #56b6c2;">${escaped}</span>`;
    } else {
      html += escaped;
    }

    lastIndex = LEETCODE_TOKEN_REGEX.lastIndex;
  }

  if (lastIndex < code.length) {
    html += escapeHtml(code.slice(lastIndex));
  }

  return html;
}

export function getLineNumbersList(code: string | undefined): number[] {
  if (!code) return [1];
  const count = code.split('\n').length;
  return Array.from({ length: count }, (_, i) => i + 1);
}

export function detectCodeLanguage(code: string | undefined): string {
  if (!code) return 'Code';
  if (/def\s+\w+\(|self\.|import\s+\w+|from\s+\w+\s+import/.test(code)) return 'Python';
  if (/public\s+(class|static|void|int|String)|System\.out\.println/.test(code)) return 'Java';
  if (/#include\s*<|std::|cout\s*<</.test(code)) return 'C++';
  if (/interface\s+\w+|:\s*(string|number|boolean|any)|as\s+\w+/.test(code)) return 'TypeScript';
  if (/func\s+\w+\(|package\s+\w+/.test(code)) return 'Go';
  if (/fn\s+\w+\(|let\s+mut\s+/.test(code)) return 'Rust';
  if (/function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=/.test(code)) return 'JavaScript';
  return 'Solution';
}
