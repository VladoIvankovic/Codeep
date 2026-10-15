/**
 * The launch prompt, read from a file (`codeep --prompt-file <path>`).
 *
 * Why a file: a word on the command line is public. Any local user can read
 * /proc/<pid>/cmdline of any process on a system whose /proc is not mounted
 * with hidepid, and `codeep -- "<prompt>"` puts the prompt there for as long
 * as Codeep runs — and in the terminal's own command line before that. An
 * environment variable is private (/proc/<pid>/environ is not world-readable)
 * but does not arrive: a terminal that runs as a single instance (ghostty,
 * kitty, foot's server) starts the child from the server's environment, not
 * the launcher's. A file arrives, and only its path is public.
 *
 * What is trusted is only what the launcher can have made, so this is strict
 * on purpose, and each refusal is a message of its own — a launcher that
 * cannot say why its prompt did not arrive cannot be fixed:
 *
 *   - an absolute path, with no NUL: no `~`, no relative path, no searching;
 *   - a regular file and not a symbolic link, opened with O_NOFOLLOW, and
 *     looked at again through the open descriptor (the same file, as far as
 *     dev and inode say, and the same checks) so nothing can be swapped in
 *     between the look and the read;
 *   - owned by the current user, and not writable by its group or by others:
 *     a file someone else could have written is a prompt someone else could
 *     have written, and an unattended run does what it says. (POSIX only: on
 *     Windows there is no uid, and the mode bits are not a permission.)
 *   - at most 256 KiB, read up to one byte past that so a file that grows
 *     after it was measured is caught as well.
 *
 * It is read once and then removed — but only when its name says it is a
 * launcher's own temp file (`codeep-prompt-` and at least six letters or
 * digits, what `mktemp codeep-prompt-XXXXXXXXXX` makes). Any other file is
 * somebody's: it is left where it is. A file that was refused before it was
 * read is not removed either. Failing to remove it is not an error.
 *
 * No message holds the prompt, and none holds the path either: the path is
 * whatever the launcher put after the flag, and a launcher with a bug can put
 * the prompt there.
 *
 * `fs` and `uid` are injected so every refusal is tested without a real file
 * system; main.ts calls this with neither.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'fs';
import { basename, isAbsolute } from 'path';

/** 256 KiB: far more than anyone types, far less than a file given by mistake. */
export const MAX_PROMPT_FILE_BYTES = 262_144;

/** A launcher's own temp file: what the plugin's `mktemp` makes. Only these are removed. */
const OWN_TEMP_NAME = /^codeep-prompt-[A-Za-z0-9]{6,}$/;

/** Whether a launcher made this file for Codeep, by its name alone. */
export function isLauncherTempFile(path: string): boolean {
  return OWN_TEMP_NAME.test(basename(path));
}

export interface PromptFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
  size: number;
  dev: number;
  ino: number;
}

/** The part of `fs` this uses, synchronous. */
export interface PromptFileFs {
  lstat(path: string): PromptFileStat;
  open(path: string, flags: number): number;
  fstat(fd: number): PromptFileStat;
  /** Bytes read into `buffer` at `offset`, up to `length`; 0 at the end. */
  read(fd: number, buffer: Buffer, offset: number, length: number): number;
  close(fd: number): void;
  unlink(path: string): void;
}

export interface PromptFileDeps {
  fs?: PromptFileFs;
  /** The current user's uid; null where there is none (Windows). Default: this process's. */
  uid?: number | null;
}

export type PromptFileResult =
  | { ok: true; prompt: string }
  | { ok: false; message: string };

const realFs: PromptFileFs = {
  lstat: path => lstatSync(path),
  open: (path, flags) => openSync(path, flags),
  fstat: fd => fstatSync(fd),
  read: (fd, buffer, offset, length) => readSync(fd, buffer, offset, length, null),
  close: fd => closeSync(fd),
  unlink: path => unlinkSync(path),
};

// O_NOFOLLOW makes the open itself fail on a symlinked last component.
// O_NONBLOCK: a FIFO swapped in after the lstat would otherwise block the
// open until somebody writes to it. Neither exists on Windows.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const refuse = (message: string): PromptFileResult => ({ ok: false, message });

