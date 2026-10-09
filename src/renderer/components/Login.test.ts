import { describe, it, expect, vi, afterEach } from 'vitest';
import { Screen } from '../Screen';
import { Input } from '../Input';
import { LoginScreen, renderProviderSelect } from './Login';

/**
 * The first-run setup screens on terminals of every height. At 30 rows on
 * the Omarchy box the provider list (two dozen providers, a 28-row box) was
 * centred over "Welcome to Codeep" and the key hints; the API-key box did
 * the same below about 17 rows.
 */

const PROVIDERS = Array.from({ length: 24 }, (_, i) => ({
  id: `p${i}`,
  name: `Provider ${String(i).padStart(2, '0')}`,
  description: `Description ${i}`,
}));

const undo: Array<() => void> = [];

afterEach(() => {
  for (const step of undo.splice(0).reverse()) step();
  vi.restoreAllMocks();
});

/** A real Screen on a terminal of this size. */
function screenOf(rows: number, columns = 100): Screen {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const [name, value] of [['rows', rows], ['columns', columns]] as const) {
    const before = Object.getOwnPropertyDescriptor(process.stdout, name);
    Object.defineProperty(process.stdout, name, { value, configurable: true, writable: true });
    undo.push(() => {
      if (before) Object.defineProperty(process.stdout, name, before);
      else delete (process.stdout as unknown as Record<string, unknown>)[name];
    });
  }
  const screen = new Screen();
  undo.push(() => screen.cleanup());
  return screen;
}

/** What the screen shows, one string per row. */
function rowsOf(screen: Screen): string[] {
  const buffer = (screen as unknown as { buffer: Array<Array<{ char: string }>> }).buffer;
  return buffer.map(row => row.map(cell => cell.char).join(''));
}

function rowOf(rows: string[], text: string): number {
  return rows.findIndex(row => row.includes(text));
}

describe('the provider list', () => {
  for (const height of [15, 20, 24, 30, 34, 40]) {
    for (const selected of [0, 11, 23]) {
      it(`keeps the title, the hints and the selection on screen at ${height} rows (selected ${selected})`, () => {
        const screen = screenOf(height);
        renderProviderSelect(screen, PROVIDERS, selected);
        const rows = rowsOf(screen);

        expect(rows[1]).toContain('Welcome to Codeep');
        expect(rows[3]).toContain('Pick an AI provider');
        expect(rows[height - 2]).toContain('↑↓ Navigate');

        const selectedRow = rowOf(rows, `► Provider ${String(selected).padStart(2, '0')}`);
        expect(selectedRow).toBeGreaterThan(3);

        // Every provider shown sits between the subtitle and the hints.
        const shown = rows.map((row, y) => ({ row, y })).filter(({ row }) => /Provider \d\d/.test(row));
        expect(shown.length).toBe(Math.min(PROVIDERS.length, height - 12));
        for (const { y } of shown) {
          expect(y).toBeGreaterThan(4);
          expect(y).toBeLessThan(height - 3);
        }

        // What is out of view is counted, and nothing is lost.
        const above = Number(/▲ (\d+) more/.exec(rows.join('\n'))?.[1] ?? 0);
        const below = Number(/▼ (\d+) more/.exec(rows.join('\n'))?.[1] ?? 0);
        expect(above + shown.length + below).toBe(PROVIDERS.length);
        const firstShown = Number(/Provider (\d\d)/.exec(shown[0].row)?.[1]);
        expect(firstShown).toBe(above);
      });
    }
  }

  it('shows the whole list, centred as before, when it fits', () => {
    const screen = screenOf(50);
    renderProviderSelect(screen, PROVIDERS, 0);
    const rows = rowsOf(screen);
    expect(rows.join('\n')).not.toMatch(/[▲▼] \d+ more/);
    // A 28-row box centred in 50 rows starts on row 11.
    expect(rows[11]).toContain('╭');
    expect(rowOf(rows, 'Provider 00')).toBe(13);
  });

  it('still draws something on a terminal shorter than that', () => {
    for (let height = 4; height < 15; height++) {
      const screen = screenOf(height);
      expect(() => renderProviderSelect(screen, PROVIDERS, 5)).not.toThrow();
      expect(rowsOf(screen)[1]).toContain('Welcome to Codeep');
      for (const step of undo.splice(0).reverse()) step();
    }
  });
});

// Esc ends setup — main.ts prints "Setup cancelled." and exits — and the
// footer said "Esc skip (provider chosen later)", a later that never came.
describe('the provider list footer', () => {
  it('says that Esc cancels setup', () => {
    const screen = screenOf(30);
    renderProviderSelect(screen, PROVIDERS, 0);
    const footer = rowsOf(screen)[28];
    expect(footer).toContain('Esc Cancel setup');
    expect(footer).not.toContain('chosen later');
  });
});

