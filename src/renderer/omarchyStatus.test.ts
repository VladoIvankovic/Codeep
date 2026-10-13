import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The file's two writes, so a test can read the temporary name it goes
// through and when it is put in place. Both still reach the disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

import { renameSync, writeFileSync } from 'fs';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOmarchyLiveStatus,
  omarchyStatusDir,
  removeStaleStatusFiles,
  setLiveState,
  startOmarchyLiveStatus,
  trackLiveWork,
  type LiveStatusHandle,
  type LiveStatusOptions,
} from './omarchyStatus';

// The functions the two above wrap, for what a test does to the disk itself.
const { writeFileSync: realWriteFileSync, renameSync: realRenameSync } = await vi.importActual<typeof import('fs')>('fs');

const PID = 424242;
let root: string;
let stateDir: string;
let dir: string;
let handle: LiveStatusHandle | null = null;
let on: boolean;
let info: { cwd?: string; provider?: string; model?: string };

/** Options for a writer on an Omarchy desktop, as main.ts starts one. */
const options = (extra: Partial<LiveStatusOptions> = {}): LiveStatusOptions => ({
  kind: 'tui',
  platform: 'linux',
  stateDir,
  dir,
  pid: PID,
  enabled: () => on,
  info: () => info,
  // Nobody else's files are touched unless a test says whose they are.
  isAlive: () => true,
  startedAtOf: () => null,
  ...extra,
});
const start = (extra: Partial<LiveStatusOptions> = {}) => (handle = startOmarchyLiveStatus(options(extra)));
const file = () => join(dir, `${PID}.json`);
const read = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
/** How many times the file has been put in place. */
const puts = () => vi.mocked(renameSync).mock.calls.filter(([, to]) => String(to) === file()).length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-omarchy-status-'));
  stateDir = join(root, 'home', '.local', 'state', 'omarchy', 'current');
  mkdirSync(stateDir, { recursive: true });
  dir = join(root, 'state', 'codeep', 'sessions');
  on = true;
  info = { cwd: '/home/u/Work/x', provider: 'z.ai', model: 'glm-5.3' };
  vi.mocked(writeFileSync).mockReset().mockImplementation(realWriteFileSync);
  vi.mocked(renameSync).mockReset().mockImplementation(realRenameSync);
});

