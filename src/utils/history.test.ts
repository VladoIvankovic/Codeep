import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs before importing — preserve all original exports so transitive deps work
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

// Mock os.homedir so HISTORY_DIR is predictable
vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, statSync, readdirSync } from 'fs';
import {
  startSession,
  endSession,
  recordWrite,
  recordEdit,
  recordDelete,
  recordMkdir,
  recordCommand,
  getCurrentSession,
  undoLastAction,
  undoAllActions,
  undoAction,
  getRecentSessions,
  getSession,
  formatSession,
  clearHistory,
} from './history';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;
const mockUnlinkSync = unlinkSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;

// Reset module-level currentSession between tests by calling endSession
function resetSession() {
  // endSession sets currentSession = null; avoid writing to disk by not having actions
  endSession();
}

describe('startSession / getCurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('creates a new session and returns a session ID', () => {
    const id = startSession('build the thing', '/my/project');
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('getCurrentSession returns the active session', () => {
    startSession('do stuff', '/my/project');
    const session = getCurrentSession();
    expect(session).not.toBeNull();
    expect(session!.prompt).toBe('do stuff');
    expect(session!.projectRoot).toBe('/my/project');
    expect(session!.actions).toHaveLength(0);
  });

  it('getCurrentSession returns null before any session starts', () => {
    // Already reset, so no session
    expect(getCurrentSession()).toBeNull();
  });
});

describe('endSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
    // Ensure HISTORY_DIR "exists" by default
    mockExistsSync.mockReturnValue(true);
  });

  it('sets currentSession to null', () => {
    startSession('task', '/project');
    endSession();
    expect(getCurrentSession()).toBeNull();
  });

  it('writes session to disk when there are actions', () => {
    startSession('task', '/project');
    // Add a record to the session
    mockExistsSync.mockReturnValue(false); // path doesn't exist
    recordWrite('/project/foo.ts');
    mockExistsSync.mockReturnValue(true); // HISTORY_DIR exists

    endSession();

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFileSync.mock.calls[0];
    expect(path).toContain('.codeep/history');
    const parsed = JSON.parse(content as string);
    expect(parsed.prompt).toBe('task');
    expect(parsed.actions).toHaveLength(1);
  });

  it('does not write to disk when session has no actions', () => {
    startSession('empty task', '/project');
    endSession();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('does nothing when called with no active session', () => {
    expect(() => endSession()).not.toThrow();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('recordWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns null when no session active', () => {
    expect(recordWrite('/some/file.ts')).toBeNull();
  });

  it('records path and previousExisted=false when file is new', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(false);

    const record = recordWrite('/project/new.ts');
    expect(record).not.toBeNull();
    expect(record!.type).toBe('write');
    expect(record!.path).toBe('/project/new.ts');
    expect(record!.previousExisted).toBe(false);
    expect(record!.previousContent).toBeUndefined();
  });

  it('saves previousContent when file already existed', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('old content');

    const record = recordWrite('/project/existing.ts');
    expect(record!.previousExisted).toBe(true);
    expect(record!.previousContent).toBe('old content');
  });

  it('adds record to session actions', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(false);
    recordWrite('/project/foo.ts');
    expect(getCurrentSession()!.actions).toHaveLength(1);
  });
});

describe('recordEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns null when no session active', () => {
    expect(recordEdit('/file.ts')).toBeNull();
  });

  it('saves previous content of file', () => {
    startSession('task', '/project');
    mockReadFileSync.mockReturnValue('original content');

    const record = recordEdit('/project/edit.ts');
    expect(record!.type).toBe('edit');
    expect(record!.previousContent).toBe('original content');
    expect(record!.previousExisted).toBe(true);
  });

  it('handles unreadable files gracefully', () => {
    startSession('task', '/project');
    mockReadFileSync.mockImplementation(() => { throw new Error('permission denied'); });

    const record = recordEdit('/project/secret.ts');
    expect(record).not.toBeNull();
    expect(record!.previousContent).toBeUndefined();
  });
});

