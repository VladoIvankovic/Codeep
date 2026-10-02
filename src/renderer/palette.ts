/**
 * The renderer's truecolour palette.
 *
 * Codeep paints with two kinds of colour. The 16 basic ANSI colours
 * (`fg.red`, `fg.gray`, …) are indices into the terminal's own palette, so
 * they already follow whatever theme the terminal has — Omarchy recolours the
 * terminal and those change with it. Everything painted with `fg.rgb(…)` is a
 * literal, and stays the same red and the same One Dark syntax colours on a
 * light theme, a Gruvbox theme, any theme. This module is where those
 * literals live now, under the role each one plays, so something can swap
 * them (omarchyTheme.ts) and every surface picks the new value up — along
 * with the few terminal colours that a terminal theme does not make
 * readable (TERMINAL_DEFAULTS).
 *
 * Every read happens at RENDER time: `palette.<role>` is a getter, and
 * `PRIMARY_COLOR` / `PRIMARY_BRIGHT` are live ES bindings that setPalette()
 * reassigns. A colour copied into a module-level constant
 * (`const X = PRIMARY_COLOR + '…'`) would be baked at import and never
 * change again — don't.
 *
 * The defaults are the exact values Codeep painted before this module
 * existed, so without a theme every escape sequence is byte-identical to what
 * it was (pinned by palette.defaults.test.ts).
 */
import { fg, bg } from './ansi';

export type Rgb = readonly [number, number, number];

/**
 * Every truecolour role, with the colour it has when nothing overrides it.
 *
 * Grouped the way they are derived from a theme (see omarchyTheme.ts): the
 * brand pair, the neutral greys of the chat chrome, the coloured accents of
 * the welcome banner and markdown, and the syntax colours of code blocks.
 */
export const DEFAULT_PALETTE = Object.freeze({
  // ── Brand ────────────────────────────────────────────────────────────────
  /** Brand red: logo, borders, prompts, the user bar, every panel title. */
  primary: [240, 42, 48],
  /** The selected row of a list or modal, and modal titles. */
  primaryBright: [255, 80, 85],

  // ── Neutral greys, faintest first ────────────────────────────────────────
  /** The `·` separators in the welcome banner. */
  separator: [80, 80, 80],
  /** Welcome field labels: Project, Access, Mode. */
  label: [100, 100, 100],
  /** The `codeep` label above each assistant message. */
  assistantLabel: [120, 120, 120],
  /** The model name in the welcome version line. */
  modelName: [130, 130, 130],
  /** ~~Struck-through~~ markdown. */
  strikethrough: [140, 140, 140],
  /** The welcome shortcuts line (`/help · Ctrl+L clear · …`). */
  hint: [150, 150, 150],
  /** Secondary body text: the welcome Mode value, blockquote bodies. */
  secondaryText: [160, 160, 160],
  /** The provider name in the welcome version line. */
  providerName: [180, 180, 180],

  // ── Coloured accents ─────────────────────────────────────────────────────
  /** The project path in the welcome banner. */
  path: [100, 180, 220],
  /** The welcome access level (Read & Write / Read Only). */
  success: [100, 200, 120],
  /** What follows the access level (`Agent enabled`). */
  successDetail: [80, 160, 100],
  /** Welcome-banner warnings (⚠ lines). */
  warning: [220, 160, 40],
  /** `inline code` in markdown. */
  inlineCode: [209, 154, 102],
  /** Markdown `#` and `##` headings. */
  heading: [97, 175, 239],
  /** Markdown `###` and deeper headings. */
  subheading: [198, 120, 221],

  // ── Code blocks (One Dark) ───────────────────────────────────────────────
  syntaxKeyword: [198, 120, 221],
  syntaxString: [152, 195, 121],
  syntaxNumber: [209, 154, 102],
  syntaxComment: [92, 99, 112],
  syntaxFunction: [97, 175, 239],
  syntaxType: [229, 192, 123],
  syntaxOperator: [86, 182, 194],
  /** Removed lines in a ```diff block (added lines use syntaxString). */
  syntaxRemoved: [224, 108, 117],
  /** SYNTAX.codeFrame. Nothing in the TUI draws a code frame today; the role
   *  is kept so the exported SYNTAX shape is unchanged. */
  codeFrame: [100, 105, 115],
  /** A code block's language label, and a diff's ---/+++ file lines. */
  codeLang: [150, 155, 165],
} satisfies Record<string, Rgb>);

/**
 * The roles Codeep paints in the TERMINAL's colours — a basic ANSI index, or
 * an xterm-256 one — with the escape each one is painted with when nothing
 * overrides it.
 *
 * Most terminal colours are left to the terminal: Omarchy recolours it, so
 * they follow already. These are the ones that do not follow well enough to
 * be left there. Bright black (code punctuation) is Omarchy's `muted`, a
 * decoration colour, below 3:1 on 20 of its 22 themes; yellow is 2–2.3:1 on
 * its light themes; and index 208, the warning orange, is set by no theme at
 * all, so it stays #ff8700 everywhere. Only a theme gives these an RGB value; without
 * one they keep the escape they had, so the bytes do not change.
 */