afterEach(() => {
  handle?.stop();
  handle = null;
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('where the file goes', () => {
  it('is under XDG_STATE_HOME when that is set, else ~/.local/state', () => {
    expect(omarchyStatusDir({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe(join('/x/state', 'codeep', 'sessions'));
    expect(omarchyStatusDir({}, '/home/u')).toBe(join('/home/u', '.local', 'state', 'codeep', 'sessions'));
    expect(omarchyStatusDir({ XDG_STATE_HOME: '' }, '/home/u')).toBe(join('/home/u', '.local', 'state', 'codeep', 'sessions'));
  });

  it('ignores a relative XDG_STATE_HOME, as the XDG specification says: it would make a folder in the project', () => {
    for (const relative of ['state', './state', '../state', '~/state']) {
      expect(omarchyStatusDir({ XDG_STATE_HOME: relative }, '/home/u'), relative)
        .toBe(join('/home/u', '.local', 'state', 'codeep', 'sessions'));
    }
  });
});

describe('starting', () => {
  it('writes the file at once, idle, in exactly the documented shape', () => {
    start();
    expect(Object.keys(read())).toEqual([
      'schemaVersion', 'pid', 'kind', 'startedAt', 'updatedAt', 'cwd', 'project', 'state', 'task', 'provider', 'model',
    ]);
    expect(read()).toEqual({
      schemaVersion: 1,
      pid: PID,
      kind: 'tui',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      cwd: '/home/u/Work/x',
      project: 'x',
      state: 'idle',
      task: null,
      provider: 'z.ai',
      model: 'glm-5.3',
    });
  });

  it('says acp for an ACP server', () => {
    start({ kind: 'acp' });
    expect(read().kind).toBe('acp');
  });

  it('does nothing at all anywhere but Omarchy', () => {
    expect(startOmarchyLiveStatus(options({ platform: 'darwin' }))).toBeNull();
    expect(startOmarchyLiveStatus(options({ stateDir: join(root, 'no-omarchy-here') }))).toBeNull();
    expect(existsSync(dir)).toBe(false);
    // And what the process calls is nothing.
    expect(() => setLiveState('working', 'a task')).not.toThrow();
    expect(() => applyOmarchyLiveStatus(false)).not.toThrow();
  });

  it('writes nothing with the setting off', () => {
    on = false;
    start();
    expect(existsSync(dir)).toBe(false);
  });

  it('is replaced by the next one started in the same process', () => {
    const first = start();
    const second = startOmarchyLiveStatus(options({ kind: 'acp' }));
    try {
      expect(read().kind).toBe('acp');
      expect(first).not.toBe(second);
    } finally {
      second?.stop();
    }
  });
});

// POSIX modes; Windows has none of these bits to check.
describe.skipIf(process.platform === 'win32')('who may read it', () => {
  let umaskBefore: number;
  beforeEach(() => { umaskBefore = process.umask(0o022); });
  afterEach(() => { process.umask(umaskBefore); });
  const mode = (path: string) => statSync(path).mode & 0o777;

  it('is 0600 in a directory only its owner may enter — and only that directory', () => {
    start();
    expect(mode(file())).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    // What is above it is made the way anything else makes it: a recursive
    // mkdir with a mode would have made ~/.local/state 0700 too.
    expect(mode(join(root, 'state', 'codeep'))).toBe(0o755);
    expect(mode(join(root, 'state'))).toBe(0o755);
  });

  it('leaves a directory that is already there as it was', () => {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    start();
    expect(mode(dir)).toBe(0o755);
    expect(mode(file())).toBe(0o600);
  });
});

describe('putting it in place', () => {
  it('writes beside it under a name no `*.json` scan lists, then renames it over', () => {
    start();
    const writes = vi.mocked(writeFileSync).mock.calls.filter(([path]) => String(path).startsWith(dir));
    expect(writes).toHaveLength(1);
    const tmp = String(writes[0][0]);
    expect(tmp).toMatch(/[/\\]\.424242\.[0-9a-f]{12}\.tmp$/);
    expect(tmp.endsWith('.json')).toBe(false);
    expect(vi.mocked(renameSync).mock.calls.filter(([from, to]) => String(from) === tmp && String(to) === file())).toHaveLength(1);
    expect(writes[0][2]).toEqual({ mode: 0o600 });
    // Nothing but the file is left in the directory.
    expect(readdirSync(dir)).toEqual([`${PID}.json`]);
  });

  it('is never seen half written', () => {
    // The rename is the only moment the file name takes its content: until
    // it, the file is not there; after it, it parses.
    let seenBeforeRename: boolean | null = null;
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      seenBeforeRename = existsSync(file());
      expect(JSON.parse(readFileSync(String(from), 'utf8')).state).toBe('idle');
      return realRenameSync(from, to);
    });
    start();
    expect(seenBeforeRename).toBe(false);
    expect(read().state).toBe('idle');
  });

  it('removes its temporary file and goes on when the rename fails', () => {
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('EXDEV'); });
    expect(() => start()).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('saying what Codeep is doing', () => {
  it('shows the state, with the task\'s label while it is anything but idle', () => {
    vi.useFakeTimers();
    start();
    handle!.set('working', 'fix the login bug');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'working', task: 'fix the login bug' });
    handle!.set('approval', 'fix the login bug');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'approval', task: 'fix the login bug' });
    handle!.set('question', 'fix the login bug');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'question', task: 'fix the login bug' });
    handle!.set('idle', 'fix the login bug');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'idle', task: null });
  });

  it('shows the label a toast would, and never a path, a file name or a control character', () => {
    vi.useFakeTimers();
    start();
    handle!.set('working', 'edit src/secret/keys.ts and\n\x1b[31m~/.ssh/id_rsa\x1b[0m then ‮fix .env now');
    vi.advanceTimersByTime(1000);
    expect(read().task).toBe('edit and then fix now');
  });

  it('says nothing about a task that is all path', () => {
    vi.useFakeTimers();
    start();
    handle!.set('working', '/etc/passwd');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'working', task: null });
  });

  it('reads the provider and the model at the time of each write', () => {
    vi.useFakeTimers();
    start();
    info = { cwd: '/home/u/Work/x', provider: 'anthropic', model: 'claude-opus-5-5' };
    handle!.set('working', 'a');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('names the project from the directory, cleaned, and the directory as it is', () => {
    start({ info: () => ({ cwd: '/home/u/Work/my\nproj\x1b[31m‮ect', provider: 'z.ai', model: 'm' }) });
    expect(read().project).toBe('my project');
    expect(read().cwd).toBe('/home/u/Work/my\nproj\x1b[31m‮ect');
    handle!.stop();
    start({ info: () => ({ cwd: '/', provider: 'z.ai', model: 'm' }) });
    expect(read().project).toBe('/');
  });

  it('uses the directory of the prompt a server is running, while it runs', () => {
    vi.useFakeTimers();
    start({ kind: 'acp' });
    handle!.set('working', 'a', { cwd: '/home/u/Work/other' });
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ cwd: '/home/u/Work/other', project: 'other' });
  });

  it('leaves a state alone that is no longer the one it was asked about', () => {
    vi.useFakeTimers();
    start();
    handle!.set('approval', 'a');
    handle!.set('idle', null);
    handle!.set('working', 'a', { onlyFrom: 'approval' });
    vi.advanceTimersByTime(1000);
    expect(read().state).toBe('idle');
    expect(handle!.current()).toEqual({ state: 'idle', task: null });
    handle!.set('question', 'a');
    handle!.set('idle', null, { onlyFrom: 'question' });
    expect(handle!.current().state).toBe('idle');
  });

  it('is reached through the process\'s one writer', () => {
    vi.useFakeTimers();
    start();
    setLiveState('working', 'from outside');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'working', task: 'from outside' });
  });
});

