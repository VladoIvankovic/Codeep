/**
 * Message formatting utilities — extracted from `App.ts`.
 *
 * These are pure (or near-pure) functions that turn a chat message
 * (`role` + raw `content`) into the array of styled lines the custom
 * screen renderer paints. Extracting them:
 *
 *   - shrinks `App.ts` (the 3.2k-LoC render-loop host) by ~600 LoC,
 *   - makes the formatter unit-testable in isolation (no App state),
 *   - lets the quick-chat / ACP surfaces reuse the same rendering if
 *     they ever need to paint formatted assistant output.
 *
 * Convention: a `RenderedLine` carries the already-ANSI-styled `text`
 * plus a `raw` flag — when true, the screen writer must NOT apply the
 * per-message default style (the line has its own colours baked in).
 * This is how code blocks and headings keep their syntax-highlight
 * palette instead of being washed by the body colour.
 */

import { fg, style, stringWidth } from '../ansi';
import { SYNTAX, highlightCode } from '../highlight';

// Shared primary colour — same value as the one defined in App.ts. Kept
// here so the formatter is self-contained; the App re-exports it from
// the same literal to avoid drift.
const PRIMARY_COLOR = fg.rgb(240, 42, 48);

export interface RenderedLine {
  text: string;
  style: string;
  raw?: boolean;
}

/**
 * Mutable counter passed by reference into `formatMessage` so the caller
 * (App, during a render pass) can keep a running code-block index across
 * messages — that index is what `/copy [n]` refers to.
 *
 * Modelled as an object (not a return value) because `formatMessage`
 * appends to an output array AND increments the counter; returning both
 * would force every caller to thread a tuple through, and the render
 * loop already mutates `this.codeBlockCounter` in place.
 */
export interface BlockCounter {
  current: number;
}

// ─── Inline markdown ──────────────────────────────────────────────────────────

/**
 * Apply inline markdown formatting (bold, italic, inline code, strikethrough)
 * to a single line. Returns the styled string plus a flag telling the caller
 * whether any formatting was applied — the caller uses that to decide whether
 * to mark the line `raw` (so the renderer doesn't double-apply the body colour).
 */
export function applyInlineMarkdown(text: string): { formatted: string; hasFormatting: boolean } {
  let result = '';
  let hasFormatting = false;
  let i = 0;

  while (i < text.length) {
    // Inline code: `code`
    if (text[i] === '`' && text[i + 1] !== '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        const code = text.slice(i + 1, end);
        result += fg.rgb(209, 154, 102) + code + '\x1b[0m';
        hasFormatting = true;
        i = end + 1;
        continue;
      }
    }

    // Bold + italic: ***text***
    if (text.slice(i, i + 3) === '***') {
      const end = text.indexOf('***', i + 3);
      if (end !== -1) {
        const inner = text.slice(i + 3, end);
        result += style.bold + style.italic + PRIMARY_COLOR + inner + '\x1b[0m';
        hasFormatting = true;
        i = end + 3;
        continue;
      }
    }

    // Bold: **text**
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        result += style.bold + PRIMARY_COLOR + inner + '\x1b[0m';
        hasFormatting = true;
        i = end + 2;
        continue;
      }
    }

    // Italic: *text*
    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && end > i + 1) {
        const inner = text.slice(i + 1, end);
        result += style.italic + inner + '\x1b[0m';
        hasFormatting = true;
        i = end + 1;
        continue;
      }
    }

    // Strikethrough: ~~text~~ — using the SGR strikethrough escape (\x1b[9m).
    // Widely supported in modern terminals (iTerm2, Kitty, WezTerm, Alacritty,
    // gnome-terminal, Windows Terminal). Falls back gracefully to the dim
    // text colour on terminals that don't render the SGR.
    if (text.slice(i, i + 2) === '~~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        result += '\x1b[9m' + fg.rgb(140, 140, 140) + inner + '\x1b[0m';
        hasFormatting = true;
        i = end + 2;
        continue;
      }
    }

    result += text[i];
    i++;
  }

  return { formatted: result, hasFormatting };
}

// ─── Word wrap ────────────────────────────────────────────────────────────────

