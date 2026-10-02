import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyOmarchyTheme,
  contrastRatio,
  followOmarchyTheme,
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
import { DEFAULT_PALETTE, getPalette, palette, resetPalette, type PaletteRole, type Rgb } from './palette';

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
/** The greys, in the order they get brighter in the default palette. */
const GREYS: PaletteRole[] = [
  'separator', 'label', 'assistantLabel', 'modelName', 'strikethrough', 'hint', 'secondaryText', 'providerName',
];

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
  const fg = hex('#e0e0e0');

  it('takes the brand colour from accent, and its bright variant 35% toward the foreground', () => {
    expect(roles.primary).toEqual(hex('#7aa2f7'));
    expect(roles.primaryBright).toEqual([158, 184, 239]);
  });

  it('mixes the greys from background toward foreground, faintest first', () => {
    expect(roles.separator).toEqual(mix(bg, fg, 0.30));
    expect(roles.label).toEqual(mix(bg, fg, 0.40));
    expect(roles.assistantLabel).toEqual(mix(bg, fg, 0.48));
    expect(roles.hint).toEqual(mix(bg, fg, 0.66));
    expect(roles.providerName).toEqual(mix(bg, fg, 0.82));
    // On a near-black background with a light grey foreground that lands
    // next to Codeep's own greys, which were chosen for exactly that.
    expect(roles.separator).toEqual([78, 78, 78]);
    expect(roles.label).toEqual([99, 99, 99]);
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

  it('defines every role', () => {
    expect(Object.keys(roles).sort()).toEqual(Object.keys(DEFAULT_PALETTE).sort());
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
  });

  it('keeps the greys in order: each at least as far from the background as the one before', () => {
    const contrasts = GREYS.map(role => contrastRatio(roles[role]!, bg));
    for (let i = 1; i < contrasts.length; i++) {
      expect(contrasts[i], GREYS[i]).toBeGreaterThanOrEqual(contrasts[i - 1]);
    }
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
    expect(roles.separator).toEqual(mix([0, 0, 0], [255, 255, 255], 0.3));
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

describe('followOmarchyTheme off Linux', () => {
  it('does nothing, not even install a signal handler', () => {
    const before = process.listenerCount('SIGUSR2');
    expect(followOmarchyTheme({ stateDir, platform: 'darwin' })).toBeNull();
    expect(process.listenerCount('SIGUSR2')).toBe(before);
    expect(palette.primary).toBe(DEFAULT_PRIMARY);
    expect(isOmarchy('darwin', stateDir)).toBe(false);
  });
});

// Omarchy is Linux, and these exercise what Codeep watches it with there
// (inotify through fs.watch); other platforms' fs.watch reports a directory
// being replaced differently. The parsing and mapping above run everywhere.
describe.skipIf(process.platform !== 'linux')('followOmarchyTheme', () => {
  it('does nothing when there is no Omarchy state directory', () => {
    const before = process.listenerCount('SIGUSR2');
    expect(followOmarchyTheme({ stateDir: join(root, 'absent'), platform: 'linux' })).toBeNull();
    expect(process.listenerCount('SIGUSR2')).toBe(before);
    expect(isOmarchy('linux', join(root, 'absent'))).toBe(false);
  });

  it('applies the current theme as soon as it starts', () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    expect(watch).not.toBeNull();
    expect(palette.primary).toBe(DARK_ACCENT);
  });

  it('follows a switch, which replaces the theme directory, and the one after it', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    switchTheme(LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
    expect(palette.syntaxFunction).toBe(LIGHT_ACCENT);
    // The watch on theme/ was on the directory that was just deleted; this
    // only arrives if the watches were re-made.
    switchTheme(DARK);
    await waitFor(() => palette.primary === DARK_ACCENT);
  });

  it('follows an edit to colors.toml in place', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    writeFileSync(join(stateDir, 'theme', 'colors.toml'), LIGHT);
    await waitFor(() => palette.primary === LIGHT_ACCENT);
  });

  it('reloads on SIGUSR2, the signal Omarchy sends OpenCode', () => {
    // A debounce longer than the test, so only the signal can be what reloads.
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 60_000 });
    writeFileSync(join(stateDir, 'theme', 'colors.toml'), LIGHT);
    expect(palette.primary).toBe(DARK_ACCENT);
    process.emit('SIGUSR2', 'SIGUSR2');
    expect(palette.primary).toBe(LIGHT_ACCENT);
  });

  it('survives the state directory disappearing, and picks it up again when it is back', async () => {
    watch = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 });
    rmSync(stateDir, { recursive: true, force: true });
    await waitFor(() => palette.primary === DEFAULT_PRIMARY);

    writeTheme(join(stateDir, 'theme'), LIGHT);
    process.emit('SIGUSR2', 'SIGUSR2');
    expect(palette.primary).toBe(LIGHT_ACCENT);
    // Re-armed on the new directory: a switch is seen without another signal.
    switchTheme(DARK);
    await waitFor(() => palette.primary === DARK_ACCENT);
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

  it('stop() closes the watches and gives SIGUSR2 back', async () => {
    const before = process.listenerCount('SIGUSR2');
    const running = followOmarchyTheme({ stateDir, platform: 'linux', debounceMs: 20 })!;
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
    running.stop();
    expect(process.listenerCount('SIGUSR2')).toBe(before);

    switchTheme(LIGHT);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(palette.primary).toBe(DARK_ACCENT);
    reapplyOmarchyTheme(); // nothing running: a no-op, not a throw
    expect(palette.primary).toBe(DARK_ACCENT);
  });
});