// On a linked machine the list says where the keys already are: one more
// line, which must not cost the list a row.
describe('the provider list with a hint', () => {
  const HINT = 'Keys on codeep.dev: codeep account sync --keys';

  for (const height of [15, 20, 24, 30, 34, 40, 50]) {
    for (const selected of [0, 11, 23]) {
      it(`puts it above the key hints and moves nothing else at ${height} rows (selected ${selected})`, () => {
        const screen = screenOf(height);
        renderProviderSelect(screen, PROVIDERS, selected);
        const without = rowsOf(screen);
        renderProviderSelect(screen, PROVIDERS, selected, HINT);
        const rows = rowsOf(screen);

        expect(without[height - 3].trim()).toBe('');
        expect(rows[height - 3].trim()).toBe(HINT);
        for (let y = 0; y < height; y++) {
          if (y !== height - 3) expect(rows[y], `row ${y}`).toBe(without[y]);
        }
        // Below the box, above the key hints.
        const boxBottom = rows.reduce((last, row, y) => (row.includes('╰') ? y : last), -1);
        expect(boxBottom).toBeGreaterThan(4);
        expect(boxBottom).toBeLessThan(height - 3);
        expect(rows[height - 2]).toContain('↑↓ Navigate');
      });
    }
  }

  it('shows the whole command at 50 columns', () => {
    // At 50 the old wording ended "…run: code…".
    const screen = screenOf(30, 50);
    renderProviderSelect(screen, PROVIDERS, 0, HINT);
    expect(rowsOf(screen)[27].trim()).toBe(HINT);
  });

  it('is cut to the width of a narrower terminal', () => {
    const screen = screenOf(30, 40);
    renderProviderSelect(screen, PROVIDERS, 0, HINT);
    const row = rowsOf(screen)[27];
    expect(row.trim()).toBe(HINT.slice(0, 35) + '…');
    expect(row.trimEnd().length).toBeLessThanOrEqual(38);
  });

  it('is left out where there is no row for it, and the title stays', () => {
    for (let height = 4; height < 15; height++) {
      const screen = screenOf(height);
      renderProviderSelect(screen, PROVIDERS, 5);
      const without = rowsOf(screen);
      renderProviderSelect(screen, PROVIDERS, 5, HINT);
      const rows = rowsOf(screen);
      expect(rows[1], `${height} rows`).toContain('Welcome to Codeep');
      if (!rows.some(row => row.includes('Keys on codeep.dev'))) expect(rows).toEqual(without);
      for (const step of undo.splice(0).reverse()) step();
    }
  });
});

describe('the API key screen', () => {
  const SAVE_ERROR = 'Could not save the API key (secure storage unavailable). Please try again.';

  function keyScreen(height: number, error?: string) {
    const screen = screenOf(height);
    const login = new LoginScreen(screen, new Input(), {
      providerName: 'Alpha', error, onSubmit: () => {}, onCancel: () => {},
    });
    login.handleKey({ key: 'abcdefghij', ctrl: false, alt: false, shift: false, raw: 'abcdefghij', isPaste: true });
    const rows = rowsOf(screen);
    const cursorY = (screen as unknown as { cursorY: number }).cursorY;
    return { rows, cursorY };
  }

  for (const [label, error, minHeight] of [
    ['no error', undefined, 12],
    ['a short error', 'API key too short', 13],
    ['a long error', SAVE_ERROR, 14],
  ] as const) {
    for (let height = minHeight; height <= 30; height++) {
      it(`keeps the title, the field and the key hints on screen at ${height} rows (${label})`, () => {
        const { rows, cursorY } = keyScreen(height, error);
        expect(rows[1]).toContain('Codeep Setup');
        expect(rows[2].trim()).toBe('');

        const top = rowOf(rows, 'Alpha API Key');
        const bottom = rows.findIndex((row, y) => y > top && row.includes('╰'));
        expect(top).toBeGreaterThanOrEqual(3);
        expect(bottom).toBeGreaterThan(top);
        expect(bottom).toBeLessThanOrEqual(height - 2);
        // Nothing in the box runs over its right border (a long error wraps).
        const right = rows[top].lastIndexOf('╮');
        for (let y = top + 1; y < bottom; y++) expect(rows[y][right], `row ${y}`).toBe('│');

        const field = rowOf(rows, '│ **********');
        expect(field).toBeGreaterThan(top);
        expect(cursorY).toBe(field);
        const hints = rowOf(rows, 'Ctrl+V: Paste');
        expect(hints).toBeGreaterThan(field);
        expect(rowOf(rows, 'Esc: Cancel')).toBe(hints + 1);
        expect(hints + 1).toBeLessThan(bottom);
        if (error) {
          const shown = rows.slice(field + 1, hints).join(' ').replace(/[│\s]+/g, ' ');
          expect(shown).toContain(error === SAVE_ERROR ? 'Could not save the API key' : error);
          if (error === SAVE_ERROR) expect(shown).toContain('Please try again.');
        }
      });
    }
  }

  it('keeps its full layout where there is room', () => {
    // As before 3.9.1: a 14-row box centred in 24 rows, the field on row 10.
    const { rows, cursorY } = keyScreen(24, 'API key too short');
    expect(rowOf(rows, 'Alpha API Key')).toBe(5);
    expect(rows[18]).toContain('╰');
    expect(rowOf(rows, 'Enter your API key')).toBe(7);
    expect(cursorY).toBe(10);
    expect(rowOf(rows, 'API key too short')).toBe(13);
    expect(rowOf(rows, 'Ctrl+V: Paste')).toBe(14);
  });

  it('still draws something on a terminal shorter than that', () => {
    for (let height = 4; height < 12; height++) {
      expect(() => keyScreen(height, 'API key too short')).not.toThrow();
      for (const step of undo.splice(0).reverse()) step();
    }
  });
});