/**
 * Word-wrap `text` to `maxWidth` columns. Words wider than `maxWidth`
 * (typically long file paths with no spaces) are hard-broken across lines.
 *
 * Note: this is NOT the `wordWrap` exported from `ansi.ts` — that one
 * lets over-width words overflow. This chat-flavoured variant slices
 * them so a 200-char path doesn't blow out the right margin.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const wordW = stringWidth(word);
    // Hard-break words wider than maxWidth (e.g. long file paths with no spaces)
    if (wordW > maxWidth) {
      if (currentLine) { lines.push(currentLine); currentLine = ''; }
      // Slice the word into maxWidth chunks
      let remaining = word;
      while (stringWidth(remaining) > maxWidth) {
        lines.push(remaining.slice(0, maxWidth));
        remaining = remaining.slice(maxWidth);
      }
      currentLine = remaining;
      continue;
    }
    if (stringWidth(currentLine) + wordW + 1 > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine += (currentLine ? ' ' : '') + word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

// ─── Text lines ───────────────────────────────────────────────────────────────

/**
 * Format a chunk of prose (text between code fences) into styled lines.
 *
 * Recognises, per line:
 *   - ATX headings (`#` … `######`)
 *   - horizontal rules (`---`, `***`, `___`)
 *   - blockquotes (`> …`, nestable)
 *   - bullet/numbered list items (`-`, `*`, `1.`)
 *   - plain text, with inline markdown + word-wrap
 *
 * `firstPrefix` / `firstStyle` apply only to the first output line — the
 * caller uses that to attach the role indicator (▌ for user, ▸ for system);
 * continuation lines get a blank/generic prefix so wrapped paragraphs stay
 * visually grouped under the same marker.
 */
export function formatTextLines(
  text: string,
  maxWidth: number,
  firstPrefix: string,
  firstStyle: string,
  rawPrefix = false,
): RenderedLine[] {
  const lines: RenderedLine[] = [];
  const contentLines = text.split('\n');

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    const prefix = i === 0 ? firstPrefix : '  ';
    const prefixStyle = i === 0 ? firstStyle : '';
    const isRaw = i === 0 ? rawPrefix : false;

    // Heading: ## or ### etc.
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const headingColor = level <= 2 ? fg.rgb(97, 175, 239) : fg.rgb(198, 120, 221);
      lines.push({
        text: prefix + headingColor + style.bold + headingText + '\x1b[0m',
        style: prefixStyle,
        raw: true,
      });
      continue;
    }

    // Horizontal rule: --- or *** or ___
    if (/^[-*_]{3,}\s*$/.test(line)) {
      const ruleWidth = Math.min(maxWidth - 4, 40);
      lines.push({
        text: prefix + fg.gray + '─'.repeat(ruleWidth) + '\x1b[0m',
        style: prefixStyle,
        raw: true,
      });
      continue;
    }

    // Blockquote: `> text` — render with a left accent bar (PRIMARY_COLOR)
    // and the body in a dimmer grey so it visually sits behind regular text.
    // Strips one level of `> ` so nested quotes render with their own bar.
    const quoteMatch = line.match(/^(\s*)>\s?(.*)$/);
    if (quoteMatch) {
      const indent = quoteMatch[1];
      const quoteText = quoteMatch[2];
      const { formatted, hasFormatting } = applyInlineMarkdown(quoteText);
      const body = hasFormatting ? formatted : quoteText;
      // Vertical bar + space, then dim grey body. Skip if the body is
      // empty so an isolated `>` renders cleanly.
      const barred = PRIMARY_COLOR + '│' + '\x1b[0m' + (body ? ' ' + fg.rgb(160, 160, 160) + body + '\x1b[0m' : '');
      lines.push({
        text: prefix + indent + barred,
        style: prefixStyle,
        raw: true,
      });
      continue;
    }

    // List items: - item or * item or numbered 1. item
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1];
      const bullet = listMatch[2];
      const content = listMatch[3];
      const { formatted, hasFormatting } = applyInlineMarkdown(content);
      const bulletChar = bullet === '-' || bullet === '*' ? '\u25b8' : bullet;
      if (hasFormatting) {
        lines.push({
          text: prefix + indent + fg.gray + bulletChar + '\x1b[0m' + ' ' + formatted,
          style: prefixStyle,
          raw: true,
        });
      } else {
        lines.push({
          text: prefix + indent + bulletChar + ' ' + content,
          style: prefixStyle,
        });
      }
      continue;
    }

    // Regular text with possible inline markdown
    const { formatted, hasFormatting } = applyInlineMarkdown(line);

    if (hasFormatting) {
      // Use original (no-ANSI) line to measure and wrap, then apply markdown per segment
      if (stringWidth(line) > maxWidth - prefix.length) {
        const wrapped = wordWrap(line, maxWidth - prefix.length);
        for (let j = 0; j < wrapped.length; j++) {
          const { formatted: segFormatted } = applyInlineMarkdown(wrapped[j]);
          lines.push({
            text: (j === 0 ? prefix : '  ') + segFormatted,
            style: j === 0 ? prefixStyle : '',
            raw: true,
          });
        }
      } else {
        lines.push({
          text: prefix + formatted,
          style: prefixStyle,
          raw: true,
        });
      }
    } else {
      // Plain text - word wrap as before
      if (stringWidth(line) > maxWidth - prefix.length) {
        const wrapped = wordWrap(line, maxWidth - prefix.length);
        for (let j = 0; j < wrapped.length; j++) {
          const lineIsRaw = j === 0 ? isRaw : false;
          lines.push({
            text: (j === 0 ? prefix : '  ') + wrapped[j],
            style: j === 0 ? prefixStyle : '',
            ...(lineIsRaw ? { raw: true } : {}),
          });
        }
      } else {
        lines.push({
          text: prefix + line,
          style: prefixStyle,
          ...(isRaw ? { raw: true } : {}),
        });
      }
    }
  }

  return lines;
}

