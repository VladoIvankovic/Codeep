import { describe, it, expect } from 'vitest';
import { chmodSync, constants, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_PROMPT_FILE_BYTES,
  isLauncherTempFile,
  readLaunchPromptFile,
  type PromptFileFs,
  type PromptFileStat,
} from './promptFile';

// The refusals are driven through an injected `fs`, so each is one line of
// state and nothing here touches a disk; the last block does it for real.

const ME = 1000;
const SECRET = 'rotate the production signing key and tell nobody';

const stat = (over: Partial<PromptFileStat> = {}): PromptFileStat => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: ME,
  mode: 0o100600,
  size: 12,
  dev: 7,
  ino: 4242,
  ...over,
});
const symlink = () => stat({ isFile: () => false, isSymbolicLink: () => true });
const fifo = () => stat({ isFile: () => false });
const errno = (code: string) => Object.assign(new Error(`${code}: /secret/path/${SECRET}`), { code });

interface Scene {
  /** What lstat answers the first time, and what the file system says about the path at removal. */
  lstat?: PromptFileStat | Error;
  lstatAtRemoval?: PromptFileStat | Error;
  fstat?: PromptFileStat | Error;
  open?: Error;
  bytes?: Buffer;
  /** Throws from read. */
  read?: Error;
  unlink?: Error;
}

function sceneFs(scene: Scene) {
  const log: string[] = [];
  const unlinked: string[] = [];
  let lstats = 0;
  let served = 0;
  const bytes = scene.bytes ?? Buffer.from('fix the login bug\n');
  const fs: PromptFileFs = {
    lstat(path) {
      log.push(`lstat ${path}`);
      const answer = ++lstats === 1 ? (scene.lstat ?? stat()) : (scene.lstatAtRemoval ?? scene.lstat ?? stat());
      if (answer instanceof Error) throw answer;
      return answer;
    },
    open(path, flags) {
      log.push(`open ${path} flags=${flags}`);
      if (scene.open) throw scene.open;
      return 9;
    },
    fstat(fd) {
      log.push(`fstat ${fd}`);
      const answer = scene.fstat ?? scene.lstat ?? stat();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    read(_fd, buffer, offset, length) {
      log.push('read');
      if (scene.read) throw scene.read;
      const n = Math.min(length, bytes.length - served, 4096);
      bytes.copy(buffer, offset, served, served + n);
      served += n;
      return n;
    },
    close(fd) { log.push(`close ${fd}`); },
    unlink(path) {
      log.push(`unlink ${path}`);
      if (scene.unlink) throw scene.unlink;
      unlinked.push(path);
    },
  };
  return { fs, log, unlinked };
}

const OWN = '/run/user/1000/codeep-prompt-AbC123xyz0';
const take = (path: string, scene: Scene = {}, uid: number | null = ME) => {
  const { fs, log, unlinked } = sceneFs(scene);
  return { result: readLaunchPromptFile(path, { fs, uid }), log, unlinked };
};
const refusal = (r: ReturnType<typeof readLaunchPromptFile>) => {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.message;
};

describe('readLaunchPromptFile — a good file', () => {
  it('returns the text, opened without following a link, and removes the launcher\'s own file', () => {
    const { result, log, unlinked } = take(OWN);
    expect(result).toEqual({ ok: true, prompt: 'fix the login bug' });
    expect(unlinked).toEqual([OWN]);
    const open = log.find(l => l.startsWith('open '))!;
    const flags = Number(/flags=(\d+)/.exec(open)![1]);
    if (constants.O_NOFOLLOW !== undefined) expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    if (constants.O_NONBLOCK !== undefined) expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    // Looked at by name, opened, looked at again through the descriptor, read, closed — then removed.
    expect(log.map(l => l.split(' ')[0])).toEqual(['lstat', 'open', 'fstat', 'read', 'read', 'close', 'lstat', 'unlink']);
  });

  it('strips a BOM and trims, and keeps what is inside', () => {
    const body = '\uFEFF  \n\nadd a README\r\n\r\nwith a "table" and $HOME\n\n';
    const { result } = take(OWN, { bytes: Buffer.from(body, 'utf8') });
    expect(result).toEqual({ ok: true, prompt: 'add a README\r\n\r\nwith a "table" and $HOME' });
  });

  it('takes multi-byte text and a prompt that starts with a dash or a slash as they are', () => {
    expect(take(OWN, { bytes: Buffer.from('-v čćžšđ 日本語 🚀\n') }).result).toEqual({ ok: true, prompt: '-v čćžšđ 日本語 🚀' });
    expect(take(OWN, { bytes: Buffer.from('/commit everything\n') }).result).toEqual({ ok: true, prompt: '/commit everything' });
  });

  it('takes exactly 256 KiB and not a byte more', () => {
    expect(MAX_PROMPT_FILE_BYTES).toBe(262144);
    const edge = Buffer.alloc(MAX_PROMPT_FILE_BYTES, 'a');
    const ok = take(OWN, { lstat: stat({ size: edge.length }), bytes: edge });
    expect(ok.result.ok).toBe(true);
    const over = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1, 'a');
    const bad = take(OWN, { lstat: stat({ size: over.length }), bytes: over });
    expect(refusal(bad.result)).toMatch(/larger than 256 KiB/);
    expect(bad.log.some(l => l.startsWith('open '))).toBe(false);
  });

  it('allows a file others may read, only not write', () => {
    expect(take(OWN, { lstat: stat({ mode: 0o100644 }) }).result.ok).toBe(true);
    expect(take(OWN, { lstat: stat({ mode: 0o100400 }) }).result.ok).toBe(true);
  });
});

