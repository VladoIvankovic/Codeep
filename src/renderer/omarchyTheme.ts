/**
 * Follow the Omarchy desktop theme.
 *
 * Omarchy (Arch + Hyprland) switches every app's colours at once with
 * `omarchy-theme-set`. The terminal is one of them, so Codeep's basic ANSI
 * colours already follow; what does not is everything Codeep paints in
 * truecolour — the brand red, the greys of the chat chrome, the One Dark code
 * colours. This module reads the theme Omarchy has selected and hands those
 * roles to the palette, and keeps doing it while Codeep runs, so switching
 * the theme recolours an open session the way it does Claude Code, OpenCode,
 * Pi and Hermes.
 *
 * Only ever READS Omarchy's state. Omarchy also runs user hooks from
 * ~/.config/omarchy/hooks/theme-set.d/, but writing one would mean editing
 * the user's desktop config to suit one CLI; watching the directory needs
 * nothing from them.
 *
 * Where the theme lives — `~/.local/state/omarchy/current/theme/colors.toml`
 * (CURRENT_THEME_PATH in bin/omarchy-theme-set) — and what a switch does to
 * it decide how this watches it: the switch stages the new theme beside the
 * old one and then `rm -rf current/theme; mv next-theme current/theme`. A
 * watch on colors.toml, or on theme/, would be watching an inode that is
 * deleted on the first switch. So the watch is on `current/`, which a switch
 * never replaces, and the one on `theme/` is re-made after each change.
 */
import { readFileSync, statSync, watch, type FSWatcher } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { DEFAULT_PALETTE, setPalette, type PaletteOverrides, type PaletteRole, type Rgb } from './palette';

// ─── colors.toml ─────────────────────────────────────────────────────────────

/**
 * Read the `key = "value"` lines of a colors.toml.
 *
 * Not a TOML parser, and deliberately so: a colors.toml is a flat list of
 * quoted hex strings, and Omarchy's own reader (bin/omarchy-theme-color) is a
 * shell `read` loop that understands exactly this much. Comments and blank
 * lines are skipped, a value may be single- or double-quoted with a comment
 * after it, a bare value is taken up to the first space, and anything else —
 * a `[table]`, an array, a line with no `=` — is ignored rather than
 * reported. Never throws: a theme Codeep cannot read is a theme it leaves
 * alone, not a reason to stop starting.
 */