describe('at most one write a second', () => {
  beforeEach(() => vi.useFakeTimers());

  it('writes the first change at once, and a burst after it as one write, with the last state', () => {
    start();
    expect(puts()).toBe(1);
    handle!.set('working', 'a');
    handle!.set('approval', 'a');
    handle!.set('working', 'a');
    handle!.set('question', 'a');
    handle!.set('idle', null);
    // The start wrote a second ago or less: the changes wait for the second.
    expect(puts()).toBe(1);
    vi.advanceTimersByTime(999);
    expect(puts()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(puts()).toBe(2);
    expect(read()).toMatchObject({ state: 'idle', task: null });
    vi.advanceTimersByTime(10_000);
    expect(puts()).toBe(2);
  });

  it('writes at once again when the second is up', () => {
    start();
    vi.advanceTimersByTime(5000);
    handle!.set('working', 'a');
    expect(puts()).toBe(2);
    expect(read().state).toBe('working');
  });

  it('never writes more than once in any second, however fast it is told', () => {
    start();
    const stamps: number[] = [];
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(to) === file()) stamps.push(Date.now());
      return realRenameSync(from, to);
    });
    const states = ['working', 'approval', 'working', 'question', 'idle'] as const;
    for (let i = 0; i < 200; i++) {
      handle!.set(states[i % states.length], 'task');
      vi.advanceTimersByTime(25);
    }
    vi.advanceTimersByTime(2000);
    expect(stamps.length).toBeGreaterThan(3);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(1000);
    // The last thing said is what the file says.
    expect(read().state).toBe(handle!.current().state);
  });

  it('writes nothing for a state that is the one it was', () => {
    start();
    vi.advanceTimersByTime(5000);
    handle!.set('idle', null);
    handle!.set('working', 'a');
    vi.advanceTimersByTime(5000);
    const before = puts();
    handle!.set('working', 'a');
    vi.advanceTimersByTime(5000);
    expect(puts()).toBe(before);
  });

  it('does not keep the process alive for a write that waits', () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      start();
      handle!.set('working', 'a');
      const timer = spy.mock.results[0].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the /settings switch', () => {
  it('Off takes the file away at once, even with a write waiting, and keeps it away', () => {
    vi.useFakeTimers();
    start();
    handle!.set('working', 'a');
    expect(existsSync(file())).toBe(true);
    on = false;
    applyOmarchyLiveStatus(false);
    expect(existsSync(file())).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(existsSync(file())).toBe(false);
    handle!.set('approval', 'a');
    vi.advanceTimersByTime(5000);
    expect(existsSync(file())).toBe(false);
  });

  it('On puts it back, with what Codeep is doing now', () => {
    vi.useFakeTimers();
    start();
    on = false;
    applyOmarchyLiveStatus(false);
    handle!.set('working', 'a task');
    on = true;
    applyOmarchyLiveStatus(true);
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'working', task: 'a task' });
  });

  it('turned off in config.json by hand, takes the file away at the next write', () => {
    vi.useFakeTimers();
    start();
    on = false;
    handle!.set('working', 'a');
    vi.advanceTimersByTime(1000);
    expect(existsSync(file())).toBe(false);
  });

  it('is decided at every write: a machine that stopped being Omarchy gets no file', () => {
    vi.useFakeTimers();
    start();
    rmSync(stateDir, { recursive: true });
    handle!.set('working', 'a');
    vi.advanceTimersByTime(1000);
    expect(read().state).toBe('idle');
  });
});