describe('recordDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns null when no session active', () => {
    expect(recordDelete('/file.ts')).toBeNull();
  });

  it('records file delete with content', () => {
    startSession('task', '/project');
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    mockReadFileSync.mockReturnValue('file content');

    const record = recordDelete('/project/del.ts');
    expect(record!.type).toBe('delete');
    expect(record!.wasDirectory).toBe(false);
    expect(record!.deletedContent).toBe('file content');
  });

  it('records directory delete', () => {
    startSession('task', '/project');
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    const record = recordDelete('/project/dir');
    expect(record!.wasDirectory).toBe(true);
    expect(record!.deletedContent).toBeUndefined();
  });

  it('handles stat errors gracefully', () => {
    startSession('task', '/project');
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

    expect(() => recordDelete('/project/gone.ts')).not.toThrow();
  });
});

describe('recordMkdir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns null when no session active', () => {
    expect(recordMkdir('/dir')).toBeNull();
  });

  it('records mkdir with previousExisted', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(false);

    const record = recordMkdir('/project/new-dir');
    expect(record!.type).toBe('mkdir');
    expect(record!.previousExisted).toBe(false);
  });
});

describe('recordCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns null when no session active', () => {
    expect(recordCommand('npm', ['install'])).toBeNull();
  });

  it('records command with args', () => {
    startSession('task', '/project');
    const record = recordCommand('git', ['commit', '-m', 'fix']);
    expect(record!.type).toBe('command');
    expect(record!.command).toBe('git');
    expect(record!.args).toEqual(['commit', '-m', 'fix']);
  });
});

describe('undoLastAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns failure message when no session', () => {
    const result = undoLastAction();
    expect(result.success).toBe(false);
    expect(result.message).toContain('No actions');
  });

  it('returns failure when session is empty', () => {
    startSession('task', '/project');
    const result = undoLastAction();
    expect(result.success).toBe(false);
  });

  it('undoes a write that created a new file (delete it)', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(false);
    const record = recordWrite('/project/new.ts');
    // Now the file "exists" after writing
    mockExistsSync.mockReturnValue(true);

    const result = undoLastAction();
    expect(result.success).toBe(true);
    expect(mockUnlinkSync).toHaveBeenCalledWith('/project/new.ts');
    expect(record!.undone).toBe(true);
  });

  it('undoes a write that overwrote an existing file (restore)', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(true); // file existed
    mockReadFileSync.mockReturnValue('old content');
    const record = recordWrite('/project/existing.ts');

    const result = undoLastAction();
    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/project/existing.ts', 'old content');
    expect(record!.undone).toBe(true);
  });

  it('undoes an edit (restore previous content)', () => {
    startSession('task', '/project');
    mockReadFileSync.mockReturnValue('original');
    const record = recordEdit('/project/edit.ts');

    const result = undoLastAction();
    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/project/edit.ts', 'original');
    expect(record!.undone).toBe(true);
  });

  it('undoes a delete (recreate file)', () => {
    startSession('task', '/project');
    mockStatSync.mockReturnValue({ isDirectory: () => false });
    mockReadFileSync.mockReturnValue('deleted content');
    const record = recordDelete('/project/del.ts');
    mockExistsSync.mockReturnValue(true); // dir exists

    const result = undoLastAction();
    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/project/del.ts', 'deleted content');
    expect(record!.undone).toBe(true);
  });

  it('fails to undo directory delete (not supported)', () => {
    startSession('task', '/project');
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    recordDelete('/project/dir');

    const result = undoLastAction();
    expect(result.success).toBe(false);
    expect(result.message).toContain('git checkout');
  });

  it('fails to undo a command', () => {
    startSession('task', '/project');
    recordCommand('npm', ['install']);

    const result = undoLastAction();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Cannot undo command');
  });

  it('skips already-undone actions', () => {
    startSession('task', '/project');
    mockExistsSync.mockReturnValue(false);
    const record = recordWrite('/project/new.ts');
    record!.undone = true;

    const result = undoLastAction();
    expect(result.success).toBe(false);
    expect(result.message).toContain('already undone');
  });
});

