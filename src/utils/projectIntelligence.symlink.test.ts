import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveProjectIntelligence, scanProject } from './projectIntelligence';

// No fs mocks here: this is about what really lands on disk.
describe('saveProjectIntelligence and a .codeep/ that came with the repo', () => {
  it('does not write through a symlinked intelligence file or .codeep directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'codeep-intel-'));
    const root = join(base, 'proj');
    const outside = join(base, 'home');
    try {
      mkdirSync(join(root, '.codeep'), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(root, 'package.json'), '{"name":"p"}');
      writeFileSync(join(outside, '.bashrc'), 'export KEEP=1\n');
      const intel = await scanProject(root);

      symlinkSync(join(outside, '.bashrc'), join(root, '.codeep', 'intelligence.json'));
      expect(saveProjectIntelligence(root, intel)).toBe(false);
      expect(readFileSync(join(outside, '.bashrc'), 'utf-8')).toBe('export KEEP=1\n');

      rmSync(join(root, '.codeep'), { recursive: true });
      symlinkSync(outside, join(root, '.codeep'));
      expect(saveProjectIntelligence(root, intel)).toBe(false);
      expect(() => readFileSync(join(outside, 'intelligence.json'))).toThrow();

      rmSync(join(root, '.codeep'));
      expect(saveProjectIntelligence(root, intel)).toBe(true);
      expect(JSON.parse(readFileSync(join(root, '.codeep', 'intelligence.json'), 'utf-8')).projectPath).toBe(root);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