describe('when the process ends', () => {
  const exitListeners = () => process.listeners('exit');

  it('removes the file at once, and a write that was waiting never comes', () => {
    vi.useFakeTimers();
    const before = exitListeners();
    start();
    const added = exitListeners().filter(listener => !before.includes(listener));
    expect(added).toHaveLength(1);
    handle!.set('working', 'a');
    expect(existsSync(file())).toBe(true);
    // What 'exit' calls, synchronously. Not process.emit('exit'), which would
    // also run the test runner's own listeners.
    added[0](0);
    expect(existsSync(file())).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(existsSync(file())).toBe(false);
  });

  it('is not listening for it once stopped, and the file is gone', () => {
    const before = exitListeners().length;
    start();
    expect(exitListeners().length).toBe(before + 1);
    handle!.stop();
    expect(exitListeners().length).toBe(before);
    expect(existsSync(file())).toBe(false);
  });

  it('leaves nothing but its own file to remove', () => {
    start();
    realWriteFileSync(join(dir, '999.json'), '{}');
    handle!.stop();
    expect(readdirSync(dir)).toEqual(['999.json']);
  });
});

describe('files of processes that are gone', () => {
  const stamp = (pid: number, startedAt: string, name = `${pid}.json`) =>
    realWriteFileSync(join(dir, name), JSON.stringify({ schemaVersion: 1, pid, kind: 'tui', startedAt, state: 'working' }));
  const ALIVE = new Set([222, 666, 777]);
  const alive = (pid: number) => ALIVE.has(pid);
  /** The process 666 began in 2026-10-10, after the file that names it; 777 before. */
  const startedAtOf = (pid: number) => (pid === 666 ? Date.parse('2026-10-10T00:00:00Z') : pid === 777 ? Date.parse('2026-10-01T00:00:00Z') : null);
  /** 666 is a text editor that was handed the number; 777 is a Codeep. */
  const cmdlineOf = (pid: number) => (pid === 666 ? 'vim notes.txt' : pid === 777 ? '/usr/bin/node /home/u/.local/share/mise/installs/codeep/dist/renderer/main.js' : null);

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    stamp(111, '2026-10-01T00:00:00Z');
    stamp(222, '2026-10-01T00:00:00Z');
    stamp(666, '2026-10-02T00:00:00Z');
    stamp(777, '2026-10-02T00:00:00Z');
    realWriteFileSync(join(dir, '.333.aaaaaaaaaaaa.tmp'), '{');
    realWriteFileSync(join(dir, '.222.bbbbbbbbbbbb.tmp'), '{');
    // Not Codeep's, or not a status file at all: none of these is removed.
    for (const name of ['notes.txt', 'README', 'abc.json', '4242x.json', '0.json', '12.json.bak', '.444.json', '.555.cccccccccccc.json']) {
      realWriteFileSync(join(dir, name), 'not ours');
    }
  });

  it('removes the files of dead pids at the first write, and only those', () => {
    start({ isAlive: alive, startedAtOf, cmdlineOf });
    expect(readdirSync(dir).sort()).toEqual([
      '.222.bbbbbbbbbbbb.tmp', '.444.json', '.555.cccccccccccc.json', '0.json', '12.json.bak', '222.json', '4242x.json',
      `${PID}.json`, '777.json', 'README', 'abc.json', 'notes.txt',
    ].sort());
  });

  it('removes the file of a pid that is alive but began after the file did — another process\'s number', () => {
    start({ isAlive: alive, startedAtOf, cmdlineOf });
    expect(existsSync(join(dir, '666.json'))).toBe(false);
    expect(existsSync(join(dir, '777.json'))).toBe(true);
  });

  it('keeps the file of a live Codeep whose clock was stepped, which makes it look newer than its own file', () => {
    // 777 is a Codeep, and its start reads 9 days after what its file says —
    // the wall clock jumped (NTP after an offline boot) and /proc's start time
    // moved with it. Only a process that is plainly something else loses its file.
    stamp(777, '2026-09-20T00:00:00Z');
    start({
      isAlive: alive,
      startedAtOf: pid => (pid === 777 ? Date.parse('2026-10-01T00:00:00Z') : null),
      cmdlineOf,
    });
    expect(existsSync(join(dir, '777.json'))).toBe(true);
  });

  it('keeps it too when the command line of the late process cannot be read', () => {
    start({ isAlive: alive, startedAtOf, cmdlineOf: () => null });
    expect(existsSync(join(dir, '666.json'))).toBe(true);
  });

  it('tolerates a start that is a little after the file\'s own', () => {
    stamp(777, '2026-09-30T23:59:59Z');
    start({ isAlive: alive, startedAtOf: pid => (pid === 777 ? Date.parse('2026-10-01T00:00:00Z') : null) });
    expect(existsSync(join(dir, '777.json'))).toBe(true);
  });

  it('keeps a file of a live pid whose start cannot be told, and one it cannot read', () => {
    realWriteFileSync(join(dir, '222.json'), '{ not json');
    start({ isAlive: alive, startedAtOf: () => null });
    expect(existsSync(join(dir, '222.json'))).toBe(true);
    expect(existsSync(join(dir, '666.json'))).toBe(true);
  });

  it('removes an unreadable file of a pid that is gone, as it is the dead pid that decides', () => {
    realWriteFileSync(join(dir, '111.json'), '{ not json');
    start({ isAlive: alive, startedAtOf, cmdlineOf });
    expect(existsSync(join(dir, '111.json'))).toBe(false);
  });

  it('never removes a symlink, or a directory, whatever it is called', () => {
    const target = join(root, 'precious');
    realWriteFileSync(target, 'precious');
    symlinkSync(target, join(dir, '888.json'));
    mkdirSync(join(dir, '999.json'));
    start({ isAlive: alive, startedAtOf, cmdlineOf });
    expect(readFileSync(target, 'utf8')).toBe('precious');
    expect(existsSync(join(dir, '888.json'))).toBe(true);
    expect(statSync(join(dir, '999.json')).isDirectory()).toBe(true);
  });

  it('leaves them alone while the setting is off, and clears them when it is turned on', () => {
    vi.useFakeTimers();
    on = false;
    start({ isAlive: alive, startedAtOf, cmdlineOf });
    expect(existsSync(join(dir, '111.json'))).toBe(true);
    on = true;
    applyOmarchyLiveStatus(true);
    vi.advanceTimersByTime(1000);
    expect(existsSync(join(dir, '111.json'))).toBe(false);
  });

  it('reports how many it removed, and never throws for a directory that is not there', () => {
    expect(removeStaleStatusFiles(dir, { pid: PID, isAlive: alive, startedAtOf, cmdlineOf })).toBe(3);
    expect(removeStaleStatusFiles(join(root, 'nowhere'), { pid: PID, isAlive: alive, startedAtOf, cmdlineOf })).toBe(0);
  });

  it('never removes the file of its own process', () => {
    stamp(PID, '2000-01-01T00:00:00Z');
    expect(removeStaleStatusFiles(dir, { pid: PID, isAlive: () => false, startedAtOf, cmdlineOf })).toBeGreaterThan(0);
    expect(existsSync(join(dir, `${PID}.json`))).toBe(true);
  });
});