describe('undoAllActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
  });

  it('returns failure when no session', () => {
    const result = undoAllActions();
    expect(result.success).toBe(false);
  });

  it('undoes all actions in reverse order', () => {
    startSession('task', '/project');
    mockReadFileSync.mockReturnValue('original');
    recordEdit('/project/file1.ts');
    recordEdit('/project/file2.ts');

    const result = undoAllActions();
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    // Both writes should happen
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
  });

  it('reports partial success when some actions cannot be undone', () => {
    startSession('task', '/project');
    mockReadFileSync.mockReturnValue('content');
    recordEdit('/project/file.ts');
    recordCommand('npm', ['install']);

    const result = undoAllActions();
    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(2);
  });
});

describe('getRecentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSession();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns parsed sessions from disk', () => {
    const session = {
      id: 'sess1',
      startTime: Date.now(),
      prompt: 'do stuff',
      actions: [],
      projectRoot: '/project',
    };
    mockReaddirSync.mockReturnValue(['sess1.json', 'other.txt']);
    mockReadFileSync.mockReturnValue(JSON.stringify(session));

    const result = getRecentSessions();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sess1');
  });

  it('returns empty array when no history files', () => {
    mockReaddirSync.mockReturnValue([]);
    expect(getRecentSessions()).toEqual([]);
  });

  it('skips corrupted session files', () => {
    mockReaddirSync.mockReturnValue(['bad.json']);
    mockReadFileSync.mockReturnValue('not json');
    expect(getRecentSessions()).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const files = ['a.json', 'b.json', 'c.json'].reverse();
    mockReaddirSync.mockReturnValue(files);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      id: 'x', startTime: 0, prompt: 'p', actions: [], projectRoot: '/',
    }));

    const result = getRecentSessions(2);
    expect(result).toHaveLength(2);
  });
});

describe('getSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns null when session file does not exist', () => {
    expect(getSession('missing-id')).toBeNull();
  });

  it('returns parsed session when file exists', () => {
    const session = { id: 'abc', startTime: 0, prompt: 'test', actions: [], projectRoot: '/' };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(session));

    const result = getSession('abc');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('abc');
  });
});

describe('formatSession', () => {
  it('includes session ID, duration, prompt, and actions', () => {
    const session = {
      id: 'test-session',
      startTime: 1000000,
      endTime: 1005000,
      prompt: 'Fix the bug in the authentication module',
      actions: [
        { id: 'a1', timestamp: 1001000, type: 'edit' as const, path: '/project/auth.ts', undone: false },
        { id: 'a2', timestamp: 1002000, type: 'command' as const, command: 'npm', args: ['test'], undone: true },
      ],
      projectRoot: '/project',
    };

    const output = formatSession(session);
    expect(output).toContain('test-session');
    expect(output).toContain('5s'); // duration
    expect(output).toContain('Fix the bug'); // prompt truncated at 50 chars
    expect(output).toContain('/project/auth.ts');
    expect(output).toContain('npm test');
    expect(output).toContain('↩️'); // undone marker
    expect(output).toContain('✓'); // done marker
  });

  it('shows "ongoing" when session has no endTime', () => {
    const session = {
      id: 'live',
      startTime: Date.now(),
      prompt: 'in progress',
      actions: [],
      projectRoot: '/',
    };
    const output = formatSession(session);
    expect(output).toContain('ongoing');
  });

  it('truncates long prompts at 50 characters', () => {
    const session = {
      id: 'x',
      startTime: 0,
      endTime: 1000,
      prompt: 'A'.repeat(60),
      actions: [],
      projectRoot: '/',
    };
    const output = formatSession(session);
    expect(output).toContain('...');
    expect(output).not.toContain('A'.repeat(60));
  });
});

describe('clearHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('removes all files from history dir', () => {
    mockReaddirSync.mockReturnValue(['sess1.json', 'sess2.json']);
    clearHistory();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
  });

  it('does not throw when history is empty', () => {
    mockReaddirSync.mockReturnValue([]);
    expect(() => clearHistory()).not.toThrow();
  });
});
