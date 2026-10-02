/**
 * Welcome-screen formatter.
 *
 * Pure function extracted from `App.ts` so the welcome banner's colour
 * rules can be unit-tested without instantiating the full renderer.
 * Called once per render for messages whose `role` is `'welcome'`.
 */
import { style } from '../ansi';
import { palette } from '../palette';
import { PRIMARY_COLOR } from './uiConstants';

export interface FormattedLine {
  text: string;
  style: string;
  raw?: boolean;
}

/**
 * Format the welcome message body into coloured terminal lines.
 *
 * The body is a small DSL of line shapes:
 *   - `Codeep vX.X.X  ·  Provider  ·  Model` — version header
 *   - `  Project <path>`                     — project label
 *   - `  Access <read · write>`              — access label
 *   - `  Mode <mode>`                        — mode label
 *   - lines containing `⚠`                   — amber warning
 *   - lines containing `/help`               — shortcuts hint
 *
 * Anything else is pushed verbatim.
 */
export function formatWelcomeMessage(content: string): FormattedLine[] {
  const lines: FormattedLine[] = [];
  // Read here, per call, not at module scope: the palette can change while
  // Codeep runs (an Omarchy theme switch) and the next format must see it.
  const DIM = palette.separator;
  const LABEL = palette.label;
  const SEP = DIM + '  ·  ' + style.reset;

  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      lines.push({ text: '', style: '' });
      continue;
    }

    // Version line: "Codeep vX.X.X  ·  Provider  ·  Model"
    if (line.startsWith('Codeep ')) {
      const parts = line.split('  ·  ');
      const colored = PRIMARY_COLOR + style.bold + (parts[0] || '') + style.reset
        + SEP + palette.providerName + (parts[1] || '') + style.reset
        + SEP + palette.modelName + (parts[2] || '') + style.reset;
      lines.push({ text: colored, style: '', raw: true });
      continue;
    }

    // Project line
    if (/^\s+Project\s/.test(line)) {
      const value = line.replace(/^\s+Project\s+/, '');
      lines.push({ text: LABEL + '  Project  ' + style.reset + palette.path + value + style.reset, style: '', raw: true });
      continue;
    }

    // Access line
    if (/^\s+Access\s/.test(line)) {
      const value = line.replace(/^\s+Access\s+/, '');
      const parts = value.split('  ·  ');
      const accessColored = palette.success + style.bold + (parts[0] || '') + style.reset;
      const rest = parts.slice(1).map(p => palette.successDetail + p + style.reset).join(SEP);
      lines.push({ text: LABEL + '  Access   ' + style.reset + accessColored + (rest ? SEP + rest : ''), style: '', raw: true });
      continue;
    }

    // Mode line
    if (/^\s+Mode\s/.test(line)) {
      const value = line.replace(/^\s+Mode\s+/, '');
      lines.push({ text: LABEL + '  Mode     ' + style.reset + palette.secondaryText + value + style.reset, style: '', raw: true });
      continue;
    }

    // Agent Mode warning
    if (line.includes('⚠')) {
      lines.push({ text: '  ' + palette.warning + line.trim() + style.reset, style: '', raw: true });
      continue;
    }

    // Shortcuts line
    if (line.includes('/help')) {
      const parts = line.trim().split('  ·  ');
      const colored = parts.map(p => palette.hint + p.trim() + style.reset).join(DIM + '  ·  ' + style.reset);
      lines.push({ text: '  ' + colored, style: '', raw: true });
      continue;
    }

    lines.push({ text: line, style: '' });
  }

  lines.push({ text: '', style: '' });
  return lines;
}