// ─── Code block ───────────────────────────────────────────────────────────────

/**
 * Format a fenced code block: language label + block number on the first
 * line, then each source line indented and syntax-highlighted via
 * `highlightCode`. A trailing blank line separates the block from the
 * next paragraph.
 *
 * `blockNum` is the 1-based index used by `/copy [n]`; omitted when the
 * caller is rendering a non-chat context (e.g. a paste preview).
 */
export function formatCodeBlock(
  code: string,
  lang: string,
  maxWidth: number,
  blockNum?: number,
): RenderedLine[] {
  const lines: RenderedLine[] = [];
  const codeLines = code.split('\n');

  // Remove trailing empty line if exists
  if (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') {
    codeLines.pop();
  }

  // Language label with block number for /copy
  const label = blockNum ? (lang ? `  ${lang} [${blockNum}]` : `  [${blockNum}]`) : (lang ? '  ' + lang : '');
  if (label) {
    lines.push({ text: label, style: SYNTAX.codeLang, raw: false });
  }

  // Code lines with highlighting and indent
  for (const codeLine of codeLines) {
    const highlighted = highlightCode(codeLine, lang);
    lines.push({
      text: '    ' + highlighted,
      style: '',
      raw: true,  // Don't apply additional styling, code is pre-highlighted
    });
  }

  // Empty line after code block
  lines.push({ text: '', style: '', raw: false });

  return lines;
}

// ─── Message ──────────────────────────────────────────────────────────────────

/**
 * Format a full chat message (role + content) into styled lines.
 *
 * Walks the content looking for `` ``` ``-fenced code blocks; anything
 * outside a fence goes through `formatTextLines` (headings, lists, inline
 * markdown), fenced regions go through `formatCodeBlock`. The fenced-block
 * regex is non-greedy and stops at the first closing fence, so streaming
 * input with an as-yet-unclosed fence still renders correctly (the open
 * tail is treated as plain text until the closer arrives).
 *
 * `counter` is incremented once per fenced block encountered — callers
 * thread the same `BlockCounter` across consecutive `formatMessage`
 * calls so block numbers are stable across a whole render pass.
 */
export function formatMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  maxWidth: number,
  counter: BlockCounter,
): RenderedLine[] {
  const lines: RenderedLine[] = [];

  // Role-specific prefix — user gets primary color bar, assistant gets dim header, system gets diamond
  const contIndent = '   ';
  let firstPrefix: string;
  const firstStyle = '';

  if (role === 'user') {
    firstPrefix = PRIMARY_COLOR + '\u258c ' + style.reset;
  } else if (role === 'assistant') {
    lines.push({ text: PRIMARY_COLOR + '\u254c\u254c' + style.reset + fg.rgb(120, 120, 120) + ' codeep' + style.reset, style: '', raw: true });
    firstPrefix = ' ';
  } else {
    firstPrefix = PRIMARY_COLOR + '\u25b8 ' + style.reset;
  }

  const codeBlockRegex = /```([^\n]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  let isFirstLine = true;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index);
    if (textBefore) {
      const prefix = isFirstLine ? firstPrefix : (role === 'user' ? contIndent : ' ');
      const textLines = formatTextLines(textBefore, maxWidth, prefix, firstStyle, role === 'user' && isFirstLine);
      lines.push(...textLines);
      isFirstLine = false;
    }

    counter.current++;
    const rawLang = (match[1] || 'text').trim();
    let lang = rawLang;
    if (rawLang.includes(':') || rawLang.includes('.')) {
      lang = rawLang.split('.').pop() || rawLang;
    }
    lines.push(...formatCodeBlock(match[2], lang, maxWidth, counter.current));
    lastIndex = match.index + match[0].length;
    isFirstLine = false;
  }

  const textAfter = content.slice(lastIndex);
  if (textAfter) {
    const prefix = isFirstLine ? firstPrefix : (role === 'user' ? contIndent : ' ');
    const textLines = formatTextLines(textAfter, maxWidth, prefix, firstStyle, role === 'user' && isFirstLine);
    lines.push(...textLines);
  }

  lines.push({ text: '', style: '' });
  return lines;
}
