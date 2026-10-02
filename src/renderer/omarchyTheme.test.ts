import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyOmarchyTheme,
  contrastRatio,
  followOmarchyTheme,
  greyContrast,
  isOmarchy,
  loadOmarchyPalette,
  mix,
  omarchyStateDir,
  paletteFromOmarchy,
  parseColorsToml,
  parseHexColor,
  reapplyOmarchyTheme,
  type OmarchyThemeWatch,
} from './omarchyTheme';
import { DEFAULT_PALETTE, TERMINAL_DEFAULTS, getPalette, palette, resetPalette, type PaletteRole, type Rgb } from './palette';

/** A dark theme whose colours all read on its background, so the mapping is
 *  visible without the legibility nudge in the way. */
const DARK = `
mode = "dark"
accent = "#7aa2f7"
background = "#101010"
foreground = "#e0e0e0"
dark_foreground = "#707070"
red = "#f7768e"
yellow = "#e0af68"
orange = "#ff9e64"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
`;

/** catppuccin-latte's palette: a light theme with yellow, magenta and
 *  dark_foreground all near 2.3:1 on its background. */
const LIGHT = `
mode = "light"
accent = "#1e66f5"
background = "#eff1f5"
foreground = "#4c4f69"
dark_foreground = "#9ca0b0"
red = "#d20f39"
yellow = "#df8e1d"
orange = "#d84e2b"
green = "#40a02b"
cyan = "#179299"
blue = "#1e66f5"
magenta = "#ea76cb"
`;

const hex = (h: string): Rgb => parseHexColor(h)!;
/** The roles that are text someone reads, as opposed to separators and frames. */
const TEXT_ROLES = (Object.keys(DEFAULT_PALETTE) as PaletteRole[])
  .filter(r => r !== 'separator' && r !== 'codeFrame' && r !== 'label');
/** The text read as sentences rather than as a word or a token. */
const SENTENCE_ROLES = ['hint', 'secondaryText', 'warning', 'warningToast', 'attention'] as const;
/** The greys, in the order they get brighter in the default palette. */
const GREYS: PaletteRole[] = [
  'separator', 'label', 'assistantLabel', 'modelName', 'strikethrough', 'hint', 'secondaryText', 'providerName',
];
const ALL_ROLES = [...Object.keys(DEFAULT_PALETTE), ...Object.keys(TERMINAL_DEFAULTS)].sort();

afterEach(() => {
  resetPalette();
});

describe('parseColorsToml', () => {
  it('reads key = "value" lines', () => {
    expect(parseColorsToml('accent = "#7aa2f7"\nbackground = "#1a1b26"')).toEqual({
      accent: '#7aa2f7',
      background: '#1a1b26',
    });
  });

  it('skips comments and blank lines, and ignores a comment after the value', () => {
    const text = '# Tokyo Night\n\n   # indented comment\naccent = "#7aa2f7" # the blue\n';
    expect(parseColorsToml(text)).toEqual({ accent: '#7aa2f7' });
  });

  it('takes any spacing, single quotes, CRLF line ends and a quoted key', () => {
    const text = "accent=\"#111111\"\r\n  red   =   '#222222'  \r\n\"green\" = \"#333333\"\r\n";
    expect(parseColorsToml(text)).toEqual({ accent: '#111111', red: '#222222', green: '#333333' });
  });

  it('takes a bare value up to the first space, as Omarchy\'s own reader does', () => {
    expect(parseColorsToml('mode = light\naccent = #123456 # bare')).toEqual({ mode: 'light', accent: '#123456' });
  });

  it('ignores tables, arrays, inline tables and lines that are not key = value', () => {
    const text = [
      '[colors]',
      'accent = "#7aa2f7"',
      'stops = ["#000000", "#ffffff"]',
      'nested = { a = "#000000" }',
      'no equals sign here',
      '= "#000000"',
      'bad key! = "#000000"',
      'unterminated = "#00',
      'empty =',
    ].join('\n');
    expect(parseColorsToml(text)).toEqual({ accent: '#7aa2f7' });
  });

  it('never throws, whatever the file holds', () => {
    const garbage = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)).toString('latin1');
    expect(() => parseColorsToml(garbage)).not.toThrow();
    expect(() => parseColorsToml('')).not.toThrow();
  });
});