describe('files of processes that are gone — against the real system', () => {
  it('removes the file of a process that has ended, and keeps a live one\'s', () => {
    mkdirSync(dir, { recursive: true });
    const ended = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;
    const gone = join(dir, `${ended}.json`);
    const mine = join(dir, `${process.ppid}.json`);
    realWriteFileSync(gone, JSON.stringify({ startedAt: new Date().toISOString() }));
    // A live process that began long before this file says it did.
    realWriteFileSync(mine, JSON.stringify({ startedAt: '2999-01-01T00:00:00Z' }));
    const { isAlive: _a, startedAtOf: _s, ...realOptions } = options();
    handle = startOmarchyLiveStatus(realOptions);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  // The start of a process, from /proc/<pid>/stat and /proc/stat: only
  // there. The file says it was begun a minute ago for the process that began
  // just now — another process's number — and a minute from now for the one
  // that is the same process as it names.
  it.skipIf(process.platform !== 'linux')('tells a live process that began after its file did from one that began before', async () => {
    mkdirSync(dir, { recursive: true });
    const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }));
    try {
      await vi.waitFor(() => expect(children.every(child => (child.pid ?? 0) > 0)).toBe(true));
      const [reused, genuine] = children.map(child => join(dir, `${child.pid}.json`));
      realWriteFileSync(reused, JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString() }));
      realWriteFileSync(genuine, JSON.stringify({ startedAt: new Date(Date.now() + 60_000).toISOString() }));
      const { isAlive: _a, startedAtOf: _s, ...realOptions } = options();
      handle = startOmarchyLiveStatus(realOptions);
      expect(existsSync(reused)).toBe(false);
      expect(existsSync(genuine)).toBe(true);
    } finally {
      for (const child of children) child.kill();
    }
  });
});