export function parseColorsToml(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const rest = line.slice(eq + 1).trim();
    let value: string | undefined;
    const quoted = /^(["'])(.*?)\1/.exec(rest);
    if (quoted) value = quoted[2];
    else if (rest && !/^["'[{]/.test(rest)) value = rest.split(/\s/)[0];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** `#rrggbb` or `#rgb`, either case; null for anything else. */
export function parseHexColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  return null;
}

// ─── Colour arithmetic ───────────────────────────────────────────────────────

/**
 * `{{ mix a b 30% }}` from Omarchy's templates: 70% of `a`, 30% of `b`,
 * rounded the way its awk does it, so a role derived here lands on the same
 * colour the theme's other apps derived.
 */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const channel = (i: number) => Math.floor(a[i] * (1 - amount) + b[i] * amount + 0.5);
  return [channel(0), channel(1), channel(2)];
}

/**
 * Whether two colours are close enough (under 32 apart in sRGB, an eighth
 * of the range) to be taken for one another side by side.
 */
function looksLike(a: Rgb, b: Rgb): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 32;
}

/** WCAG relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (none) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The least share of `toward` that, mixed into `from`, reads at
 * `minContrast` on `background`: 0 when `from` already does, 1 when even
 * `toward` does not.
 *
 * Omarchy palettes are tuned for their terminals, and a few of their colours
 * sit close to their own background when used as TEXT: catppuccin-latte's
 * yellow and magenta are 2.3:1 on its near-white, everforest's
 * dark_foreground 1.7:1. Codeep paints keywords, types and comments in those,
 * so a light theme would otherwise get code it cannot read. Moving toward the
 * foreground keeps the hue's family and works the same on dark and light
 * themes, and a colour that already reads is not moved at all. The least
 * share, found by bisection rather than in fixed steps, so a colour lands on
 * the contrast asked of it rather than a step past — which is also what
 * places each grey at the contrast greyContrast() picks for it.
 */
function leastMixToRead(from: Rgb, toward: Rgb, background: Rgb, minContrast: number): number {
  if (contrastRatio(from, background) >= minContrast) return 0;
  if (contrastRatio(toward, background) < minContrast) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(from, toward, mid), background) >= minContrast) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The terminal Codeep's greys were picked on: a stock dark one (VS Code's,
 * #cccccc on #1e1e1e). Each grey's default is measured against it to find
 * where that grey sits between barely readable and body text.
 */
const REFERENCE_BACKGROUND: Rgb = [30, 30, 30];
const REFERENCE_FOREGROUND: Rgb = [204, 204, 204];

/**
 * The contrast a grey should have on a theme whose body text is
 * `bodyContrast`: the same place, between `floor` and the body text, that
 * `reference` has on the reference terminal — measured in log contrast,
 * because that is how far apart two greys look.
 *
 * A fixed sRGB mix (40% of the way to the foreground, 66%…) was tuned on a
 * dark terminal, and on a light one the same share reads much fainter: on
 * catppuccin-latte 40–60% all fall under 3:1, so the floor pushed the label,
 * the model name and struck-through text onto one grey. Going by contrast
 * instead keeps both the greys' order and their spacing on every theme, and
 * a theme like the reference terminal gets back each default's own contrast.
 * Never past the body text, which a theme with little contrast to spare may
 * leave below a floor: there the grey is the foreground.
 */
export function greyContrast(reference: Rgb, floor: number, bodyContrast: number): number {
  const referenceBody = contrastRatio(REFERENCE_FOREGROUND, REFERENCE_BACKGROUND);
  const place = Math.log(contrastRatio(reference, REFERENCE_BACKGROUND) / floor) / Math.log(referenceBody / floor);
  const share = Math.min(1, Math.max(0, place));
  return Math.min(bodyContrast, floor * (bodyContrast / floor) ** share);
}

// ─── Theme → palette ─────────────────────────────────────────────────────────

/**
 * The palette roles a theme defines, following the conventions Omarchy's own
 * templates use for Claude Code and Pi (default/themed/claude.json.tpl,
 * pi.json.tpl) so Codeep sits beside them in the same colours:
 *
 *   accent             → the brand colour (Claude's `claude`, Pi's `accent`),
 *                        or blue for a theme whose accent is its foreground
 *   brand + 35% fg     → its bright variant (Claude's `claudeShimmer`)
 *   bg → fg            → the greys, each at the contrast greyContrast() gives
 *                        it, code punctuation among them (Pi's
 *                        `syntaxPunctuation` is its muted text, the hint grey)
 *   magenta, green, orange, blue, yellow, cyan, red, dark_foreground
 *                      → keyword, string, number, function, type, operator,
 *                        removed line, comment
 *   cyan / green / yellow → the welcome path / access level / warning
 *   yellow             → warning toasts, the confirm modal, the picker
 *                        prompts, and the YOLO badge (Claude's `warning` and
 *                        `autoAccept`)
 *
 * The greys are mixes of the theme's own background and foreground rather
 * than fixed values because Codeep's defaults assume a dark terminal: on a
 * light theme a fixed rgb(80,80,80) separator is near-black and the
 * hierarchy inverts. A mix keeps its place between background and
 * foreground in either mode, which is why `mode` never needs reading.
 *
 * Every colour that is text has a floor it is moved up to if the theme puts
 * it below: 4.5:1 for what is read as sentences (the warning, the shortcut
 * hints, blockquotes), 3:1 for code and short tokens, 2.5:1 for the welcome
 * labels, 1.5:1 for separators that are only decoration.
 *
 * A role whose source key is missing or unparseable is left out, so it keeps
 * its default. The legacy short names Omarchy still accepts for these keys
 * (bg, fg, dark_fg, color0–8, purple) are honoured the way its resolver
 * honours them.
 */
export function paletteFromOmarchy(values: Record<string, string>): PaletteOverrides {
  const pick = (...keys: string[]): Rgb | null => {
    for (const key of keys) {
      const rgb = parseHexColor(values[key]);
      if (rgb) return rgb;
    }
    return null;
  };
  const background = pick('background', 'bg', 'color0');
  const foreground = pick('foreground', 'fg', 'color7');
  const accent = pick('accent');
  const red = pick('red', 'color1');
  const green = pick('green', 'color2');
  const yellow = pick('yellow', 'color3');
  const blue = pick('blue', 'color4');
  const magenta = pick('magenta', 'purple', 'color5');
  const cyan = pick('cyan', 'color6');
  // Omarchy's resolver falls back to yellow for a theme with no orange.
  const orange = pick('orange') ?? yellow;
  const darkForeground = pick('dark_foreground', 'dark_fg', 'color8');

  const out: PaletteOverrides = {};
  /** A theme colour as text: moved toward the foreground if it would not read. */
  const set = (role: keyof PaletteOverrides, color: Rgb | null, minContrast = 3) => {
    if (!color) return;
    out[role] = background && foreground
      ? mix(color, foreground, leastMixToRead(color, foreground, background, minContrast))
      : color;
  };
  /**
   * A grey from background toward foreground, at the contrast greyContrast()
   * gives a grey whose default is `reference`.
   */
  const grey = (role: keyof PaletteOverrides, reference: Rgb, minContrast: number) => {
    if (!background || !foreground) return;
    const target = greyContrast(reference, minContrast, contrastRatio(foreground, background));
    out[role] = mix(background, foreground, leastMixToRead(background, foreground, background, target));
  };

  // Kanagawa's accent IS its foreground. Codeep marks the selected row of
  // every menu, list and settings screen with its brand colour, so in body
  // text colour the selection would be told apart only by bold and the ►
  // marker; the brand pair moves to blue (Claude's `permission`) instead.
  const brand = accent && foreground && blue && looksLike(accent, foreground) && !looksLike(blue, foreground)
    ? blue
    : accent;
  set('primary', brand);
  set('primaryBright', brand && foreground ? mix(brand, foreground, 0.35) : brand);

  const greyAt = (role: PaletteRole, minContrast: number) => grey(role, DEFAULT_PALETTE[role], minContrast);
  greyAt('separator', 1.5);
  greyAt('codeFrame', 1.5);
  greyAt('label', 2.5);
  greyAt('assistantLabel', 3);
  greyAt('modelName', 3);
  greyAt('strikethrough', 3);
  greyAt('hint', 4.5);
  greyAt('codeLang', 3);
  greyAt('secondaryText', 4.5);
  greyAt('providerName', 3);
  grey('syntaxPunctuation', DEFAULT_PALETTE.hint, 3);

  set('path', cyan);
  set('success', green);
  set('successDetail', green && background ? mix(green, background, 0.25) : green);
  set('warning', yellow, 4.5);
  set('inlineCode', orange);
  set('heading', blue);
  set('subheading', magenta);

  set('syntaxKeyword', magenta);
  set('syntaxString', green);
  set('syntaxNumber', orange);
  set('syntaxComment', darkForeground);
  set('syntaxFunction', blue);
  set('syntaxType', yellow);
  set('syntaxOperator', cyan);
  set('syntaxRemoved', red);

  // The terminal-coloured roles: a toast and a prompt are read like the
  // welcome warning, so they take its colour, floor and all.
  if (out.warning) {
    out.warningToast = out.warning;
    out.attention = out.warning;
  }
  // The badge is a fill, so it takes the theme's yellow as it is, and for
  // its text whichever of the theme's two colours, black or white reads best
  // on it. ANSI black, its text by default, is the theme's background: near-
  // white on a light theme, and matte-black's "yellow" is a dark red.
  if (yellow) {
    const candidates: Rgb[] = [[0, 0, 0], [255, 255, 255]];
    if (background) candidates.unshift(background);
    if (foreground) candidates.unshift(foreground);
    out.yoloBadge = yellow;
    out.yoloBadgeText = candidates.reduce((best, c) => (contrastRatio(c, yellow) > contrastRatio(best, yellow) ? c : best));
  }
  return out;
}

// ─── Reading the current theme ───────────────────────────────────────────────

/** `~/.local/state/omarchy/current` — Omarchy's path, which ignores XDG_STATE_HOME. */
export function omarchyStateDir(home: string = homedir()): string {
  return join(home, '.local', 'state', 'omarchy', 'current');
}

/**
 * The palette the current Omarchy theme asks for, or null when there is no
 * readable colors.toml (not Omarchy, a theme without one, a permissions
 * problem) — null meaning "Codeep's own colours".
 */
export function loadOmarchyPalette(stateDir: string = omarchyStateDir()): PaletteOverrides | null {
  let text: string;
  try {
    text = readFileSync(join(stateDir, 'theme', 'colors.toml'), 'utf8');
  } catch {
    return null;
  }
  const roles = paletteFromOmarchy(parseColorsToml(text));
  return Object.keys(roles).length > 0 ? roles : null;
}

/**
 * Put the palette where the setting says: the current theme's colours when
 * following is on, Codeep's own when it is off. Returns whether anything
 * changed (setPalette only repaints then).
 */
export function applyOmarchyTheme(stateDir: string, follow: boolean): boolean {
  return setPalette(follow ? loadOmarchyPalette(stateDir) : null);
}

// ─── Following it live ───────────────────────────────────────────────────────

export interface OmarchyThemeOptions {
  /** Defaults to omarchyStateDir(); tests point it at a temp directory. */
  stateDir?: string;
  /** Whether to follow the theme now — the /settings switch. Asked on every
   *  reload, so turning it off or on needs no restart. Default: always. */
  enabled?: () => boolean;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** How long a burst of file events must go quiet before reloading. */
  debounceMs?: number;
}

export interface OmarchyThemeWatch {
  /** Read the theme and the setting again now. */
  reload(): void;
  /** Close the watches. */
  stop(): void;
}

/** The running watch, for reapplyOmarchyTheme(). One per process. */
let active: OmarchyThemeWatch | null = null;

/** A watch, and the directory inode it was made on. */
type DirWatch = { watcher: FSWatcher; dir: string; ino: number };

/**
 * Apply the current Omarchy theme and follow it until stop().
 *
 * Returns null — doing nothing at all — off Linux or when there is no
 * Omarchy state directory, so every other machine runs exactly as before.
 *
 * The watch on `current/` sees every switch by itself. Omarchy also tells
 * OpenCode with SIGUSR2 (bin/omarchy-restart-opencode), but by its process
 * name, so Codeep is never sent it — and must not handle it anyway. The
 * config store's exit hook (when-exit, which conf's atomically installs)
 * catches SIGUSR2 with SIGTERM, SIGHUP and the rest, runs its cleanup once,
 * and raises the signal again to end the process. A handler that kept the
 * process alive would leave that hook spent, and the next SIGTERM or SIGHUP
 * would then not end the session.
 *
 * Watches are non-persistent and the timer unref'd, so following a theme
 * never keeps the process alive. Every fs call is guarded: the directory can
 * vanish (Omarchy reinstalled, state wiped) and come back, and neither may
 * crash a session. While it is gone, the nearest directory above it that is
 * still there is watched instead, so its return is seen too.
 */
export function followOmarchyTheme(options: OmarchyThemeOptions = {}): OmarchyThemeWatch | null {
  const stateDir = options.stateDir ?? omarchyStateDir();
  if (!isOmarchy(options.platform, stateDir)) return null;

  const enabled = options.enabled ?? (() => true);
  const debounceMs = options.debounceMs ?? 150;
  // `state` watches current/; `ancestor` the nearest directory above it
  // while current/ is not there.
  const watches: Record<'state' | 'ancestor', DirWatch | null> = { state: null, ancestor: null };
  let themeWatcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const closeQuietly = (watcher: FSWatcher | null | undefined) => {
    try { watcher?.close(); } catch { /* already gone */ }
  };

  /**
   * Keep a live watch on `dir` in `slot`: dropped when `dir` is gone, or was
   * removed and made again (which leaves the old watch on a dead inode), and
   * made anew while it is there. A null `dir` drops it.
   */
  const keepWatching = (slot: keyof typeof watches, dir: string | null) => {
    const ino = dir === null ? null : inodeOf(dir);
    const current = watches[slot];
    if (current && (current.dir !== dir || current.ino !== ino)) {
      closeQuietly(current.watcher);
      watches[slot] = null;
    }
    if (!watches[slot] && dir !== null && ino !== null) {
      const watcher = watchQuietly(dir, schedule, () => {
        if (watches[slot]?.watcher === watcher) watches[slot] = null;
      });
      if (watcher) watches[slot] = { watcher, dir, ino };
    }
  };

  const arm = () => {
    if (stopped) return;
    keepWatching('state', stateDir);
    // `current/` is gone (or could not be watched): watch the nearest
    // directory above it that is there, where `current/` — or a directory
    // on the way to it — coming back is a change.
    keepWatching('ancestor', watches.state ? null : nearestExistingAncestor(stateDir));
    // theme/ is replaced on every switch, so the previous watch is on a
    // deleted directory by now. This one catches an edit to colors.toml in
    // place, which `current/` does not see.
    closeQuietly(themeWatcher);
    const watcher = watchQuietly(join(stateDir, 'theme'), schedule, () => {
      if (themeWatcher === watcher) themeWatcher = null;
    });
    themeWatcher = watcher;
  };

  const reload = () => {
    if (stopped) return;
    arm();
    try {
      applyOmarchyTheme(stateDir, enabled());
    } catch {
      // Reading a theme must never take the session down with it.
    }
  };

  // A switch is a burst — stage next-theme, rm theme, mv, write theme.name,
  // relink the background — and reading in the middle of it would catch the
  // moment theme/ does not exist. Waiting for the burst to go quiet reads
  // once, after the swap.
  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; reload(); }, debounceMs);
    timer.unref?.();
  }

  const handle: OmarchyThemeWatch = {
    reload,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      closeQuietly(watches.state?.watcher);
      closeQuietly(watches.ancestor?.watcher);
      closeQuietly(themeWatcher);
      watches.state = null;
      watches.ancestor = null;
      themeWatcher = null;
      if (active === handle) active = null;
    },
  };
  active?.stop();
  active = handle;
  reload();
  return handle;
}