describe('readLaunchPromptFile — what it refuses, and that it touches nothing then', () => {
  it('a path that is empty, relative, ~-relative or holds a NUL, before the file system is asked', () => {
    for (const path of ['', 'prompt.txt', './codeep-prompt-AbC123xyz0', '../codeep-prompt-AbC123xyz0', '~/codeep-prompt-AbC123xyz0', '-v', `/run/user/1000/codeep-prompt-AbC123\0xyz0`]) {
      const { result, log, unlinked } = take(path);
      expect(refusal(result), JSON.stringify(path)).toMatch(/prompt file path/);
      expect(log, JSON.stringify(path)).toEqual([]);
      expect(unlinked).toEqual([]);
    }
    expect(refusal(take('').result)).toBe('the prompt file path is empty');
    expect(refusal(take('relative/codeep-prompt-AbC123xyz0').result)).toMatch(/must be absolute/);
    expect(refusal(take('~/x').result)).toMatch(/no ~/);
  });

  it('a file that is not there, or cannot be looked at, says the code and nothing else', () => {
    const gone = take(OWN, { lstat: errno('ENOENT') });
    expect(refusal(gone.result)).toBe('cannot read the prompt file (ENOENT)');
    expect(refusal(take(OWN, { lstat: errno('EACCES') }).result)).toBe('cannot read the prompt file (EACCES)');
    // An error that carries no usable code is "error", not its text.
    expect(refusal(take(OWN, { lstat: new Error(SECRET) }).result)).toBe('cannot read the prompt file (error)');
    expect(gone.log).toEqual([`lstat ${OWN}`]);
  });

  it('a symbolic link, which is never opened and never removed', () => {
    const { result, log, unlinked } = take(OWN, { lstat: symlink() });
    expect(refusal(result)).toMatch(/symbolic link/);
    expect(log.some(l => l.startsWith('open '))).toBe(false);
    expect(unlinked).toEqual([]);
  });

  it('anything that is not a regular file: a directory, a FIFO, a device', () => {
    const { result, log, unlinked } = take(OWN, { lstat: fifo() });
    expect(refusal(result)).toMatch(/not a regular file/);
    expect(log.some(l => l.startsWith('open '))).toBe(false);
    expect(unlinked).toEqual([]);
  });

  it('a file somebody else owns, root\'s included', () => {
    for (const uid of [0, ME + 1]) {
      const { result, unlinked, log } = take(OWN, { lstat: stat({ uid }) });
      expect(refusal(result)).toMatch(/not owned by you/);
      expect(unlinked).toEqual([]);
      expect(log.some(l => l.startsWith('open '))).toBe(false);
    }
  });

  it('a file its group or others can write, in each way', () => {
    for (const mode of [0o100620, 0o100602, 0o100660, 0o100666, 0o100777, 0o100622]) {
      const { result, unlinked } = take(OWN, { lstat: stat({ mode }) });
      expect(refusal(result), mode.toString(8)).toMatch(/written by its group or by others/);
      expect(unlinked).toEqual([]);
    }
  });

  it('skips the owner and mode checks where there is no uid (Windows), and no others', () => {
    const odd = stat({ uid: 0, mode: 0o100666 });
    expect(take(OWN, { lstat: odd }, null).result.ok).toBe(true);
    expect(refusal(take(OWN, { lstat: stat({ size: MAX_PROMPT_FILE_BYTES + 1 }) }, null).result)).toMatch(/256 KiB/);
    expect(refusal(take(OWN, { lstat: symlink() }, null).result)).toMatch(/symbolic link/);
  });

  it('a file that is larger than 256 KiB by its size', () => {
    const { result, unlinked } = take(OWN, { lstat: stat({ size: MAX_PROMPT_FILE_BYTES + 1 }) });
    expect(refusal(result)).toMatch(/larger than 256 KiB/);
    expect(unlinked).toEqual([]);
  });

  it('a file that grows after it was measured, caught by reading one byte past the limit', () => {
    const grown = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 5000, 'a');
    const { result, unlinked, log } = take(OWN, { lstat: stat({ size: 10 }), fstat: stat({ size: 10 }), bytes: grown });
    expect(refusal(result)).toMatch(/larger than 256 KiB/);
    expect(unlinked).toEqual([]);
    expect(log.some(l => l.startsWith('close '))).toBe(true);
  });

  it('a path that became a link between the look and the open (ELOOP)', () => {
    const { result, log, unlinked } = take(OWN, { open: errno('ELOOP') });
    expect(refusal(result)).toBe('cannot open the prompt file (ELOOP)');
    expect(log.some(l => l === 'read')).toBe(false);
    expect(unlinked).toEqual([]);
  });

  it('a different file under the descriptor than the one that was looked at', () => {
    const { result, unlinked, log } = take(OWN, { lstat: stat({ ino: 1 }), fstat: stat({ ino: 2 }) });
    expect(refusal(result)).toMatch(/changed while it was being opened/);
    expect(unlinked).toEqual([]);
    expect(log.filter(l => l.startsWith('close '))).toEqual(['close 9']);
    expect(log).not.toContain('read');
    // The device counts too.
    expect(refusal(take(OWN, { lstat: stat({ dev: 1 }), fstat: stat({ dev: 3 }) }).result)).toMatch(/changed/);
  });

  it('the same file turned into something worse before it was read', () => {
    // Same dev and inode, but by the descriptor it is group-writable, or not mine, or a pipe.
    expect(refusal(take(OWN, { fstat: stat({ mode: 0o100666 }) }).result)).toMatch(/written by its group/);
    expect(refusal(take(OWN, { fstat: stat({ uid: 0 }) }).result)).toMatch(/not owned by you/);
    expect(refusal(take(OWN, { fstat: fifo() }).result)).toMatch(/not a regular file/);
    expect(refusal(take(OWN, { fstat: stat({ size: MAX_PROMPT_FILE_BYTES + 1 }) }).result)).toMatch(/256 KiB/);
    for (const scene of [{ fstat: stat({ mode: 0o100666 }) }, { fstat: fifo() }]) {
      const { unlinked, log } = take(OWN, scene);
      expect(unlinked).toEqual([]);
      expect(log.filter(l => l.startsWith('close '))).toEqual(['close 9']);
    }
  });

  it('an error while reading, and a descriptor that is closed all the same', () => {
    const { result, log, unlinked } = take(OWN, { read: errno('EIO') });
    expect(refusal(result)).toBe('cannot read the prompt file (EIO)');
    expect(log).toContain('close 9');
    expect(unlinked).toEqual([]);
    expect(refusal(take(OWN, { fstat: errno('EBADF') }).result)).toBe('cannot read the prompt file (EBADF)');
  });

  it('a file that holds no prompt: empty, white space, a BOM — removed, and said so', () => {
    for (const body of ['', '   \n\t\n', '\uFEFF', '\uFEFF\n  ']) {
      const { result, unlinked } = take(OWN, { bytes: Buffer.from(body, 'utf8'), lstat: stat({ size: body.length }) });
      expect(refusal(result), JSON.stringify(body)).toBe('the prompt file is empty');
      // It was read, and it is the launcher's own: it goes.
      expect(unlinked, JSON.stringify(body)).toEqual([OWN]);
    }
  });

  it('bytes that are not UTF-8 text, which are left where they are', () => {
    const { result, unlinked } = take(OWN, { bytes: Buffer.concat([Buffer.from('ok '), Buffer.from([0xff, 0xfe, 0xc3, 0x28])]) });
    expect(refusal(result)).toBe('the prompt file is not valid UTF-8 text');
    expect(unlinked).toEqual([]);
  });
});

