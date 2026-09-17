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

import { executeTool, FsCallbacks } from './toolExecution';
import { ToolCall } from './tools';
import {
  startSession, endSession, clearHistory, getCurrentSession, undoLastAction, undoAllActions,
} from './history';
import { AcpRequestError, AcpRequestTimeoutError } from '../acp/transport';

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

/** An editor that writes through to disk, as one that saves does. */
const savingEditor = (): FsCallbacks => ({
  readTextFile: vi.fn(async (p: string) => readFileSync(p, 'utf-8')),
  writeTextFile: vi.fn(async (p: string, c: string) => { writeFileSync(p, c); }),
});
/** An editor that answers every write with an error. */
const refusingEditor = (): FsCallbacks => ({
  readTextFile: vi.fn(async (p: string) => readFileSync(p, 'utf-8')),
  writeTextFile: vi.fn().mockRejectedValue(new AcpRequestError('fs/write_text_file', -32603, 'Buffer is read-only')),
});

const paths: Array<[string, () => FsCallbacks | undefined]> = [
  ['disk', () => undefined],
  ['editor', savingEditor],
];

describe.each(paths)('write_file then /undo (%s path)', (_label, editor) => {
  it('puts an overwritten file back', async () => {
    writeFileSync(file('old.txt'), 'original\n');
    const result = await executeTool(call('write_file', { path: 'old.txt', content: 'agent\n' }), root, editor());
    expect(result.success).toBe(true);
    expect(read('old.txt')).toBe('agent\n');

    expect(undoLastAction(root)).toEqual({ success: true, message: `Restored: ${file('old.txt')}` });
    expect(read('old.txt')).toBe('original\n');
  });

  it('removes a file it created', async () => {
    const result = await executeTool(call('write_file', { path: 'new.txt', content: 'agent\n' }), root, editor());
    expect(result.success).toBe(true);
    expect(existsSync(file('new.txt'))).toBe(true);

    expect(undoLastAction(root)).toEqual({ success: true, message: `Deleted new file: ${file('new.txt')}` });
    expect(existsSync(file('new.txt'))).toBe(false);
  });

  it('undoes every write of a finished run', async () => {
    writeFileSync(file('old.txt'), 'original\n');
    const fs = editor();
    await executeTool(call('write_file', { path: 'old.txt', content: 'first\n' }), root, fs);
    await executeTool(call('write_file', { path: 'old.txt', content: 'second\n' }), root, fs);
    await executeTool(call('write_file', { path: 'new.txt', content: 'agent\n' }), root, fs);
    endSession();

    const result = undoAllActions(root);
    expect(result.success).toBe(true);
    expect(read('old.txt')).toBe('original\n');
    expect(existsSync(file('new.txt'))).toBe(false);
  });
});

