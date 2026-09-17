/**
 * Guards for files Codeep writes inside a project.
 *
 * A project's `.codeep/` directory usually arrives with a cloned repo, so the
 * repo decides what its entries are. writeFileSync and mkdirSync follow
 * symlinks: a committed `.codeep/progress.md -> ~/.zshrc`, or a symlinked
 * `.codeep/` itself, would have Codeep overwrite, append to or delete files the
 * user never pointed it at.
 */

import {
  closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'path';

export class UnsafeProjectPathError extends Error {
  constructor(readonly path: string) {
    super(`Refusing to write ${path}: it is a symlink or lies under one`);
    this.name = 'UnsafeProjectPathError';
  }
}

/** True if `target` lies strictly inside `root` by name. */
function insideByName(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * True when `dirPath` is a real directory tree under `projectRoot`: it lies
 * inside the root by name, and every part of it that exists — itself
 * included — is a directory, not a symlink to one. Missing parts are fine:
 * mkdirSync creates real directories.
 *
 * The root itself may be a symlink; the user chose to open it.
 */
export function isSafeProjectDir(projectRoot: string, dirPath: string): boolean {
  const root = resolve(projectRoot);
  const dir = resolve(dirPath);
  if (!insideByName(root, dir)) return false;
  // Stops at the filesystem root too, so a caller that skips the check above
  // can never spin on dirname('/') === '/'.
  for (let d = dir; d !== root && d !== dirname(d); d = dirname(d)) {
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return false; // a symlinked directory is not a directory to lstat
  }
  return true;
}

/**
 * True when writing `filePath` lands exactly where the path says: the file
 * lies inside `projectRoot`, no existing directory between the root and the
 * file is a symlink, and the file itself — if it exists — is a regular file,
 * not a symlink.
 */
export function isSafeProjectWriteTarget(projectRoot: string, filePath: string): boolean {
  const root = resolve(projectRoot);
  const target = resolve(filePath);
  if (!insideByName(root, target)) return false;
  const final = lstatSync(target, { throwIfNoEntry: false });
  if (final && !final.isFile()) return false; // symlinks, directories, devices, FIFOs
  const dir = dirname(target);
  return dir === root || isSafeProjectDir(root, dir);
}

/** Create `dirPath` under `projectRoot`, refusing a path through a symlink. */
export function ensureProjectDir(projectRoot: string, dirPath: string): void {
  if (!isSafeProjectDir(projectRoot, dirPath)) throw new UnsafeProjectPathError(dirPath);
  mkdirSync(dirPath, { recursive: true });
}

// O_NOFOLLOW makes the open itself fail on a symlinked last component, so
// nothing can swap one in between the check and the write. Windows has no
// such flag; there the lstat check in isSafeProjectWriteTarget is what holds.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;

function checkedTarget(projectRoot: string, filePath: string): void {
  const dir = dirname(resolve(filePath));
  if (dir !== resolve(projectRoot)) ensureProjectDir(projectRoot, dir);
  if (!isSafeProjectWriteTarget(projectRoot, filePath)) throw new UnsafeProjectPathError(filePath);
}

function writeThroughFd(filePath: string, data: string, flags: number): void {
  const fd = openSync(filePath, flags, 0o644);
  try {
    writeFileSync(fd, data, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Write a file under `projectRoot`, creating its directory, never through a symlink. */
export function writeProjectFile(projectRoot: string, filePath: string, data: string): void {
  checkedTarget(projectRoot, filePath);
  writeThroughFd(filePath, data, WRITE_FLAGS);
}

/** Append to a file under `projectRoot`, creating its directory, never through a symlink. */
export function appendProjectFile(projectRoot: string, filePath: string, data: string): void {
  checkedTarget(projectRoot, filePath);
  writeThroughFd(filePath, data, APPEND_FLAGS);
}

/**
 * writeFileSync that refuses a symlink as the file itself. For files whose
 * directory was already checked (or is the user's own), where only the last
 * component can still be a link.
 */
export function writeFileNoFollow(filePath: string, data: string): void {
  const st = lstatSync(filePath, { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new UnsafeProjectPathError(filePath);
  writeThroughFd(filePath, data, WRITE_FLAGS);
}

/**
 * A notice for a project whose `.codeep/` (or its sessions directory) is a
 * symlink, or null. Codeep does not write through it, so without this the
 * user would find their sessions, notes and logs silently not saved there.
 */
export function symlinkedCodeepNotice(projectRoot: string): string | null {
  const codeep = lstatSync(join(projectRoot, '.codeep'), { throwIfNoEntry: false });
  if (codeep?.isSymbolicLink()) {
    return '.codeep in this project is a symlink, so Codeep does not write into it: sessions are saved in ~/.codeep/sessions, and project notes, the progress log and the audit log are not written.';
  }
  const sessions = lstatSync(join(projectRoot, '.codeep', 'sessions'), { throwIfNoEntry: false });
  if (sessions?.isSymbolicLink()) {
    return '.codeep/sessions in this project is a symlink, so sessions are saved in ~/.codeep/sessions instead.';
  }
  return null;
}

/**
 * True when `filePath` exists and, with symlinks resolved, lies outside the
 * (resolved) project root — a committed `CODEEP.md -> ~/.aws/credentials`.
 * A path that does not resolve is not judged here; reading it fails on its own.
 */
export function leadsOutsideProject(filePath: string, projectRoot: string): boolean {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(filePath);
    realRoot = realpathSync(projectRoot);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