describe('readLaunchPromptFile — which file it removes', () => {
  it('only a launcher\'s own temp file, by its name', () => {
    const removed = [
      '/run/user/1000/codeep-prompt-AbC123xyz0',
      '/tmp/codeep-prompt-123456',
      '/tmp/codeep-prompt-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
    ];
    for (const path of removed) {
      expect(isLauncherTempFile(path), path).toBe(true);
      expect(take(path).unlinked, path).toEqual([path]);
    }
    const left = [
      '/home/u/prompt.txt',
      '/home/u/codeep-prompt',
      '/home/u/codeep-prompt-',
      '/home/u/codeep-prompt-abc',          // under six characters
      '/home/u/codeep-prompt-abcde',
      '/home/u/codeep-prompt-abc123.txt',   // an extension
      '/home/u/codeep-prompt-abc_123',
      '/home/u/codeep-prompt-abc-123',
      '/home/u/xcodeep-prompt-abc123',      // a prefix
      '/home/u/Codeep-prompt-abc123',       // the case
      '/home/u/codeep-prompt-abc123/prompt', // the name is the last part only
      '/home/u/codeep-prompt-abcé123',
    ];
    for (const path of left) {
      expect(isLauncherTempFile(path), path).toBe(false);
      const { result, unlinked } = take(path);
      // Read all the same, and left alone.
      expect(result.ok, path).toBe(true);
      expect(unlinked, path).toEqual([]);
    }
  });

  it('a failure to remove it is not an error', () => {
    const { result, unlinked } = take(OWN, { unlink: errno('EACCES') });
    expect(result).toEqual({ ok: true, prompt: 'fix the login bug' });
    expect(unlinked).toEqual([]);
    // Nor is a file that is already gone by then.
    expect(take(OWN, { lstatAtRemoval: errno('ENOENT') }).result.ok).toBe(true);
  });

  it('not whatever is at the path by then: another file, or a link', () => {
    const swapped = take(OWN, { lstat: stat({ ino: 1 }), fstat: stat({ ino: 1 }), lstatAtRemoval: stat({ ino: 2 }) });
    expect(swapped.result.ok).toBe(true);
    expect(swapped.unlinked).toEqual([]);
    const linked = take(OWN, { lstatAtRemoval: symlink() });
    expect(linked.result.ok).toBe(true);
    expect(linked.unlinked).toEqual([]);
  });
});

