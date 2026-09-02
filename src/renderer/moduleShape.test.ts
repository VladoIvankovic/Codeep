import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the one thing `tsc` used to compile happily and `tsx` refused to run.
 *
 * `export { SomeInterface } from './x'` type-checks and builds — tsc erases the
 * type — so `dist/` and CI were fine. tsx transpiles file by file with no idea
 * whether the name is a type, leaves the re-export in, and the ESM loader then
 * fails to find an export that never existed at runtime. `npm run dev` was dead
 * for two weeks on exactly that, with every check green.
 *
 * `isolatedModules` in tsconfig is the real fix and now errors on it. This test
 * is here so the setting cannot be quietly turned off again without something
 * saying so.
 */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

describe('module shape', () => {
  it('keeps isolatedModules on, which is what catches type re-exports', () => {
    const tsconfig = readFileSync('tsconfig.json', 'utf8');
    expect(tsconfig).toMatch(/"isolatedModules"\s*:\s*true/);
  });

  it('re-exports nothing that only exists at compile time', () => {
    // Names that are types, and would break a per-file transpiler if they were
    // ever re-exported as values again.
    const typeOnly = [
      'HunkPickerItem', 'HunkPickerOptions', 'Cell', 'KeyEvent', 'KeyHandler',
      'AppOptions', 'Message', 'BoxStyle', 'BoxOptions', 'ModalOptions', 'StatusInfo',
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const match = /^export\s*\{([^}]*)\}\s*from/.exec(line.trim());
        if (!match) continue;
        const names = match[1]!.split(',').map(n => n.trim().split(/\s+as\s+/)[0]!.trim());
        for (const name of names) {
          if (typeOnly.includes(name)) offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
