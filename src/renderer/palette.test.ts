import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_PALETTE,
  PALETTE_ROLES,
  PRIMARY_COLOR as PALETTE_PRIMARY,
  getPalette,
  onPaletteChange,
  palette,
  resetPalette,
  setPalette,
  type Rgb,
} from './palette';
import { PRIMARY_COLOR, PRIMARY_BRIGHT } from './components/uiConstants';
import { SYNTAX, highlightCode } from './highlight';
import { formatWelcomeMessage } from './components/WelcomeFormatter';
import { formatMessage } from './components/MessageFormatter';

afterEach(() => {
  resetPalette();
});

describe('the default palette', () => {
  /**
   * Each role against the literal it replaced, written out as the escape
   * sequence rather than through fg.rgb() so a change to either side shows.
   * palette.defaults.test.ts covers which role each call site reads.
   */
  it.each([
    ['primary', '\x1b[38;2;240;42;48m'],
    ['primaryBright', '\x1b[38;2;255;80;85m'],
    ['separator', '\x1b[38;2;80;80;80m'],
    ['label', '\x1b[38;2;100;100;100m'],
    ['assistantLabel', '\x1b[38;2;120;120;120m'],
    ['modelName', '\x1b[38;2;130;130;130m'],
    ['strikethrough', '\x1b[38;2;140;140;140m'],
    ['hint', '\x1b[38;2;150;150;150m'],
    ['secondaryText', '\x1b[38;2;160;160;160m'],
    ['providerName', '\x1b[38;2;180;180;180m'],
    ['path', '\x1b[38;2;100;180;220m'],
    ['success', '\x1b[38;2;100;200;120m'],
    ['successDetail', '\x1b[38;2;80;160;100m'],
    ['warning', '\x1b[38;2;220;160;40m'],
    ['inlineCode', '\x1b[38;2;209;154;102m'],
    ['heading', '\x1b[38;2;97;175;239m'],
    ['subheading', '\x1b[38;2;198;120;221m'],
    ['syntaxKeyword', '\x1b[38;2;198;120;221m'],
    ['syntaxString', '\x1b[38;2;152;195;121m'],
    ['syntaxNumber', '\x1b[38;2;209;154;102m'],
    ['syntaxComment', '\x1b[38;2;92;99;112m'],
    ['syntaxFunction', '\x1b[38;2;97;175;239m'],
    ['syntaxType', '\x1b[38;2;229;192;123m'],
    ['syntaxOperator', '\x1b[38;2;86;182;194m'],
    ['syntaxRemoved', '\x1b[38;2;224;108;117m'],
    ['codeFrame', '\x1b[38;2;100;105;115m'],
    ['codeLang', '\x1b[38;2;150;155;165m'],
  ] as const)('%s is the colour Codeep has always painted it', (role, escape) => {
    expect(palette[role]).toBe(escape);
  });

  it('has a pinned value for every role', () => {
    // A role added without a line in the table above would go unpinned.
    expect(PALETTE_ROLES).toHaveLength(27);
  });

  it('exports the brand pair as the same strings, from both modules', () => {
    expect(PRIMARY_COLOR).toBe('\x1b[38;2;240;42;48m');
    expect(PRIMARY_BRIGHT).toBe('\x1b[38;2;255;80;85m');
    expect(PALETTE_PRIMARY).toBe(PRIMARY_COLOR);
  });
});

describe('setPalette', () => {
  const blue: Rgb = [10, 20, 200];

  it('recolours the role it is given and leaves the rest at their defaults', () => {
    setPalette({ hint: blue });
    expect(palette.hint).toBe('\x1b[38;2;10;20;200m');
    expect(palette.label).toBe('\x1b[38;2;100;100;100m');
    expect(getPalette().hint).toEqual(blue);
  });

  it('moves PRIMARY_COLOR for every importer, uiConstants included', () => {
    // The live binding is what lets ~117 call sites keep `PRIMARY_COLOR`
    // and still follow a theme switch.
    setPalette({ primary: [1, 2, 3], primaryBright: [4, 5, 6] });
    expect(PRIMARY_COLOR).toBe('\x1b[38;2;1;2;3m');
    expect(PRIMARY_BRIGHT).toBe('\x1b[38;2;4;5;6m');
    resetPalette();
    expect(PRIMARY_COLOR).toBe('\x1b[38;2;240;42;48m');
  });

  it('starts from the defaults each time, so a role a new theme lacks does not keep the old theme\'s colour', () => {
    setPalette({ hint: blue, label: blue });
    setPalette({ hint: blue });
    expect(palette.label).toBe('\x1b[38;2;100;100;100m');
  });

  it('ignores a value that is not three 0–255 integers', () => {
    setPalette({
      hint: [256, 0, 0],
      label: [1.5, 2, 3] as unknown as Rgb,
      path: [1, 2] as unknown as Rgb,
      warning: 'red' as unknown as Rgb,
    });
    expect(getPalette()).toEqual(DEFAULT_PALETTE);
  });

  it('tells listeners only when a colour actually changed', () => {
    const listener = vi.fn();
    const unsubscribe = onPaletteChange(listener);
    try {
      expect(setPalette({ hint: blue })).toBe(true);
      expect(setPalette({ hint: blue })).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(resetPalette()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
    setPalette({ hint: blue });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('still tells every listener when one of them throws', () => {
    const second = vi.fn();
    const offA = onPaletteChange(() => { throw new Error('repaint failed'); });
    const offB = onPaletteChange(second);
    try {
      setPalette({ hint: blue });
      expect(second).toHaveBeenCalledTimes(1);
      expect(palette.hint).toBe('\x1b[38;2;10;20;200m');
    } finally {
      offA();
      offB();
    }
  });
});

describe('colours are read when painting, not when importing', () => {
  // Each of these modules was imported above, under the default palette.
  // A colour baked into a module-level constant would still be red here.
  it('SYNTAX and highlightCode', () => {
    setPalette({ syntaxKeyword: [1, 1, 1], syntaxRemoved: [2, 2, 2] });
    expect(SYNTAX.keyword).toBe('\x1b[38;2;1;1;1m');
    expect(highlightCode('const x', 'ts')).toContain('\x1b[38;2;1;1;1mconst');
    expect(highlightCode('-gone', 'diff')).toContain('\x1b[38;2;2;2;2m-gone');
  });

  it('the welcome banner', () => {
    setPalette({ primary: [3, 3, 3], path: [4, 4, 4] });
    const out = formatWelcomeMessage('Codeep v1  ·  P  ·  M\n  Project  /p').map(l => l.text).join('\n');
    expect(out).toContain('\x1b[38;2;3;3;3m');
    expect(out).toContain('\x1b[38;2;4;4;4m/p');
  });

  it('chat messages', () => {
    setPalette({ primary: [5, 5, 5], inlineCode: [6, 6, 6], heading: [7, 7, 7] });
    const out = formatMessage('user', '# Title\nrun `npm test`', 80, { current: 0 }).map(l => l.text).join('\n');
    expect(out).toContain('\x1b[38;2;5;5;5m');
    expect(out).toContain('\x1b[38;2;6;6;6mnpm test');
    expect(out).toContain('\x1b[38;2;7;7;7m');
  });
});