describe('readLaunchPromptFile — what a message may say', () => {
  it('never the prompt, and never the path', () => {
    const hostile = `/run/user/1000/codeep-prompt-AbC123xyz0`;
    const withSecret = Buffer.from(`${SECRET}\n`);
    const messages: string[] = [];
    const note = (r: ReturnType<typeof readLaunchPromptFile>) => { if (!r.ok) messages.push(r.message); };

    // A prompt where the path should be, as a launcher with a bug would pass it.
    for (const path of [SECRET, `~/${SECRET}`, `${SECRET}\0`, `/${SECRET.replace(/ /g, '_')}`]) {
      note(take(path, { lstat: errno('ENOENT') }).result);
    }
    // Every refusal that has read, or looked at, the content.
    note(take(hostile, { lstat: symlink(), bytes: withSecret }).result);
    note(take(hostile, { lstat: fifo(), bytes: withSecret }).result);
    note(take(hostile, { lstat: stat({ uid: 0 }), bytes: withSecret }).result);
    note(take(hostile, { lstat: stat({ mode: 0o100666 }), bytes: withSecret }).result);
    note(take(hostile, { lstat: stat({ size: MAX_PROMPT_FILE_BYTES + 1 }), bytes: withSecret }).result);
    note(take(hostile, { bytes: Buffer.concat([withSecret, Buffer.from([0xff])]) }).result);
    note(take(hostile, { bytes: Buffer.concat([Buffer.from(SECRET), Buffer.alloc(MAX_PROMPT_FILE_BYTES)]) }).result);
    note(take(hostile, { read: errno('EIO') }).result);
    note(take(hostile, { open: errno('ELOOP') }).result);
    note(take(hostile, { lstat: stat({ ino: 1 }), fstat: stat({ ino: 2 }), bytes: withSecret }).result);
    note(take(hostile, { bytes: Buffer.from('  \n') }).result);

    expect(messages.length).toBeGreaterThanOrEqual(15);
    for (const message of messages) {
      expect(message, message).not.toContain(SECRET);
      expect(message, message).not.toContain('production');
      expect(message, message).not.toContain('/run/user');
      expect(message, message).not.toContain('codeep-prompt');
      expect(message, message).not.toContain('/secret/path');
      expect(message.length).toBeLessThan(100);
    }
  });
});