/** An errno code (`ENOENT`) as the only thing taken from an error. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'error';
}

/** Whether `a` and `b` are one file, where the file system says so. */
function sameFile(a: PromptFileStat, b: PromptFileStat): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * The prompt in the file at `path`, or why it was not taken. Never throws.
 * Reads the whole file once; removes it after, if it is a launcher's temp file.
 */
export function readLaunchPromptFile(path: string, deps: PromptFileDeps = {}): PromptFileResult {
  const fs = deps.fs ?? realFs;
  const uid = deps.uid !== undefined
    ? deps.uid
    : (typeof process.getuid === 'function' ? process.getuid() : null);

  if (typeof path !== 'string' || path === '') return refuse('the prompt file path is empty');
  if (path.includes('\0')) return refuse('the prompt file path is not a valid path');
  // No `~` expansion and no working directory to resolve against: a launcher
  // that means a file says where it is.
  if (!isAbsolute(path)) return refuse('the prompt file path must be absolute (no ~ and no relative path)');

  let before: PromptFileStat;
  try {
    before = fs.lstat(path);
  } catch (error) {
    return refuse(`cannot read the prompt file (${codeOf(error)})`);
  }
  const verdict = judge(before, uid);
  if (verdict) return refuse(verdict);

  let fd: number;
  try {
    fd = fs.open(path, OPEN_FLAGS);
  } catch (error) {
    // ELOOP: it became a symlink after the look.
    return refuse(`cannot open the prompt file (${codeOf(error)})`);
  }

  let text: string;
  let opened: PromptFileStat;
  try {
    opened = fs.fstat(fd);
    // What was opened must be what was looked at, and pass the same checks.
    if (!sameFile(before, opened)) return refuse('the prompt file changed while it was being opened');
    const again = judge(opened, uid);
    if (again) return refuse(again);

    const buffer = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.read(fd, buffer, length, buffer.length - length);
      if (n <= 0) break;
      length += n;
    }
    if (length > MAX_PROMPT_FILE_BYTES) return refuse('the prompt file is larger than 256 KiB');

    const bytes = buffer.subarray(0, length);
    text = bytes.toString('utf8');
    // Invalid UTF-8 comes out as U+FFFD and does not go back to the same
    // bytes: a binary file is not a prompt.
    if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) return refuse('the prompt file is not valid UTF-8 text');
  } catch (error) {
    return refuse(`cannot read the prompt file (${codeOf(error)})`);
  } finally {
    try { fs.close(fd); } catch { /* nothing to do about it */ }
  }

  // Read in full and decoded, so it is removed whether or not it holds a
  // prompt: it is the launcher's own file and of no use to anyone now.
  removeIfOwn(fs, path, opened);

  // trim() takes a leading BOM (U+FEFF) with the white space, as it does a trailing one.
  const prompt = text.trim();
  if (prompt === '') return refuse('the prompt file is empty');
  return { ok: true, prompt };
}

/** Why a file may not be read, or null. Applied to the lstat and again to the descriptor. */
function judge(st: PromptFileStat, uid: number | null): string | null {
  if (st.isSymbolicLink()) return 'the prompt file is a symbolic link, which is not followed';
  if (!st.isFile()) return 'the prompt file is not a regular file';
  if (uid !== null) {
    if (st.uid !== uid) return 'the prompt file is not owned by you';
    if ((st.mode & 0o022) !== 0) return 'the prompt file can be written by its group or by others';
  }
  if (st.size > MAX_PROMPT_FILE_BYTES) return 'the prompt file is larger than 256 KiB';
  return null;
}

/**
 * Remove `path` if it is a launcher's temp file and still the file that was
 * read. Best effort: nothing here is an error.
 */
function removeIfOwn(fs: PromptFileFs, path: string, read: PromptFileStat): void {
  if (!isLauncherTempFile(path)) return;
  try {
    // Not whatever is at the path by now.
    const now = fs.lstat(path);
    if (now.isSymbolicLink() || !sameFile(now, read)) return;
    fs.unlink(path);
  } catch { /* already gone, or not ours to remove */ }
}