describe('parseHexColor', () => {
  it('reads #rrggbb in either case, and #rgb', () => {
    expect(parseHexColor('#7aa2f7')).toEqual([122, 162, 247]);
    expect(parseHexColor('#FFFCF0')).toEqual([255, 252, 240]);
    expect(parseHexColor('#0af')).toEqual([0, 170, 255]);
  });

  it('refuses anything else', () => {
    for (const value of ['7aa2f7', '#7aa2f', '#7aa2f7ff', 'rgb(1,2,3)', 'blue', '', undefined]) {
      expect(parseHexColor(value)).toBeNull();
    }
  });
});

describe('paletteFromOmarchy — a dark theme', () => {
  const roles = paletteFromOmarchy(parseColorsToml(DARK));
  const bg = hex('#101010');

  it('takes the brand colour from accent, and its bright variant 35% toward the foreground', () => {
    expect(roles.primary).toEqual(hex('#7aa2f7'));
    expect(roles.primaryBright).toEqual([158, 184, 239]);
  });

  it('mixes the greys from background toward foreground, faintest first', () => {
    // On a near-black background with a light grey foreground they land
    // next to Codeep's own greys, which were chosen for exactly that.
    expect(roles.separator).toEqual([76, 76, 76]);
    expect(roles.label).toEqual([94, 94, 94]);
    expect(roles.assistantLabel).toEqual([115, 115, 115]);
    expect(roles.hint).toEqual([147, 147, 147]);
    expect(roles.providerName).toEqual([192, 192, 192]);
  });

  it('paints code punctuation a readable grey instead of bright black', () => {
    // Pi's syntaxPunctuation is its muted text, the hint grey.
    expect(roles.syntaxPunctuation).toEqual([153, 153, 153]);
    expect(contrastRatio(roles.syntaxPunctuation!, bg)).toBeGreaterThanOrEqual(3);
  });

  it('paints code the way Omarchy\'s other templates do', () => {
    expect(roles.syntaxKeyword).toEqual(hex('#ad8ee6'));
    expect(roles.syntaxString).toEqual(hex('#9ece6a'));
    expect(roles.syntaxNumber).toEqual(hex('#ff9e64'));
    expect(roles.syntaxComment).toEqual(hex('#707070'));
    expect(roles.syntaxFunction).toEqual(hex('#7aa2f7'));
    expect(roles.syntaxType).toEqual(hex('#e0af68'));
    expect(roles.syntaxOperator).toEqual(hex('#449dab'));
    expect(roles.syntaxRemoved).toEqual(hex('#f7768e'));
  });

  it('colours the welcome banner and markdown from the same keys', () => {
    expect(roles.path).toEqual(hex('#449dab'));
    expect(roles.success).toEqual(hex('#9ece6a'));
    expect(roles.successDetail).toEqual(mix(hex('#9ece6a'), bg, 0.25));
    expect(roles.warning).toEqual(hex('#e0af68'));
    expect(roles.inlineCode).toEqual(hex('#ff9e64'));
    expect(roles.heading).toEqual(hex('#7aa2f7'));
    expect(roles.subheading).toEqual(hex('#ad8ee6'));
  });

  it('takes the toast, the confirm modal and the picker prompts from yellow', () => {
    expect(roles.warningToast).toEqual(hex('#e0af68'));
    expect(roles.attention).toEqual(hex('#e0af68'));
  });

  it('fills the YOLO badge with yellow, under whichever text reads best on it', () => {
    expect(roles.yoloBadge).toEqual(hex('#e0af68'));
    // Black beats the theme's near-black background and its light foreground.
    expect(roles.yoloBadgeText).toEqual([0, 0, 0]);
  });

  it('defines every role', () => {
    expect(Object.keys(roles).sort()).toEqual(ALL_ROLES);
  });
});

describe('greyContrast', () => {
  it('gives a theme like the terminal the greys were picked on each default back', () => {
    const roles = paletteFromOmarchy({ background: '#1e1e1e', foreground: '#cccccc' });
    for (const role of GREYS) expect(roles[role], role).toEqual(DEFAULT_PALETTE[role]);
  });

  it('keeps a grey at its floor or above, and never past the body text', () => {
    const hint = DEFAULT_PALETTE.hint;
    expect(greyContrast(hint, 4.5, 6.66)).toBeGreaterThanOrEqual(4.5);
    expect(greyContrast(hint, 4.5, 6.66)).toBeLessThan(6.66);
    // A theme without the contrast for the floor gets its foreground.
    expect(greyContrast(hint, 4.5, 3.2)).toBe(3.2);
  });
});

