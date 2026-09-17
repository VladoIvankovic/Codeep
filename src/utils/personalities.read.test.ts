import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real fs, with readFileSync recorded so a test can prove a file was never read.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const { fakeHomeRef } = vi.hoisted(() => ({ fakeHomeRef: { current: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHomeRef.current || actual.homedir() };
});
vi.mock('../config/index.js', () => ({ config: { get: () => undefined, set: () => undefined } }));

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAllPersonalities } from './personalities';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-personality-read-'));
  fakeHomeRef.current = join(root, 'home');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  fakeHomeRef.current = '';
});

describe('custom personality files', () => {
  it('checks the kind and size of a personality file before reading it', () => {
    // A cloned repo can commit `.codeep/personalities/x.md -> /dev/zero` (or
    // a FIFO), and readFileSync on either never returns. /dev/null takes the
    // same path but returns at once.
    const dir = join(root, 'project', '.codeep', 'personalities');
    mkdirSync(dir, { recursive: true });
    symlinkSync('/dev/null', join(dir, 'device.md'));
    writeFileSync(join(dir, 'huge.md'), 'x'.repeat(64 * 1024 + 1));
    writeFileSync(join(dir, 'terse.md'), 'Answer in one line.');
    vi.mocked(readFileSync).mockClear();

    const project = loadAllPersonalities(join(root, 'project')).filter((p) => p.scope === 'project');
    expect(project.map((p) => p.name)).toEqual(['terse']);
    const read = vi.mocked(readFileSync).mock.calls.map((c) => String(c[0]));
    expect(read).toEqual([join(dir, 'terse.md')]);
  });
});
