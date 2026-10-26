/**
 * /undo end to end for the file tools: a real write_file / edit_file, then
 * the undo that /undo runs. An undo record has to describe a change that
 * really happened and hold what the file was before it; a record for a write
 * that never happened would let /undo overwrite the file with stale content.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// The undo history is saved under the home directory, and clearHistory()
// empties that folder. Point it at a throwaway one.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const home = join(actual.tmpdir(), `codeep-undo-test-home-${process.pid}`);
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

import { executeTool } from './toolExecution';
import { ToolCall } from './tools';
import {
  startSession, endSession, clearHistory, getCurrentSession, undoLastAction, undoAllActions,
} from './history';

const fakeHome = homedir();
let root: string;

beforeAll(() => {
  // Never let clearHistory() near a real home directory.
  expect(fakeHome).toContain('codeep-undo-test-home-');
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-undo-'));
  startSession('undo test', root);
});

afterEach(() => {
  endSession();
  clearHistory();
  rmSync(root, { recursive: true, force: true });
});

const call = (tool: string, parameters: Record<string, unknown>): ToolCall =>
  ({ id: 't1', tool, parameters } as ToolCall);
const file = (name: string) => join(root, name);
const read = (name: string) => readFileSync(file(name), 'utf-8');
const recordsFor = (name: string) =>
  (getCurrentSession(root)?.actions ?? []).filter(a => a.path === file(name));

describe('write_file then /undo', () => {
  it('puts an overwritten file back', async () => {
    writeFileSync(file('old.txt'), 'original\n');
    const result = await executeTool(call('write_file', { path: 'old.txt', content: 'agent\n' }), root);
    expect(result.success).toBe(true);
    expect(read('old.txt')).toBe('agent\n');

    expect(undoLastAction(root)).toEqual({ success: true, message: `Restored: ${file('old.txt')}` });
    expect(read('old.txt')).toBe('original\n');
  });

  it('removes a file it created', async () => {
    const result = await executeTool(call('write_file', { path: 'new.txt', content: 'agent\n' }), root);
    expect(result.success).toBe(true);
    expect(existsSync(file('new.txt'))).toBe(true);

    expect(undoLastAction(root)).toEqual({ success: true, message: `Deleted new file: ${file('new.txt')}` });
    expect(existsSync(file('new.txt'))).toBe(false);
  });

  it('undoes every write of a finished run', async () => {
    writeFileSync(file('old.txt'), 'original\n');
    await executeTool(call('write_file', { path: 'old.txt', content: 'first\n' }), root);
    await executeTool(call('write_file', { path: 'old.txt', content: 'second\n' }), root);
    await executeTool(call('write_file', { path: 'new.txt', content: 'agent\n' }), root);
    endSession();

    const result = undoAllActions(root);
    expect(result.success).toBe(true);
    expect(read('old.txt')).toBe('original\n');
    expect(existsSync(file('new.txt'))).toBe(false);
  });
});

describe('/undo after the user changed the file', () => {
  it('does not overwrite an edit made after the run', async () => {
    writeFileSync(file('app.ts'), 'original\n');
    await executeTool(call('edit_file', { path: 'app.ts', old_text: 'original', new_text: 'agent' }), root);
    endSession();
    writeFileSync(file('app.ts'), 'agent\nplus the user\'s own work\n');

    const result = undoLastAction(root);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/has changed since the agent wrote it/);
    expect(read('app.ts')).toBe('agent\nplus the user\'s own work\n');
  });

  it('does not delete a created file the user has since written to', async () => {
    await executeTool(call('write_file', { path: 'notes.md', content: 'agent draft\n' }), root);
    endSession();
    writeFileSync(file('notes.md'), 'my own notes\n');

    const all = undoAllActions(root);
    expect(all.results.join('\n')).toMatch(/has changed since the agent wrote it/);
    expect(read('notes.md')).toBe('my own notes\n');
  });
});

describe('/undo of a deleted file', () => {
  it('does not overwrite a file the user created again', async () => {
    writeFileSync(file('gone.txt'), 'agent deleted this\n');
    await executeTool(call('delete_file', { path: 'gone.txt' }), root);
    endSession();
    writeFileSync(file('gone.txt'), 'the user wrote a new one\n');

    const result = undoLastAction(root);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/exists again/);
    expect(read('gone.txt')).toBe('the user wrote a new one\n');
  });

  it('still restores it when nothing took its place', async () => {
    writeFileSync(file('gone.txt'), 'agent deleted this\n');
    await executeTool(call('delete_file', { path: 'gone.txt' }), root);
    endSession();
    expect(undoLastAction(root).success).toBe(true);
    expect(read('gone.txt')).toBe('agent deleted this\n');
  });
});

describe('edit_file then /undo', () => {
  it('puts the edited file back', async () => {
    writeFileSync(file('f.txt'), 'hello world\n');
    const result = await executeTool(
      call('edit_file', { path: 'f.txt', old_text: 'world', new_text: 'agent' }), root,
    );
    expect(result.success).toBe(true);
    expect(read('f.txt')).toBe('hello agent\n');

    expect(undoLastAction(root)).toEqual({ success: true, message: `Restored: ${file('f.txt')}` });
    expect(read('f.txt')).toBe('hello world\n');
  });

  it('records nothing for a file that is not there', async () => {
    writeFileSync(file('g.txt'), 'g original\n');
    await executeTool(call('write_file', { path: 'g.txt', content: 'g agent\n' }), root);
    const result = await executeTool(
      call('edit_file', { path: 'missing.txt', old_text: 'a', new_text: 'b' }), root,
    );
    expect(result.success).toBe(false);
    expect(recordsFor('missing.txt')).toHaveLength(0);

    // /undo reaches the write that did happen.
    expect(undoLastAction(root).message).toBe(`Restored: ${file('g.txt')}`);
    expect(read('g.txt')).toBe('g original\n');
  });
});

// Root can write through a read-only mode, so the failure cannot be staged.
const canStageWriteFailure = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.skipIf(!canStageWriteFailure)('a disk write that throws', () => {
  it.each([
    ['write_file', { path: 'ro.txt', content: 'agent\n' }],
    ['edit_file', { path: 'ro.txt', old_text: 'original', new_text: 'agent' }],
  ])('%s leaves no undo record behind', async (tool, parameters) => {
    writeFileSync(file('ro.txt'), 'original\n');
    chmodSync(file('ro.txt'), 0o444);
    try {
      const result = await executeTool(call(tool, parameters), root);
      expect(result.success).toBe(false);
      expect(recordsFor('ro.txt')).toHaveLength(0);
    } finally {
      chmodSync(file('ro.txt'), 0o644);
    }
  });
});