describe('paletteFromOmarchy — a light theme', () => {
  const roles = paletteFromOmarchy(parseColorsToml(LIGHT));
  const bg = hex('#eff1f5');

  it('keeps every text role readable on the light background', () => {
    for (const role of TEXT_ROLES) {
      expect(contrastRatio(roles[role]!, bg), role).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(roles.label!, bg)).toBeGreaterThanOrEqual(2.5);
    expect(contrastRatio(roles.syntaxPunctuation!, bg)).toBeGreaterThanOrEqual(3);
  });

  it('holds what is read as a sentence to 4.5:1', () => {
    for (const role of SENTENCE_ROLES) {
      expect(contrastRatio(roles[role]!, bg), role).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the greys in order and apart, rather than pushing several onto one floor', () => {
    // A fixed mix share reads fainter on a light background, and 40–60% of
    // the way to catppuccin-latte's foreground all fall under 3:1.
    const contrasts = GREYS.map(role => contrastRatio(roles[role]!, bg));
    for (let i = 1; i < contrasts.length; i++) {
      expect(contrasts[i], GREYS[i]).toBeGreaterThan(contrasts[i - 1] + 0.2);
    }
  });

  it('puts black, not the near-white background, on the YOLO badge', () => {
    expect(roles.yoloBadge).toEqual(hex('#df8e1d'));
    expect(roles.yoloBadgeText).toEqual([0, 0, 0]);
    expect(contrastRatio(roles.yoloBadgeText!, roles.yoloBadge!)).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens the greys rather than reusing the dark-terminal ones', () => {
    // rgb(180,180,180) on near-white is 1.9:1; the provider name must not be.
    expect(roles.providerName).not.toEqual(DEFAULT_PALETTE.providerName);
    expect(contrastRatio(roles.providerName!, bg)).toBeGreaterThan(contrastRatio(DEFAULT_PALETTE.providerName, bg));
  });

  it('moves a colour too faint to read toward the foreground, and leaves one that reads alone', () => {
    const yellow = hex('#df8e1d');
    expect(contrastRatio(yellow, bg)).toBeLessThan(3);
    expect(roles.syntaxType).not.toEqual(yellow);
    expect(contrastRatio(roles.syntaxType!, bg)).toBeGreaterThanOrEqual(3);
    expect(roles.syntaxFunction).toEqual(hex('#1e66f5'));
    expect(roles.syntaxRemoved).toEqual(hex('#d20f39'));
  });
});

describe('paletteFromOmarchy — odd themes', () => {
  it('moves the brand colour to blue when the accent is the foreground (kanagawa)', () => {
    // Otherwise the selected row of every menu is the colour of the others.
    const roles = paletteFromOmarchy({ accent: '#dcd7ba', foreground: '#dcd7ba', background: '#1f1f28', blue: '#7e9cd8' });
    expect(roles.primary).toEqual(hex('#7e9cd8'));
    expect(roles.primaryBright).toEqual(mix(hex('#7e9cd8'), hex('#dcd7ba'), 0.35));
  });

  it('keeps an accent that only shares the foreground\'s brightness, as Claude Code does', () => {
    // tokyo-night: blue against grey-blue, apart by hue if not by contrast.
    const roles = paletteFromOmarchy({ accent: '#7aa2f7', foreground: '#a9b1d6', background: '#1a1b26', blue: '#2ac3de' });
    expect(roles.primary).toEqual(hex('#7aa2f7'));
    expect(roles.primaryBright).toEqual(mix(hex('#7aa2f7'), hex('#a9b1d6'), 0.35));
  });

  it('writes the YOLO badge in white on a dark "yellow" (matte-black\'s is red)', () => {
    const roles = paletteFromOmarchy({ background: '#121212', foreground: '#bebebe', yellow: '#b91c1c' });
    expect(roles.yoloBadgeText).toEqual([255, 255, 255]);
  });
});

describe('paletteFromOmarchy — incomplete themes', () => {
  it('leaves out every role whose key is missing, so it keeps its default', () => {
    expect(paletteFromOmarchy({ accent: '#123456' })).toEqual({
      primary: [0x12, 0x34, 0x56],
      primaryBright: [0x12, 0x34, 0x56],
    });
  });

  it('cannot mix greys without both background and foreground', () => {
    const roles = paletteFromOmarchy({ background: '#000000', green: '#00ff00' });
    expect(roles.separator).toBeUndefined();
    expect(roles.syntaxString).toEqual([0, 255, 0]);
  });

  it('ignores a key whose value is not a hex colour', () => {
    const roles = paletteFromOmarchy({ accent: 'rgb(1,2,3)', red: 'red', blue: '#0000ff' });
    expect(roles.primary).toBeUndefined();
    expect(roles.syntaxRemoved).toBeUndefined();
    expect(roles.syntaxFunction).toEqual([0, 0, 255]);
  });

  it('falls back to yellow for orange, as Omarchy does', () => {
    const roles = paletteFromOmarchy({ yellow: '#e0af68' });
    expect(roles.syntaxNumber).toEqual(hex('#e0af68'));
    expect(roles.inlineCode).toEqual(hex('#e0af68'));
  });

  it('reads the legacy short names Omarchy still accepts', () => {
    const roles = paletteFromOmarchy({ bg: '#000000', fg: '#ffffff', color1: '#ff0000', purple: '#aa00ff', color8: '#888888' });
    expect(roles.syntaxRemoved).toEqual([255, 0, 0]);
    expect(roles.syntaxKeyword).toEqual([170, 0, 255]);
    expect(roles.syntaxComment).toEqual([136, 136, 136]);
    expect(roles.separator).toEqual(paletteFromOmarchy({ background: '#000000', foreground: '#ffffff' }).separator);
  });
});

// ─── Files on disk ───────────────────────────────────────────────────────────

let root: string;
let stateDir: string;
let watch: OmarchyThemeWatch | null = null;

function writeTheme(dir: string, toml: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'colors.toml'), toml);
}