describe('an ACP server', () => {
  it('is working while any prompt runs, and idle when the last has ended', () => {
    vi.useFakeTimers();
    start({ kind: 'acp' });
    const first = trackLiveWork('first question', '/home/u/Work/a');
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ kind: 'acp', state: 'working', task: 'first question', cwd: '/home/u/Work/a' });
    const second = trackLiveWork('second', '/home/u/Work/b');
    first();
    vi.advanceTimersByTime(1000);
    expect(read().state).toBe('working');
    // Ending one twice does not end the other.
    first();
    vi.advanceTimersByTime(1000);
    expect(read().state).toBe('working');
    second();
    vi.advanceTimersByTime(1000);
    expect(read()).toMatchObject({ state: 'idle', task: null });
  });

  it('cleans what the editor typed like any other label', () => {
    vi.useFakeTimers();
    start({ kind: 'acp' });
    const end = trackLiveWork('look at /home/u/Work/a/secret.ts please', undefined);
    vi.advanceTimersByTime(1000);
    expect(read().task).toBe('look at please');
    end();
  });
});

describe('when it cannot be written', () => {
  it('never throws, for a directory that is a file or a state that cannot be read', () => {
    mkdirSync(join(root, 'state'), { recursive: true });
    realWriteFileSync(join(root, 'state', 'codeep'), 'a file where the directory would go');
    expect(() => start()).not.toThrow();
    expect(() => handle!.set('working', 'a')).not.toThrow();
    expect(() => handle!.flush()).not.toThrow();
  });

  it('writes with the process\'s directory when the caller\'s info throws', () => {
    start({ info: () => { throw new Error('no project yet'); } });
    expect(read()).toMatchObject({ cwd: process.cwd(), provider: '', model: '' });
  });
});