/**
 * Re-read the theme and the setting now, if a watch is running. The settings
 * screen calls it when "Follow Omarchy theme" is switched, so the change
 * shows at once. Without a watch — not Omarchy — the palette is already
 * Codeep's own and there is nothing to do.
 */
export function reapplyOmarchyTheme(): void {
  active?.reload();
}

/**
 * Whether this looks like an Omarchy desktop: Linux, with Omarchy's state
 * directory in place. Decides whether /settings offers the switch at all —
 * on every other machine it would be a row that does nothing.
 */
export function isOmarchy(platform: NodeJS.Platform = process.platform, stateDir: string = omarchyStateDir()): boolean {
  return platform === 'linux' && inodeOf(stateDir) !== null;
}

/** The closest directory above `dir` that exists, or null if none does. */
function nearestExistingAncestor(dir: string): string | null {
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    if (inodeOf(parent) !== null) return parent;
    if (dirname(parent) === parent) return null;
  }
}

function inodeOf(dir: string): number | null {
  try {
    const stats = statSync(dir);
    return stats.isDirectory() ? stats.ino : null;
  } catch {
    return null;
  }
}

/**
 * fs.watch, or null when the directory is not there to watch. `onGone` runs
 * if the watch fails later (the directory removed under it, on some
 * kernels), so the next arm() makes a new one instead of trusting a dead one.
 */
function watchQuietly(dir: string, onEvent: () => void, onGone: () => void): FSWatcher | null {
  try {
    const watcher = watch(dir, { persistent: false }, () => onEvent());
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* already gone */ }
      onGone();
    });
    return watcher;
  } catch {
    return null;
  }
}