/** What `omarchy-theme-set` does: stage beside, delete, move into place. */
function switchTheme(toml: string): void {
  const next = join(stateDir, 'next-theme');
  rmSync(next, { recursive: true, force: true });
  writeTheme(next, toml);
  rmSync(join(stateDir, 'theme'), { recursive: true, force: true });
  renameSync(next, join(stateDir, 'theme'));
  writeFileSync(join(stateDir, 'theme.name'), 'next\n');
}

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting for the palette');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const DARK_ACCENT = '\x1b[38;2;122;162;247m';
const LIGHT_ACCENT = '\x1b[38;2;30;102;245m';
const DEFAULT_PRIMARY = '\x1b[38;2;240;42;48m';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-omarchy-'));
  stateDir = join(root, 'current');
  writeTheme(join(stateDir, 'theme'), DARK);
});

afterEach(() => {
  watch?.stop();
  watch = null;
  rmSync(root, { recursive: true, force: true });
});

describe('loadOmarchyPalette', () => {
  it('reads current/theme/colors.toml', () => {
    expect(loadOmarchyPalette(stateDir)?.primary).toEqual(hex('#7aa2f7'));
  });

  it('is null when there is no colors.toml', () => {
    rmSync(join(stateDir, 'theme', 'colors.toml'));
    expect(loadOmarchyPalette(stateDir)).toBeNull();
    expect(loadOmarchyPalette(join(root, 'nowhere'))).toBeNull();
  });

  it('is null when colors.toml holds nothing it can use', () => {
    writeFileSync(join(stateDir, 'theme', 'colors.toml'), '\u0000\u0001 not toml [[[ = = =\naccent = "blue"\n');
    expect(loadOmarchyPalette(stateDir)).toBeNull();
  });

  it('puts Codeep\'s own colours back for a missing or malformed file', () => {
    applyOmarchyTheme(stateDir, true);
    expect(palette.primary).toBe(DARK_ACCENT);
    writeFileSync(join(stateDir, 'theme', 'colors.toml'), 'garbage');
    applyOmarchyTheme(stateDir, true);
    expect(getPalette()).toEqual(DEFAULT_PALETTE);
  });

  it('finds the state directory where omarchy-theme-set writes it', () => {
    expect(omarchyStateDir('/home/u')).toBe(join('/home/u', '.local', 'state', 'omarchy', 'current'));
  });
});