describe.each(paths)('/undo after the user changed the file (%s path)', (_label, editor) => {
  it('does not overwrite an edit made after the run', async () => {
    writeFileSync(file('app.ts'), 'original\n');
    await executeTool(call('edit_file', { path: 'app.ts', old_text: 'original', new_text: 'agent' }), root, editor());
    endSession();
    writeFileSync(file('app.ts'), 'agent\nplus the user\'s own work\n');

    const result = undoLastAction(root);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/has changed since the agent wrote it/);
    expect(read('app.ts')).toBe('agent\nplus the user\'s own work\n');
  });

  it('does not delete a created file the user has since written to', async () => {
    await executeTool(call('write_file', { path: 'notes.md', content: 'agent draft\n' }), root, editor());
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

describe.each(paths)('edit_file then /undo (%s path)', (_label, editor) => {
  it('puts the edited file back', async () => {
    writeFileSync(file('f.txt'), 'hello world\n');
    const result = await executeTool(
      call('edit_file', { path: 'f.txt', old_text: 'world', new_text: 'agent' }), root, editor(),
    );
    expect(result.success).toBe(true);
    expect(read('f.txt')).toBe('hello agent\n');

    expect(undoLastAction(root)).toEqual({ success: true, message: `Restored: ${file('f.txt')}` });
    expect(read('f.txt')).toBe('hello world\n');
  });

  it('records nothing for a file that is not there', async () => {
    writeFileSync(file('g.txt'), 'g original\n');
    await executeTool(call('write_file', { path: 'g.txt', content: 'g agent\n' }), root);
    const fs = editor();
    if (fs) fs.readTextFile = vi.fn().mockRejectedValue(new Error('no such buffer'));
    const result = await executeTool(
      call('edit_file', { path: 'missing.txt', old_text: 'a', new_text: 'b' }), root, fs,
    );
    expect(result.success).toBe(false);
    expect(recordsFor('missing.txt')).toHaveLength(0);

    // /undo reaches the write that did happen.
    expect(undoLastAction(root).message).toBe(`Restored: ${file('g.txt')}`);
    expect(read('g.txt')).toBe('g original\n');
  });
});

describe('edit_file on a file only the editor has', () => {
  // The editor holds an unsaved buffer the disk has never seen. There is no
  // earlier version to put back, and deleting the file would throw the
  // user's text away, so /undo must leave it alone.
  it('does not destroy the file on /undo', async () => {
    const fs: FsCallbacks = {
      readTextFile: vi.fn(async () => 'unsaved buffer\n'),
      writeTextFile: vi.fn(async (p: string, c: string) => { writeFileSync(p, c); }),
    };
    const result = await executeTool(
      call('edit_file', { path: 'buffer.txt', old_text: 'unsaved', new_text: 'edited' }), root, fs,
    );
    expect(result.success).toBe(true);

    expect(undoLastAction(root).success).toBe(false);
    expect(read('buffer.txt')).toBe('edited buffer\n');
  });
});

describe('a write the editor refused', () => {
  // The run changed g.txt for real; the refused write to f.txt changed
  // nothing. /undo must reach g.txt and leave what the user saved in f.txt.
  const earlierRealWrite = async () => {
    writeFileSync(file('g.txt'), 'g original\n');
    const done = await executeTool(call('write_file', { path: 'g.txt', content: 'g agent\n' }), root);
    expect(done.success).toBe(true);
  };

  it.each([
    ['write_file', { path: 'f.txt', content: 'agent\n' }],
    ['edit_file', { path: 'f.txt', old_text: 'disk', new_text: 'agent' }],
  ])('%s leaves no undo record behind', async (tool, parameters) => {
    await earlierRealWrite();
    writeFileSync(file('f.txt'), 'hello disk\n');

    const result = await executeTool(call(tool, parameters), root, refusingEditor());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/refused/);
    expect(read('f.txt')).toBe('hello disk\n');
    expect(recordsFor('f.txt')).toHaveLength(0);

    writeFileSync(file('f.txt'), 'user saved content\n');
    expect(undoLastAction(root)).toEqual({ success: true, message: `Restored: ${file('g.txt')}` });
    expect(read('g.txt')).toBe('g original\n');
    expect(read('f.txt')).toBe('user saved content\n');
  });

  it('write_file of a new file leaves no record, so /undo deletes nothing the user makes later', async () => {
    await earlierRealWrite();
    const result = await executeTool(call('write_file', { path: 'f.txt', content: 'agent\n' }), root, refusingEditor());
    expect(result.success).toBe(false);
    expect(existsSync(file('f.txt'))).toBe(false);
    expect(recordsFor('f.txt')).toHaveLength(0);

    writeFileSync(file('f.txt'), 'user made this\n');
    endSession();
    undoAllActions(root);
    expect(read('f.txt')).toBe('user made this\n');
    expect(read('g.txt')).toBe('g original\n');
  });
});

describe('an editor write that fails without an answer', () => {
  // A timeout falls back to disk. The record taken before the editor was
  // tried stays the only one, and still holds the original.
  it('keeps one record, holding the original', async () => {
    writeFileSync(file('old.txt'), 'original\n');
    const fs: FsCallbacks = {
      writeTextFile: vi.fn().mockRejectedValue(new AcpRequestTimeoutError('fs/write_text_file', 30_000)),
    };
    const result = await executeTool(call('write_file', { path: 'old.txt', content: 'agent\n' }), root, fs);
    expect(result.success).toBe(true);
    expect(read('old.txt')).toBe('agent\n');
    expect(recordsFor('old.txt')).toHaveLength(1);

    undoLastAction(root);
    expect(read('old.txt')).toBe('original\n');
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
