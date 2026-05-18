import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  formatCheckpointList,
  buildRewindGitHint,
  Checkpoint,
} from './checkpoints';
import type { Message } from '../config';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codeep-checkpoints-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const sampleMessages = (): Message[] => [
  { role: 'user', content: 'refactor auth' },
  { role: 'assistant', content: 'done' },
];

describe('createCheckpoint', () => {
  it('writes a JSON file under .codeep/checkpoints/', () => {
    const cp = createCheckpoint({
      workspaceRoot,
      sessionId: 'session-1',
      provider: 'z.ai',
      model: 'glm-5.1',
      messages: sampleMessages(),
      filesTouched: ['src/a.ts'],
      name: 'before refactor',
    });

    expect(cp.id).toMatch(/^ck-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
    expect(cp.name).toBe('before refactor');
    expect(cp.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const file = join(workspaceRoot, '.codeep', 'checkpoints', `${cp.id}.json`);
    expect(existsSync(file)).toBe(true);
    const loaded = JSON.parse(readFileSync(file, 'utf-8'));
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.filesTouched).toEqual(['src/a.ts']);
  });

  it('records gitHead when workspace is a git repo (skipped otherwise)', () => {
    // tmp workspaces aren't git repos, so gitHead should be undefined here.
    // The presence/absence is what matters — value is opaque from this test's POV.
    const cp = createCheckpoint({
      workspaceRoot,
      sessionId: 'session-1',
      provider: 'z.ai',
      model: 'glm-5.1',
      messages: [],
      filesTouched: [],
    });
    expect(cp.gitHead).toBeUndefined();
  });

  it('persists provider and model so /rewind can suggest restoring them', () => {
    const cp = createCheckpoint({
      workspaceRoot,
      sessionId: 's1',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      messages: [],
      filesTouched: [],
    });
    expect(cp.provider).toBe('anthropic');
    expect(cp.model).toBe('claude-opus-4-7');
  });
});

describe('loadCheckpoint', () => {
  it('returns null for unknown id', () => {
    expect(loadCheckpoint(workspaceRoot, 'ck-2026-05-18-deadbeef')).toBeNull();
  });

  it('returns null for ids that don\'t match the expected format (path traversal guard)', () => {
    // Even if a file with this name existed, we should refuse to read it.
    expect(loadCheckpoint(workspaceRoot, '../etc/passwd')).toBeNull();
    expect(loadCheckpoint(workspaceRoot, 'not-a-checkpoint-id')).toBeNull();
    expect(loadCheckpoint(workspaceRoot, 'ck-')).toBeNull();
  });

  it('round-trips a saved checkpoint', () => {
    const original = createCheckpoint({
      workspaceRoot,
      sessionId: 's1',
      provider: 'z.ai',
      model: 'glm-5.1',
      messages: sampleMessages(),
      filesTouched: ['x.ts'],
      name: 'rt',
    });
    const loaded = loadCheckpoint(workspaceRoot, original.id);
    expect(loaded?.id).toBe(original.id);
    expect(loaded?.messages).toEqual(sampleMessages());
  });

  it('returns null when the file is corrupt JSON', () => {
    const id = 'ck-2026-05-18-deadbeef';
    const dir = join(workspaceRoot, '.codeep', 'checkpoints');
    // Need to create the directory by triggering listCheckpoints first
    listCheckpoints(workspaceRoot);
    writeFileSync(join(dir, `${id}.json`), '{ not valid json');
    expect(loadCheckpoint(workspaceRoot, id)).toBeNull();
  });
});

describe('listCheckpoints', () => {
  it('returns empty array when no checkpoints exist', () => {
    expect(listCheckpoints(workspaceRoot)).toEqual([]);
  });

  it('returns metadata for all checkpoints, newest first', async () => {
    const first = createCheckpoint({
      workspaceRoot, sessionId: 's1', provider: 'z.ai', model: 'glm-5.1',
      messages: sampleMessages(), filesTouched: [], name: 'first',
    });
    // Ensure distinct timestamps (millisecond resolution can collide on fast machines).
    await new Promise(r => setTimeout(r, 5));
    const second = createCheckpoint({
      workspaceRoot, sessionId: 's2', provider: 'z.ai', model: 'glm-5.1',
      messages: [], filesTouched: ['a.ts', 'b.ts'], name: 'second',
    });

    const metas = listCheckpoints(workspaceRoot);
    expect(metas).toHaveLength(2);
    expect(metas[0].id).toBe(second.id);  // newest first
    expect(metas[1].id).toBe(first.id);
    expect(metas[0].filesTouchedCount).toBe(2);
    expect(metas[1].messageCount).toBe(2);
  });

  it('skips corrupt entries without failing the whole list', () => {
    const good = createCheckpoint({
      workspaceRoot, sessionId: 's1', provider: 'z.ai', model: 'glm-5.1',
      messages: [], filesTouched: [],
    });
    const dir = join(workspaceRoot, '.codeep', 'checkpoints');
    writeFileSync(join(dir, 'ck-2026-05-18-corrupt0.json'), '{ broken');
    const metas = listCheckpoints(workspaceRoot);
    expect(metas.map(m => m.id)).toEqual([good.id]);
  });

  it('does not include lightweight metadata\'s full messages array (memory cost)', () => {
    createCheckpoint({
      workspaceRoot, sessionId: 's1', provider: 'z.ai', model: 'glm-5.1',
      messages: sampleMessages(), filesTouched: [],
    });
    const metas = listCheckpoints(workspaceRoot);
    expect(metas[0]).not.toHaveProperty('messages');
    expect(metas[0].messageCount).toBe(2);
  });
});

describe('deleteCheckpoint', () => {
  it('returns false for unknown id', () => {
    expect(deleteCheckpoint(workspaceRoot, 'ck-2026-05-18-deadbeef')).toBe(false);
  });

  it('refuses malformed ids (path traversal guard)', () => {
    expect(deleteCheckpoint(workspaceRoot, '../etc/passwd')).toBe(false);
    expect(deleteCheckpoint(workspaceRoot, 'foo')).toBe(false);
  });

  it('removes the file and returns true', () => {
    const cp = createCheckpoint({
      workspaceRoot, sessionId: 's1', provider: 'z.ai', model: 'glm-5.1',
      messages: [], filesTouched: [],
    });
    const file = join(workspaceRoot, '.codeep', 'checkpoints', `${cp.id}.json`);
    expect(existsSync(file)).toBe(true);
    expect(deleteCheckpoint(workspaceRoot, cp.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe('formatCheckpointList', () => {
  it('shows guidance when no checkpoints exist', () => {
    const out = formatCheckpointList([]);
    expect(out).toMatch(/No checkpoints yet/);
    expect(out).toMatch(/before risky refactors/);
  });

  it('renders each checkpoint with date, message count, files count', () => {
    const out = formatCheckpointList([{
      id: 'ck-2026-05-18-abcdef01',
      name: 'before refactor',
      createdAt: '2026-05-18T10:30:00Z',
      sessionId: 's1',
      messageCount: 5,
      filesTouchedCount: 3,
      gitHead: 'abc1234',
    }]);
    expect(out).toMatch(/## Checkpoints/);
    expect(out).toMatch(/before refactor/);
    expect(out).toMatch(/ck-2026-05-18-abcdef01/);
    expect(out).toMatch(/5 messages · 3 files touched/);
    expect(out).toMatch(/git `abc1234`/);
  });

  it('omits git fragment when no gitHead recorded', () => {
    const out = formatCheckpointList([{
      id: 'ck-2026-05-18-abcdef01',
      createdAt: '2026-05-18T10:30:00Z',
      sessionId: 's1',
      messageCount: 1,
      filesTouchedCount: 0,
    }]);
    expect(out).not.toMatch(/git `/);
  });
});

describe('buildRewindGitHint', () => {
  it('shows git checkout command when gitHead is recorded', () => {
    const cp: Checkpoint = {
      id: 'ck-1', createdAt: '', sessionId: 's',
      provider: 'p', model: 'm', messages: [],
      filesTouched: ['src/a.ts', 'src/b.ts'],
      gitHead: 'abc1234',
    };
    const hint = buildRewindGitHint(cp);
    expect(hint).toMatch(/git checkout abc1234 -- 'src\/a\.ts' 'src\/b\.ts'/);
    expect(hint).toMatch(/git stash/);
  });

  it('falls back to git restore . when no specific files recorded', () => {
    const cp: Checkpoint = {
      id: 'ck-1', createdAt: '', sessionId: 's',
      provider: 'p', model: 'm', messages: [],
      filesTouched: [], gitHead: 'abc1234',
    };
    expect(buildRewindGitHint(cp)).toMatch(/git checkout abc1234 -- \./);
  });

  it('gives non-git guidance when no gitHead', () => {
    const cp: Checkpoint = {
      id: 'ck-1', createdAt: '', sessionId: 's',
      provider: 'p', model: 'm', messages: [],
      filesTouched: ['x.ts'],
    };
    const hint = buildRewindGitHint(cp);
    expect(hint).not.toMatch(/git checkout/);
    expect(hint).toMatch(/x\.ts/);
  });
});