/**
 * How many listeners each signal the config store's exit hook (when-exit)
 * also catches has. A handler of Codeep's own that kept the process alive
 * would leave that hook spent, and SIGTERM and SIGHUP would then no longer
 * end the session.
 */
const SIGNALS = ['SIGUSR2', 'SIGTERM', 'SIGHUP', 'SIGINT'] as const;
const signalListeners = () => SIGNALS.map(signal => process.listenerCount(signal));

describe('followOmarchyTheme off Linux', () => {
  it('does nothing', () => {
    expect(followOmarchyTheme({ stateDir, platform: 'darwin' })).toBeNull();
    expect(palette.primary).toBe(DEFAULT_PRIMARY);
    expect(isOmarchy('darwin', stateDir)).toBe(false);
  });
});

// Omarchy is Linux, and these exercise what Codeep watches it with there
// (inotify through fs.watch); other platforms' fs.watch reports a directory
// being replaced differently. The parsing and mapping above run everywhere.
describe.skipIf(process.platform !== 'linux')('followOmarchyTheme', () => {
  it('does nothing when there is no Omarchy state directory', () => {
    expect(followOmarchyTheme({ stateDir: join(root, 'absent'), platform: 'linux' })).toBeNull();
    expect(isOmarchy('linux', join(root, 'absent'))).toBe(false);
  });

  it('applies the current theme as soon as it starts', () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    expect(watch).not.toBeNull();
    expect(palette.primary).toBe(DARK_ACCENT);
  });

  it('handles no signal, so SIGTERM and SIGHUP still end the session', () => {
    const before = signalListeners();
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    expect(signalListeners()).toEqual(before);
  });

  it('follows a switch, which replaces the theme directory, and the one after it', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    switchTheme(LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
    expect(palette.syntaxFunction).toBe(LIGHT_ACCENT);
    // The watch on current/ outlives a switch, so it sees this one too.
    switchTheme(DARK);
    await waitFor(() => palette.primary === DARK_ACCENT);
  });

  it('follows an edit to colors.toml in place', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    writeFileSync(join(stateDir, 'theme', 'colors.toml'), LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
  });

  it('follows an edit in place after a switch, so the theme/ watch was made again on the new directory', async () => {
    // current/ does not see a file inside theme/ change; only a watch on the
    // theme/ that the switch moved into place does.
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    switchTheme(LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
    writeFileSync(join(stateDir, 'theme', 'colors.toml'), DARK);
    await waitFor(() => palette.primary === DARK_ACCENT);
  });

  it('survives the state directory disappearing, and picks it up again by itself when it is back', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    rmSync(stateDir, { recursive: true, force: true });
    await waitFor(() => palette.primary === DEFAULT_PRIMARY);

    // Seen from the directory above, which is watched while current/ is gone.
    writeTheme(join(stateDir, 'theme'), LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
    // Re-armed on the new directory: the next switch is seen too.
    switchTheme(DARK);
    await waitFor(() => palette.primary === DARK_ACCENT);
  });

  it('picks it up again when the directories above it went too', async () => {
    const deep = join(root, 'omarchy', 'current');
    writeTheme(join(deep, 'theme'), DARK);
    watch = followOmarchyTheme({ stateDir: deep, platform: 'linux', debounceMs: 20 });
    rmSync(join(root, 'omarchy'), { recursive: true, force: true });
    await waitFor(() => palette.primary === DEFAULT_PRIMARY);

    mkdirSync(join(root, 'omarchy'));
    await new Promise(resolve => setTimeout(resolve, 100));
    writeTheme(join(deep, 'theme'), LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
  });

  it('keeps Codeep\'s own colours while the setting is off, and applies the theme when it is turned on', () => {
    let follow = false;
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20, enabled: () => follow });
    expect(getPalette()).toEqual(DEFAULT_PALETTE);
    follow = true;
    reapplyOmarchyTheme();
    expect(palette.primary).toBe(DARK_ACCENT);
    follow = false;
    reapplyOmarchyTheme();
    expect(getPalette()).toEqual(DEFAULT_PALETTE);
  });

  it('stop() closes the watches', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 })!;
    watch.stop();

    switchTheme(LIGHT);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(palette.primary).toBe(DARK_ACCENT);
    reapplyOmarchyTheme(); // nothing running: a no-op, not a throw
    expect(palette.primary).toBe(DARK_ACCENT);
  });
});