export const TERMINAL_DEFAULTS = Object.freeze({
  /** Code punctuation: `( ) { } ; , . :`. ANSI bright black. */
  syntaxPunctuation: fg.gray,
  /** The confirm modal's border and title, and the input line's "Select …
   *  below" prompts while a picker is open. ANSI yellow. */
  attention: fg.yellow,
  /** Warning toasts on the status bar: errors, retries. xterm 208. */
  warningToast: fg.color256(208),
  /** The `--yolo` badge's fill (a BACKGROUND colour), xterm 208… */
  yoloBadge: bg.color256(208),
  /** …and its text, ANSI black. */
  yoloBadgeText: fg.black,
} satisfies Record<string, string>);

export type PaletteRole = keyof typeof DEFAULT_PALETTE;
export type TerminalRole = keyof typeof TERMINAL_DEFAULTS;
export type PaletteColors = Record<PaletteRole, Rgb>;
/** What a theme hands setPalette(): an RGB value for any role of either kind. */
export type PaletteOverrides = Partial<Record<PaletteRole | TerminalRole, Rgb>>;

export const PALETTE_ROLES = Object.keys(DEFAULT_PALETTE) as PaletteRole[];
export const TERMINAL_ROLES = Object.keys(TERMINAL_DEFAULTS) as TerminalRole[];

/** The terminal roles that colour a cell's background rather than its text. */
const BACKGROUND_ROLES: ReadonlySet<TerminalRole> = new Set(['yoloBadge']);

function escapesFor(colors: PaletteColors, terminal: Partial<Record<TerminalRole, Rgb>>): Record<PaletteRole | TerminalRole, string> {
  const out = {} as Record<PaletteRole | TerminalRole, string>;
  for (const role of PALETTE_ROLES) out[role] = fg.rgb(...colors[role]);
  for (const role of TERMINAL_ROLES) {
    const rgb = terminal[role];
    out[role] = !rgb ? TERMINAL_DEFAULTS[role] : BACKGROUND_ROLES.has(role) ? bg.rgb(...rgb) : fg.rgb(...rgb);
  }
  return out;
}

function isRgb(value: unknown): value is Rgb {
  return Array.isArray(value)
    && value.length === 3
    && value.every(c => Number.isInteger(c) && c >= 0 && c <= 255);
}

let colors: PaletteColors = { ...DEFAULT_PALETTE };
/** The terminal roles a theme has given a colour; absent means its escape. */
let terminalColors: Partial<Record<TerminalRole, Rgb>> = {};
// The escape strings, built once per palette change rather than once per
// cell: the render loop reads these thousands of times a frame.
let escapes = escapesFor(colors, terminalColors);

/** Brand red, as an escape sequence. A live binding: setPalette() reassigns it. */
export let PRIMARY_COLOR = escapes.primary;
/** The bright brand variant, as an escape sequence. Live, like PRIMARY_COLOR. */
export let PRIMARY_BRIGHT = escapes.primaryBright;

/**
 * The current foreground escape for every role, read at the moment it is
 * used: `palette.hint + text + style.reset`.
 */
export const palette = {} as { readonly [R in PaletteRole | TerminalRole]: string };
for (const role of [...PALETTE_ROLES, ...TERMINAL_ROLES]) {
  Object.defineProperty(palette, role, { get: () => escapes[role], enumerable: true });
}

/**
 * The current colour of every role, and of each terminal role a theme has
 * given one — so with no theme it equals DEFAULT_PALETTE exactly.
 */
export function getPalette(): Readonly<PaletteColors & Partial<Record<TerminalRole, Rgb>>> {
  return { ...colors, ...terminalColors };
}

const listeners = new Set<() => void>();

/**
 * Run `listener` after every palette change that changed a colour. Returns
 * the unsubscribe. The App uses it to drop its formatted-message cache and
 * repaint, which is the whole of what a theme switch needs from it.
 */
export function onPaletteChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Replace the palette: every role in `overrides` takes that colour, every
 * other role its default. `null` (or `{}`) is the default palette.
 *
 * Returns whether any colour changed, and only then tells the listeners —
 * a theme switch touches several files and can land here more than once
 * with the same colours, and each of those must not cost a full repaint.
 * A value that is not three 0–255 integers is ignored, not trusted: the
 * overrides come from a file on disk.
 */
export function setPalette(overrides: PaletteOverrides | null): boolean {
  const next: PaletteColors = { ...DEFAULT_PALETTE };
  for (const role of PALETTE_ROLES) {
    const value = overrides?.[role];
    if (isRgb(value)) next[role] = [value[0], value[1], value[2]];
  }
  const nextTerminal: Partial<Record<TerminalRole, Rgb>> = {};
  for (const role of TERMINAL_ROLES) {
    const value = overrides?.[role];
    if (isRgb(value)) nextTerminal[role] = [value[0], value[1], value[2]];
  }
  const same = (a: Rgb | undefined, b: Rgb | undefined) => a === b || (!!a && !!b && a.every((c, i) => c === b[i]));
  const changed = PALETTE_ROLES.some(role => !same(next[role], colors[role]))
    || TERMINAL_ROLES.some(role => !same(nextTerminal[role], terminalColors[role]));
  if (!changed) return false;

  colors = next;
  terminalColors = nextTerminal;
  escapes = escapesFor(colors, terminalColors);
  PRIMARY_COLOR = escapes.primary;
  PRIMARY_BRIGHT = escapes.primaryBright;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A repaint that fails must not stop the others, or leave the palette
      // half-announced.
    }
  }
  return true;
}

/** Back to the colours Codeep ships with. */
export function resetPalette(): boolean {
  return setPalette(null);
}