describe.skipIf(process.platform === 'win32')('readLaunchPromptFile — on a real file system', () => {
  function inTempDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'codeep-promptfile-'));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const put = (path: string, text: string, mode = 0o600) => {
    writeFileSync(path, text, { mode });
    chmodSync(path, mode); // the umask does not get a say
  };

  it('round trip: reads the prompt, then the launcher\'s own file is gone', () => {
    inTempDir(dir => {
      const path = join(dir, 'codeep-prompt-AbC123xyz0');
      put(path, `\uFEFF${SECRET}\nsecond line with "quotes" and $HOME and \`ticks\`\n`);
      const r = readLaunchPromptFile(path);
      expect(r).toEqual({ ok: true, prompt: `${SECRET}\nsecond line with "quotes" and $HOME and \`ticks\`` });
      expect(existsSync(path)).toBe(false);
    });
  });

  it('a file with any other name is read and left alone', () => {
    inTempDir(dir => {
      const path = join(dir, 'my-prompt.txt');
      put(path, 'summarize this repository\n', 0o644);
      expect(readLaunchPromptFile(path)).toEqual({ ok: true, prompt: 'summarize this repository' });
      expect(existsSync(path)).toBe(true);
    });
  });

  it('a link is refused, and neither the link nor its target is removed', () => {
    inTempDir(dir => {
      const target = join(dir, 'codeep-prompt-TargetFile1');
      const link = join(dir, 'codeep-prompt-LinkToIt123');
      put(target, SECRET);
      symlinkSync(target, link);
      const r = readLaunchPromptFile(link);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.message).toMatch(/symbolic link/);
      expect(existsSync(link)).toBe(true);
      expect(existsSync(target)).toBe(true);
    });
  });

  it('a file others can write is refused and stays', () => {
    inTempDir(dir => {
      const path = join(dir, 'codeep-prompt-Writable123');
      put(path, SECRET, 0o666);
      const r = readLaunchPromptFile(path);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.message).toMatch(/written by its group or by others/);
      expect(existsSync(path)).toBe(true);
    });
  });

  it('a missing file, a directory, an empty file and one over the limit', () => {
    inTempDir(dir => {
      const missing = readLaunchPromptFile(join(dir, 'codeep-prompt-NotThere123'));
      expect(missing).toEqual({ ok: false, message: 'cannot read the prompt file (ENOENT)' });

      const directory = readLaunchPromptFile(dir);
      expect(directory.ok).toBe(false);
      expect(directory.ok ? '' : directory.message).toMatch(/not a regular file/);

      const empty = join(dir, 'codeep-prompt-Empty123456');
      put(empty, '\n');
      expect(readLaunchPromptFile(empty)).toEqual({ ok: false, message: 'the prompt file is empty' });
      expect(existsSync(empty)).toBe(false);

      const big = join(dir, 'codeep-prompt-TooBig123456');
      put(big, 'a'.repeat(MAX_PROMPT_FILE_BYTES + 1));
      const r = readLaunchPromptFile(big);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.message).toMatch(/256 KiB/);
      expect(existsSync(big)).toBe(true);
    });
  });

  it('a FIFO is refused without waiting for a writer', () => {
    inTempDir(dir => {
      const path = join(dir, 'codeep-prompt-Pipe1234567');
      try { execFileSync('mkfifo', [path]); } catch { return; } // no mkfifo here: nothing to prove
      const r = readLaunchPromptFile(path);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.message).toMatch(/not a regular file/);
    });
  });
});
