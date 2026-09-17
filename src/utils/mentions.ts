/**
 * `@-mention` context expansion for the CLI chat input.
 *
 * When the user types `@path/to/file.ts` inline in their prompt, we
 * detect those mentions, read the file contents, and inject them as an
 * "[Attached files]" block prepended to the prompt — same format as the
 * explicit `/add` command, so the agent sees a single, consistent shape.
 *
 * Supported mention forms (case-sensitive `@`):
 *   @src/index.ts          → relative-to-project-root file
 *   @./local.ts            → relative-to-project-root file too
 *   @/abs/path.ts          → absolute path
 *   @"path with space.ts"  → quoted (spaces/special chars allowed)
 *   @'path with space.ts'  → single-quoted variant
 *
 * A `@` immediately followed by whitespace, another `@`, or a non-path
 * character (e.g. an email like `user@host`, or a GitHub `@handle`) is
 * left untouched.
 *
 * Mentions are resolved against the project root (or cwd when no
 * project is open). Files larger than `MAX_MENTION_BYTES` are skipped
 * with a warning rather than silently truncated — the user should
 * explicitly `/add` very large files if they really want them.
 */

import { statSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'fs';
import { join, isAbsolute, relative, resolve, sep } from 'path';
import { loadIgnoreRules, isIgnored, rulesBelow, type IgnoreRules } from './gitignore';

/** Max file size we'll auto-inline from a mention (100 KB). */
export const MAX_MENTION_BYTES = 100 * 1024;

/** Result of expanding `@-mentions` in a prompt. */
export interface MentionExpansionResult {
  /** The prompt with file contents prepended (or the original if no mentions). */
  enrichedPrompt: string;
  /**
   * The prompt with each mention's `@` sigil removed but WITHOUT the attached
   * block — i.e. `enrichedPrompt` minus its header. Callers that merge several
   * expanders into one block need this: parsing the block back out of
   * `enrichedPrompt` with a regex silently left the file bodies behind and
   * attached every mentioned file twice.
   */
  strippedPrompt: string;
  /** Successfully loaded files: `[fullPath, relativePath, content][]`. */
  loaded: Array<{ fullPath: string; relativePath: string; content: string }>;
  /** Mentions that couldn't be resolved, with a human-readable reason. */
  failures: Array<{ mention: string; reason: string }>;
}

// ─── Mention extraction ───────────────────────────────────────────────────────

/**
 * The raw text of a mention match (without the leading `@`).
 * Used internally by the tokenizer.
 */
interface MentionToken {
  /** Full match including `@`, for replacement. */
  raw: string;
  /** The path portion (without quotes if it was quoted). */
  path: string;
  /** Start index in the source string. */
  start: number;
  /** End index (exclusive). */
  end: number;
}

/**
 * Regex matching a single `@-mention` at a position.
 *
 * Three branches:
 *   1. `@"..."` or `@'...'` — quoted path (allows any char except the quote).
 *   2. `@<path-chars>` — bare path: must contain at least one path-ish
 *      character beyond bare letters/digits (a `/`, `.`, `_`, or `-`),
 *      so that GitHub handles (`@octocat`) and emails (`user@host`)
 *      aren't mistaken for file mentions. `@index.ts`, `@src/a`,
 *      `@my-file` all qualify; `@octocat` doesn't.
 *
 * Anchored with a preceding boundary so `user@host` doesn't match.
 * `(?<=^|[\s([{<,;])` — start-of-string or whitespace/punctuation before `@`.
 */
const MENTION_RE =
  /(?<=^|[\s([{<,;\]}])@(?:"([^"]+)"|'([^']+)'|([^\s@"'`<>|&()[\]{}]*[\/._-][^\s@"'`<>|&()[\]{}]+))/g;

/**
 * The single source of truth for "may a mention start after this character?".
 * `MENTION_RE`'s lookbehind above and the editor's `detectMentionQuery` picker
 * MUST agree — when they diverged, the picker happily completed mentions
 * (e.g. after `]`) that the expander then ignored, so the file silently never
 * got attached. Import this rather than re-spelling the class.
 */
export const MENTION_BOUNDARY = /[\s([{<,;\]}]/;

/**
 * Extract all `@-mention` tokens from `text`. Returns them in document
 * order. Pure (no FS) — testable without touching the disk.
 */
export function extractMentions(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  // Reset lastIndex in case the regex was used before (it's a /g flag).
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const path = m[1] ?? m[2] ?? m[3] ?? '';
    if (!path) continue;
    tokens.push({
      raw: m[0],
      path,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

// ─── Mention expansion ────────────────────────────────────────────────────────

export interface MentionExpansionOptions {
  /**
   * The root directory relative mentions (`src/a.ts`, `./a.ts`, `.`) are
   * resolved against. Usually the project root or `process.cwd()`.
   */
  root: string;
}

/**
 * Expand all `@-mentions` in `prompt`: load each referenced file,
 * prepend the contents as an `[Attached files]` block, and strip the
 * `@path` tokens from the visible prompt (replacing them with a bare
 * path so the agent still sees what was referenced).
 *
 * Failures (missing file, too large, not a file) are collected and
 * returned rather than thrown — the caller decides how to surface them.
 */
export function expandMentions(
  prompt: string,
  opts: MentionExpansionOptions,
): MentionExpansionResult {
  const tokens = extractMentions(prompt);
  if (tokens.length === 0) {
    return { enrichedPrompt: prompt, strippedPrompt: prompt, loaded: [], failures: [] };
  }

  const loaded: Array<{ fullPath: string; relativePath: string; content: string }> = [];
  const failures: Array<{ mention: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const tok of tokens) {
    const resolved = resolveMentionPath(tok.path, opts.root);
    if (!resolved.ok) {
      failures.push({ mention: tok.raw, reason: resolved.reason });
      continue;
    }
    if (seen.has(resolved.fullPath)) continue; // dedupe repeat mentions
    seen.add(resolved.fullPath);

    // Never auto-inline a secret file. Mentions can come from text the user
    // pasted (an issue body, a log, model output), so `@.env` or
    // `@~/.aws/credentials` would silently ship credentials to the provider.
    // `/add` remains the explicit, deliberate path for these.
    if (isRefusedMention(resolved.fullPath)) {
      failures.push({ mention: tok.raw, reason: SECRETS_REASON });
      continue;
    }

    const stat = safeStat(resolved.fullPath);
    if (!stat.exists) {
      failures.push({ mention: tok.raw, reason: 'file not found' });
      continue;
    }
    if (!stat.isFile) {
      failures.push({ mention: tok.raw, reason: 'not a file' });
      continue;
    }
    // A cloned repo can commit `notes.md -> ~/.zsh_history`: a path inside
    // the project must not read a file from outside it.
    if (linksOutsideRoot(resolved.fullPath, opts.root)) {
      failures.push({ mention: tok.raw, reason: LINKS_OUTSIDE_REASON });
      continue;
    }
    if (stat.size > MAX_MENTION_BYTES) {
      failures.push({
        mention: tok.raw,
        reason: `too large (${Math.round(stat.size / 1024)}KB, max ${Math.round(MAX_MENTION_BYTES / 1024)}KB)`,
      });
      continue;
    }

    const content = safeRead(resolved.fullPath);
    if (content === null) {
      failures.push({ mention: tok.raw, reason: 'could not read (binary?)' });
      continue;
    }
    // Keys are often saved under names no pattern knows (`~/.ssh/github`).
    if (looksLikeKeyMaterial(content)) {
      failures.push({ mention: tok.raw, reason: SECRETS_REASON });
      continue;
    }

    loaded.push({ fullPath: resolved.fullPath, relativePath: resolved.relativePath, content });
  }

  // Build the enriched prompt: strip the `@` prefix from each mention so
  // the visible text reads naturally ("refactor @src/index.ts" → "refactor
  // src/index.ts"), then prepend the file-contents block.
  let stripped = prompt;
  // Replace from the end so earlier indices stay valid.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    stripped = stripped.slice(0, tok.start) + tok.path + stripped.slice(tok.end);
  }

  const fileBlock = formatFileBlock(loaded);
  return {
    enrichedPrompt: fileBlock ? fileBlock + stripped.trimStart() : stripped,
    strippedPrompt: stripped,
    loaded,
    failures,
  };
}

// ─── `@folder` mentions ──────────────────────────────────────────────────────

/**
 * Max total bytes of file content we'll inline from a single `@folder`
 * mention (200 KB). Prevents a huge directory from blowing the context
 * window — the user can raise this via explicit `/add` if they really
 * want everything.
 */
export const MAX_FOLDER_BYTES = 200 * 1024;

/** One `@folder <path>` mention match. */
interface FolderToken {
  /** Full match including `@folder `, for display in failures. */
  raw: string;
  /** The path portion (after `@folder `). */
  path: string;
  /** Start index of the match (pointing at the `@`). */
  start: number;
  /** End index (exclusive). */
  end: number;
}

/**
 * Regex matching a `@folder <path>` or `@dir <path>` mention.
 *
 * `@folder`/`@dir` must be followed by whitespace, then a path token
 * (no spaces). Quoted paths (`@folder "my dir"`) are supported.
 */
const FOLDER_MENTION_RE =
  /(?:^|[\s([{<,;])@(?:folder|dir)\s+("[^"]+"|'[^']+'|[^\s@[({<,;]+)/gi;

/**
 * Extract all `@folder`/`@dir` mentions from `text`. Pure (no FS).
 * Returns them in document order.
 */
export function extractFolderMentions(text: string): FolderToken[] {
  const tokens: FolderToken[] = [];
  FOLDER_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOLDER_MENTION_RE.exec(text)) !== null) {
    let path = m[1] ?? '';
    if (!path) continue;
    // Strip surrounding quotes if present.
    if ((path.startsWith('"') && path.endsWith('"')) ||
        (path.startsWith("'") && path.endsWith("'"))) {
      path = path.slice(1, -1);
    }
    const matchText = m[0];
    const atIdx = matchText.indexOf('@');
    const start = m.index + (atIdx >= 0 ? atIdx : 0);
    tokens.push({ raw: matchText.slice(atIdx).trim(), path, start, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Expand all `@folder`/`@dir` mentions in `prompt`: recursively read
 * every source file under each directory, and return them in the same
 * shape as `expandMentions` (so the caller can merge the results).
 *
 * Skips the same ignored directories (`node_modules`, `.git`, …) and
 * binary/generated extensions as the autocomplete scanner. Caps total
 * content per mention at `MAX_FOLDER_BYTES` so a single huge tree
 * can't blow the context window.
 *
 * Sync (filesystem reads only) — call before or after `expandMentions`.
 */
export function expandFolderMentions(
  prompt: string,
  opts: MentionExpansionOptions,
): MentionExpansionResult {
  const tokens = extractFolderMentions(prompt);
  if (tokens.length === 0) {
    return { enrichedPrompt: prompt, strippedPrompt: prompt, loaded: [], failures: [] };
  }

  const loaded: Array<{ fullPath: string; relativePath: string; content: string }> = [];
  const failures: Array<{ mention: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const tok of tokens) {
    const resolved = resolveMentionPath(tok.path, opts.root);
    if (!resolved.ok) {
      failures.push({ mention: tok.raw, reason: resolved.reason });
      continue;
    }

    const stat = safeStat(resolved.fullPath);
    if (!stat.exists) {
      failures.push({ mention: tok.raw, reason: 'directory not found' });
      continue;
    }
    if (stat.isFile) {
      failures.push({ mention: tok.raw, reason: 'not a directory (use @file)' });
      continue;
    }
    // Same rule as a single file: a committed `docs -> ~` must not be walked.
    if (linksOutsideRoot(resolved.fullPath, opts.root)) {
      failures.push({ mention: tok.raw, reason: LINKS_OUTSIDE_REASON });
      continue;
    }

    const walked = walkDirectory(resolved.fullPath, opts.root, seen);
    loaded.push(...walked.files);
    for (const reason of walkNotes(walked)) failures.push({ mention: tok.raw, reason });
  }

  // Strip the `@folder <path>` tokens from the visible prompt, leaving
  // the bare path so the agent still sees what was referenced.
  let stripped = prompt;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    stripped = stripped.slice(0, tok.start) + tok.path + stripped.slice(tok.end);
  }

  const fileBlock = formatFileBlock(loaded);
  return {
    enrichedPrompt: fileBlock ? fileBlock + stripped.trimStart() : stripped,
    strippedPrompt: stripped,
    loaded,
    failures,
  };
}

// ─── Combined expansion (`@folder` + `@file`) ───────────────────────────────

/**
 * Expand both `@folder` and `@file` mentions in one pass, merging the
 * loaded files into a single `[Attached files]` block (instead of two
 * separate blocks when called back-to-back).
 *
 * `@web` mentions are async and handled separately in `webFetch.ts`.
 */
export function expandFileAndFolderMentions(
  prompt: string,
  opts: MentionExpansionOptions,
): MentionExpansionResult {
  // Run `@folder` first. We call the lower-level `extractFolderMentions`
  // + directory walk directly so we can collect the loaded files without
  // formatting a block (the merge step formats once).
  const folderTokens = extractFolderMentions(prompt);
  const folderLoaded: Array<{ fullPath: string; relativePath: string; content: string }> = [];
  const folderFailures: Array<{ mention: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const tok of folderTokens) {
    const resolved = resolveMentionPath(tok.path, opts.root);
    if (!resolved.ok) {
      folderFailures.push({ mention: tok.raw, reason: resolved.reason });
      continue;
    }
    const stat = safeStat(resolved.fullPath);
    if (!stat.exists) {
      folderFailures.push({ mention: tok.raw, reason: 'directory not found' });
      continue;
    }
    if (stat.isFile) {
      folderFailures.push({ mention: tok.raw, reason: 'not a directory (use @file)' });
      continue;
    }
    if (linksOutsideRoot(resolved.fullPath, opts.root)) {
      folderFailures.push({ mention: tok.raw, reason: LINKS_OUTSIDE_REASON });
      continue;
    }
    const walked = walkDirectory(resolved.fullPath, opts.root, seen);
    folderLoaded.push(...walked.files);
    for (const reason of walkNotes(walked)) folderFailures.push({ mention: tok.raw, reason });
  }

  // Strip the `@folder` tokens from the prompt before running `@file`
  // expansion, so `@folder src/x` isn't re-matched as a file mention.
  let folderStripped = prompt;
  for (let i = folderTokens.length - 1; i >= 0; i--) {
    const tok = folderTokens[i];
    folderStripped = folderStripped.slice(0, tok.start) + tok.path + folderStripped.slice(tok.end);
  }

  // Run `@file` on the folder-stripped prompt.
  const fileResult = expandMentions(folderStripped, opts);

  // Merge and format a single block.
  const merged = [...folderLoaded, ...fileResult.loaded];
  const failures = [...folderFailures, ...fileResult.failures];

  // Use the block-free prompt directly. Regex-stripping the block back out of
  // `enrichedPrompt` looked equivalent but wasn't: the pattern was lazy, so it
  // removed the `[Attached files]` header and left every file body behind —
  // and the merged block below then appended those same bodies a second time,
  // silently doubling the token cost of every mention.
  const strippedPrompt = fileResult.strippedPrompt;

  const mergedBlock = formatFileBlock(merged);
  return {
    enrichedPrompt: mergedBlock ? mergedBlock + strippedPrompt.trimStart() : strippedPrompt,
    strippedPrompt,
    loaded: merged,
    failures,
  };
}

interface WalkResult {
  files: Array<{ fullPath: string; relativePath: string; content: string }>;
  capped: boolean;
  /**
   * Entries left out on purpose, so the user hears why a file is missing
   * instead of a bare "no source files found". The built-in directory list,
   * binaries and oversized files were always skipped quietly. Folders are
   * counted apart from files: one ignored `target/` is not "1 file".
   */
  skipped: { secrets: number; ignored: number; ignoredDirs: number; outside: number; outsideDirs: number };
}

/**
 * Walk a directory and return its source files, capped at
 * `MAX_FOLDER_BYTES` total content. Mutates `seen` so repeat folders
 * don't duplicate files.
 */
function walkDirectory(dir: string, root: string, seen: Set<string>): WalkResult {
  const files: WalkResult['files'] = [];
  const skipped: WalkResult['skipped'] = { secrets: 0, ignored: 0, ignoredDirs: 0, outside: 0, outsideDirs: 0 };
  let totalBytes = 0;
  let capped = false;

  // Honour the project's .gitignore beneath the named directory: that is
  // where local secrets and build output live. The directory itself was named
  // deliberately, so the rules that ignore it or everything in it (`dist/`,
  // `dist/*`) are dropped, the same way DEFAULT_IGNORE_DIRS only applies
  // below it. A directory outside the project has no rules of its own here.
  const insideRoot = computeRelativePath(dir, root) !== dir;
  const ignore: IgnoreRules | null = insideRoot ? rulesBelow(dir, loadIgnoreRules(root)) : null;

  // A symlink may only lead somewhere the user already chose to share: the
  // named directory or the project. A cloned repo can commit
  // `docs/notes.md -> ~/.zsh_history`, and the loaded file list is never shown.
  const allowed = [realPathOf(dir), realPathOf(root)].filter((p): p is string => p !== null);

  const walk = (d: string, depth: number): void => {
    if (capped || depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (capped) return;
      const full = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir && DEFAULT_IGNORE_DIRS.has(name)) continue;
      if (!isDir && (!shouldSuggest(name) || seen.has(full))) continue;
      if (ignore && isIgnored(full, ignore)) {
        if (isDir) skipped.ignoredDirs++;
        else skipped.ignored++;
        continue;
      }
      const real = realPathOf(full);
      if (real === null) continue;
      if (!allowed.some((base) => isWithin(real, base))) {
        if (isDir) skipped.outsideDirs++;
        else skipped.outside++;
        continue;
      }
      if (isDir) {
        walk(full, depth + 1);
        continue;
      }
      // Same rule as a single-file mention: `@dir ~/.ssh` or `@dir config`
      // must not ship the private key that `@config/server.key` refuses.
      if (isSensitiveFile(full)) {
        skipped.secrets++;
        continue;
      }
      const fstat = safeStat(full);
      if (!fstat.exists || !fstat.isFile) continue;
      if (fstat.size > MAX_MENTION_BYTES) continue;
      const content = safeRead(full);
      if (content === null) continue;
      if (looksLikeKeyMaterial(content)) {
        skipped.secrets++;
        continue;
      }
      if (totalBytes + content.length > MAX_FOLDER_BYTES) {
        capped = true;
        return;
      }
      totalBytes += content.length;
      seen.add(full);
      files.push({ fullPath: full, relativePath: relative(root, full), content });
    }
  };

  walk(dir, 0);
  return { files, capped, skipped };
}

/** The notes a folder mention reports back: the cap, and what was left out. */
function walkNotes(walked: WalkResult): string[] {
  const { secrets, ignored, ignoredDirs, outside, outsideDirs } = walked.skipped;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (secrets) parts.push(count(secrets, 'secret-looking file'));
  if (ignored) parts.push(count(ignored, 'ignored file'));
  if (ignoredDirs) parts.push(count(ignoredDirs, 'ignored folder'));
  if (outside) parts.push(`${count(outside, 'file')} linked from outside the project`);
  if (outsideDirs) parts.push(`${count(outsideDirs, 'folder')} linked from outside the project`);
  const skippedNote = parts.length
    ? `skipped ${parts.join(', ')}; use /add to attach one deliberately`
    : '';
  const capNote = `stopped at ${MAX_FOLDER_BYTES / 1024}KB cap`;
  if (walked.files.length === 0) {
    const reason = walked.capped ? capNote : 'no source files found';
    return [skippedNote ? `${reason}; ${skippedNote}` : reason];
  }
  const notes: string[] = [];
  if (walked.capped) notes.push(`${capNote}, loaded ${walked.files.length} file(s)`);
  if (skippedNote) notes.push(skippedNote);
  return notes;
}

// ─── Path resolution ──────────────────────────────────────────────────────────

interface ResolvedPath {
  ok: true;
  fullPath: string;
  relativePath: string;
}
interface UnresolvedPath {
  ok: false;
  reason: string;
}

/**
 * Resolve a mention's path to an absolute filesystem path and a
 * display path (relative to root when possible).
 *
 * Rules:
 *   `/abs/...`   → used as-is, relativePath computed from root.
 *   `./rel/...`  → resolved against root too. In ACP the process cwd is not
 *                  the workspace, so `@dir .` walked the wrong directory.
 *   `rel/...`    → resolved against root (project root).
 *   `~/...`      → expanded to the home directory.
 */
function resolveMentionPath(mentionPath: string, root: string): ResolvedPath | UnresolvedPath {
  let fullPath: string;
  if (mentionPath.startsWith('~/')) {
    // Only `~/` is a home reference. `slice(2)` on a bare `~foo/bar.ts`
    // silently produced `$HOME/oo/bar.ts` and then reported "file not found".
    fullPath = resolve(join(getHomeDir(), mentionPath.slice(2)));
  } else if (isAbsolute(mentionPath)) {
    fullPath = resolve(mentionPath);
  } else if (mentionPath.startsWith('./') || mentionPath.startsWith('.\\') || mentionPath === '.') {
    fullPath = resolve(root, mentionPath);
  } else {
    fullPath = resolve(join(root, mentionPath));
  }

  const relativePath = computeRelativePath(fullPath, root);
  return { ok: true, fullPath, relativePath };
}

/** `fullPath` relative to `root`, or the absolute path if outside root. */
function computeRelativePath(fullPath: string, root: string): string {
  const rel = relative(root, fullPath);
  // `relative` returns an absolute path (or one starting with `..`)
  // when `fullPath` is outside `root` — keep the absolute form then.
  if (rel.startsWith('..') || isAbsolute(rel)) return fullPath;
  return rel;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Format the `[Attached files]` block prepended to the enriched prompt. */
export function formatFileBlock(files: Array<{ relativePath: string; content: string }>): string {
  if (files.length === 0) return '';
  const parts: string[] = ['[Attached files]'];
  for (const f of files) {
    parts.push(`\nFile: ${f.relativePath}\n\`\`\`\n${f.content}\n\`\`\``);
  }
  return parts.join('\n') + '\n\n';
}

// ─── Mention suggestions (autocomplete source) ───────────────────────────────

export interface MentionSuggestion {
  /** Display label for the picker (e.g. `src/index.ts`). */
  label: string;
  /** The path to insert after `@` when picked. */
  insertPath: string;
  /** A short hint — the file's directory or type. */
  detail: string;
}

/** Default glob ignores when scanning for mention suggestions. */
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  'coverage', '.turbo', '.nuxt', '.output', '.vercel',
  '.DS_Store', '__pycache__', '.pytest_cache', '.mypy_cache',
  'vendor', 'Pods', 'DerivedData', '.build',
]);

/** Default file extensions we won't suggest (binaries / generated / huge). */
const DEFAULT_IGNORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.7z', '.dmg', '.iso',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flv',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.class',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.min.js', '.min.css',
  '.lock', '.bin', '.dat',
]);

export interface SuggestOptions {
  /** Root directory to scan. */
  root: string;
  /** Filter prefix typed so far (e.g. `src/ind` from `@src/ind`). */
  query?: string;
  /** Max suggestions to return. */
  limit?: number;
  /** Extra directories to skip (merged with the defaults). */
  extraIgnoreDirs?: string[];
}

/**
 * Scan `root` for source files matching `query`, returning suggestions
 * for the `@` autocomplete popup. Walks up to `limit` files, skipping
 * ignored directories and binary/generated extensions.
 *
 * Used by the input layer's autocomplete — kept pure-async so it's
 * testable with a temp dir.
 */
/** Cached directory listing for the autocomplete picker.
 *  Scanning a large project on every keystroke is too slow, so we
 *  cache the flat file list per-root and invalidate after `CACHE_TTL_MS`. */
interface SuggestionCacheEntry {
  root: string;
  /** Flat list of suggestible relative paths. */
  files: string[];
  /** When the entry was populated (ms since epoch). */
  at: number;
}
let suggestionCache: SuggestionCacheEntry | null = null;
const SUGGEST_CACHE_TTL_MS = 5000;

/**
 * Build (or reuse from cache) the flat list of suggestible files under
 * `root`, then filter by `query`. The scan walks up to `maxScan` files,
 * skipping ignored directories and binary/generated extensions.
 */
export function suggestMentions(opts: SuggestOptions): MentionSuggestion[] {
  const { root, query = '', limit = 20, extraIgnoreDirs = [] } = opts;
  const ignores = new Set([...DEFAULT_IGNORE_DIRS, ...extraIgnoreDirs]);
  const q = query.toLowerCase();

  // Cache lookup — reuse the file list if it's fresh.
  const now = Date.now();
  let files: string[];
  if (suggestionCache && suggestionCache.root === root && now - suggestionCache.at < SUGGEST_CACHE_TTL_MS) {
    files = suggestionCache.files;
  } else {
    files = scanFiles(root, ignores);
    suggestionCache = { root, files, at: now };
  }

  const results: MentionSuggestion[] = [];
  for (const rel of files) {
    if (results.length >= limit) break;
    if (q && !rel.toLowerCase().includes(q)) continue;
    const slashIdx = rel.lastIndexOf(sep);
    const detail = slashIdx >= 0 ? rel.slice(0, slashIdx) : rel;
    results.push({ label: rel, insertPath: rel, detail });
  }
  return results;
}

/** Walk `root` and return a flat list of suggestible relative paths. */
/**
 * Hard ceiling on files visited by one suggestion scan. The walk runs on the
 * first `@` keystroke and blocks the render loop; in a large monorepo an
 * unbounded walk froze the TUI for seconds. 20k entries is far more than the
 * picker can use (it shows 8) but still finds everything in a normal repo.
 */
const MAX_SCAN_FILES = 20_000;

function scanFiles(root: string, ignores: Set<string>): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || visited >= MAX_SCAN_FILES) return;
    let entries: Dirent[];
    try {
      // `withFileTypes` gives us the entry kind from the directory read
      // itself — the previous per-entry `statSync` was an extra syscall for
      // every file in the tree.
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_FILES) return;
      visited++;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (ignores.has(name)) continue;
        walk(join(dir, name), depth + 1);
      } else if (entry.isFile()) {
        if (!shouldSuggest(name)) continue;
        out.push(relative(root, join(dir, name)));
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Clear the suggestion cache. Call between tests so fixtures don't leak. */
export function clearSuggestionCache(): void {
  suggestionCache = null;
}

/** Dotfiles we never suggest (besides the implicit `.` / `..`). */
const IGNORED_DOTFILES = new Set(['.DS_Store', '.env']);

/**
 * Filenames that typically hold credentials. Mentions never auto-inline
 * these — see the guard in `expandMentions`. Matched on the basename so it
 * catches the file wherever it lives (project root, `~/.aws/`, …).
 * Committed templates (`.env.example`) are left to `ENV_TEMPLATE_RE`;
 * SSH keys match with any suffix (`id_ed25519_work`) except `.pub`.
 */
const SENSITIVE_FILE_RE =
  /^(\.env(?!\.(?:example|sample|template)$)(\..*)?|\.netrc|\.npmrc|\.pgpass|\.git-credentials|\.pypirc|\.dockercfg|credentials|id_(?!.*\.pub$)(rsa|dsa|ecdsa|ed25519)(_sk)?([_.-].*)?|.*\.(pem|key|p12|pfx|keystore|ppk))$/i;

/**
 * Credential files whose own name is generic, recognised by the directory
 * they sit in: `~/.docker/config.json`, `~/.kube/config`,
 * `~/.config/gh/hosts.yml`.
 */
const SENSITIVE_PATH_RE = /(^|[\\/])(\.docker[\\/]config\.json|\.kube[\\/]config|gh[\\/]hosts\.ya?ml)$/i;

const SECRETS_REASON = 'looks like a secrets file — use /add to attach it deliberately';

/**
 * Committed `.env` templates. A walk and smart context include them, but a
 * single `@.env.example` is refused as it always was: a template can still
 * hold a real value.
 */
const ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template)$/i;

/**
 * True if `fullPath` looks like it holds secrets, judged by its basename and,
 * for a symlink, by the basename of the file it points at: a repo can commit
 * `.env.example -> .env` or `tsconfig.json -> ../.env`, and every read
 * follows the link.
 */
export function isSensitiveFile(fullPath: string): boolean {
  if (nameMatches(fullPath, SENSITIVE_FILE_RE)) return true;
  if (SENSITIVE_PATH_RE.test(fullPath)) return true;
  const real = realPathOf(fullPath);
  return real !== null && SENSITIVE_PATH_RE.test(real);
}

/**
 * True if a file named on its own (an @-mention, or a path smart context
 * picks out of the prompt) must not be inlined: secrets, and committed `.env`
 * templates, which can still hold a real value. Both paths use this one rule,
 * so a mention the user was told is refused never reaches the provider
 * another way.
 */
export function isRefusedMention(fullPath: string): boolean {
  return isSensitiveFile(fullPath) || nameMatches(fullPath, ENV_TEMPLATE_RE);
}

/** True if the basename of `fullPath`, or of the file it links to, matches `re`. */
function nameMatches(fullPath: string, re: RegExp): boolean {
  const nameOf = (p: string) => p.split(sep).pop() ?? p;
  if (re.test(nameOf(fullPath))) return true;
  const real = realPathOf(fullPath);
  return real !== null && re.test(nameOf(real));
}

/**
 * A PEM / OpenSSH / PGP private-key block, or a PuTTY key header. The armour
 * line must be followed by a line break, real or escaped (a service account
 * JSON holds the key inside a string), then optional `Proc-Type:` /
 * `Version:` headers and a blank line, then a line of base64. Code and docs
 * that only name the armour (`"-----BEGIN RSA PRIVATE KEY-----"`, a regex,
 * `'…-----\n' + body`, a `...` placeholder) don't match.
 */
const PRIVATE_KEY_RE = new RegExp(
  String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[ \t]*(?:\r?\n|\\(?:r\\)?n)` +
    String.raw`(?:[ \t]*[A-Za-z][\w-]*:[^\r\n\\]*(?:\r?\n|\\(?:r\\)?n))*` +
    String.raw`(?:[ \t]*(?:\r?\n|\\(?:r\\)?n))?` +
    String.raw`[ \t]*[A-Za-z0-9+/]+=*[ \t]*(?:\\(?:r\\)?n|$)` +
    String.raw`|^PuTTY-User-Key-File-\d+:`,
  'm',
);

/**
 * True if `text` holds private-key material anywhere. Keys are saved under
 * any name (`~/.ssh/github`, `deploy/prod`), so the name check alone lets
 * them through, and a key can sit past the top of a JSON or YAML file.
 */
export function looksLikeKeyMaterial(text: string): boolean {
  return PRIVATE_KEY_RE.test(text) || hasPrivateKeyBlock(text);
}

const KEY_ARMOUR_RE = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----/g;
/** How far past an armour line a key body is looked for. */
const KEY_BLOCK_WINDOW = 20 * 1024;

/**
 * A complete private key block written the way code and config write it: on
 * one line with spaces for breaks (YAML, CI variables), as concatenated or
 * joined string literals, with `\n` or `\\n` escapes, or with the body glued
 * to the armour line. The line-shaped pattern above misses those.
 *
 * Plain string work rather than one regex: a pattern that spans BEGIN, a body
 * and END backtracks badly on a file full of BEGIN lines with no END.
 */
function hasPrivateKeyBlock(text: string): boolean {
  for (const m of text.matchAll(KEY_ARMOUR_RE)) {
    const start = (m.index ?? 0) + m[0].length;
    const nextBegin = text.indexOf('-----BEGIN ', start);
    const limit = Math.min(nextBegin < 0 ? text.length : nextBegin, start + KEY_BLOCK_WINDOW);
    const window = text.slice(start, limit);
    const endAt = window.indexOf(`-----END ${m[1]}PRIVATE KEY${m[2] ?? ''}-----`);
    if (endAt < 0) continue;
    const body = window.slice(0, endAt)
      .replace(/\\\\?[rn]/g, '\n')   // \n and \\n escapes are line breaks
      .replace(/\\\//g, '/')           // JSON writes / as \/
      .split(/\r?\n/)
      // Armour headers (Proc-Type:, Comment:) are not base64, which has no colon.
      .filter((line) => !line.includes(':'))
      .join('')
      .replace(/[\s"'`+,[\]]/g, '');
    const run = /^[A-Za-z0-9/=]{40,}/.exec(body)?.[0];
    // A real body mixes many characters; a placeholder like xxxx… does not.
    if (run && new Set(run).size >= 10) return true;
  }
  return false;
}

/** `fullPath` with every symlink resolved, or null when it doesn't resolve. */
function realPathOf(fullPath: string): string | null {
  try {
    return realpathSync(fullPath);
  } catch {
    return null;
  }
}

const LINKS_OUTSIDE_REASON = 'links outside the project — use /add to attach it deliberately';

/**
 * True if `fullPath` names a place inside `root` but, with symlinks resolved,
 * leads outside it. A path outside the project by name (`~/.ssh`) was chosen
 * on purpose and is not judged here.
 */
function linksOutsideRoot(fullPath: string, root: string): boolean {
  return isWithin(fullPath, resolve(root)) && !resolvesWithin(fullPath, root);
}

/** True if `child` is `parent` or lies beneath it. */
function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * True if `fullPath`, with symlinks resolved, lies inside `dir` (also
 * resolved). False when either doesn't exist.
 */
export function resolvesWithin(fullPath: string, dir: string): boolean {
  const real = realPathOf(fullPath);
  const realDir = realPathOf(dir);
  return real !== null && realDir !== null && isWithin(real, realDir);
}

/** True if a filename looks like a suggestible source file. */
function shouldSuggest(name: string): boolean {
  if (IGNORED_DOTFILES.has(name)) return false;
  const lower = name.toLowerCase();
  for (const ext of DEFAULT_IGNORE_EXTS) {
    if (lower.endsWith(ext)) return false;
  }
  return true;
}

// ─── FS wrappers (seam for testing / non-utf8 safety) ─────────────────────────

interface StatInfo {
  exists: boolean;
  isFile: boolean;
  size: number;
}

function safeStat(fullPath: string): StatInfo {
  try {
    const stat = statSync(fullPath);
    return { exists: true, isFile: stat.isFile(), size: stat.size };
  } catch {
    return { exists: false, isFile: false, size: 0 };
  }
}

function safeRead(fullPath: string): string | null {
  try {
    const buf = readFileSync(fullPath);
    // Reject obvious binaries (NUL byte in the first 8 KB).
    const sniff = buf.subarray(0, Math.min(buf.length, 8192));
    if (sniff.includes(0)) return null;
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

function getHomeDir(): string {
  try {
    return process.env.HOME || process.env.USERPROFILE || '/';
  } catch {
    return '/';
  }
}


// ─── `@git <ref>` mentions ───────────────────────────────────────────────────

/**
 * Format a `[Git ref]` block — same visual style as `[Attached files]`
 * but for git diffs / file-at-ref content. Each entry is labeled with
 * the git ref so the agent knows what it's looking at.
 */
function formatGitBlock(entries: Array<{ label: string; content: string }>): string {
  if (entries.length === 0) return '';
  const parts: string[] = ['[Git ref]'];
  for (const e of entries) {
    parts.push(`\nRef: ${e.label}\n\`\`\`diff\n${e.content}\n\`\`\``);
  }
  return parts.join('\n') + '\n\n';
}

/** One `@git <ref>` mention match. */
interface GitToken {
  raw: string;
  ref: string;
  start: number;
  end: number;
}

/**
 * Regex matching a `@git <ref>` mention. `@git` must be followed by
 * whitespace, then a ref.
 *
 * Capture order:
 * 1. Quoted (`"…"` / `'…'`) — full string, spaces allowed.
 * 2. `diff …` — diff forms may carry flags (`--staged`, `--cached`)
 *    or a range (`a..b`, `a...b`). Each optional token is one word;
 *    bare words like "and" are NOT consumed (so `@git diff and @git
 *    HEAD` parses as two mentions).
 * 3. Any other single token (SHA, branch, `HEAD:file`).
 */
const GIT_MENTION_RE =
  /(?:^|[\s([{<,;])@git\s+("[^"]+"|'[^']+'|diff(?:\s+--?[a-zA-Z-]+|\s+\S*\.{2,3}\S*)*|[^\s@[({<,;]+)/gi;

/**
 * Extract all `@git <ref>` mentions from `text`. Pure (no FS / no git).
 */
export function extractGitMentions(text: string): GitToken[] {
  const tokens: GitToken[] = [];
  GIT_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GIT_MENTION_RE.exec(text)) !== null) {
    let ref = m[1] ?? '';
    if (!ref) continue;
    if ((ref.startsWith('"') && ref.endsWith('"')) ||
        (ref.startsWith("'") && ref.endsWith("'"))) {
      ref = ref.slice(1, -1);
    }
    if (!ref) continue;
    const matchText = m[0];
    const atIdx = matchText.indexOf('@');
    const start = m.index + (atIdx >= 0 ? atIdx : 0);
    tokens.push({ raw: matchText.slice(atIdx).trim(), ref, start, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Expand all `@git <ref>` mentions in `prompt`: resolve each ref to
 * git content (diff, file-at-ref, or commit patch) and inject it as
 * a `[Git ref]` block. Sync (git is run via `execSync`).
 *
 * The block is appended *after* any `[Attached files]` block from
 * `@folder`/`@file` expansion, so the final prompt reads:
 *
 *   [Attached files] … [Git ref] … <user text>
 */
export async function expandGitMentions(
  prompt: string,
  opts: MentionExpansionOptions,
): Promise<MentionExpansionResult> {
  const tokens = extractGitMentions(prompt);
  if (tokens.length === 0) {
    return { enrichedPrompt: prompt, strippedPrompt: prompt, loaded: [], failures: [] };
  }

  // Lazy-import git to avoid pulling child_process into callers that
  // never use `@git` (e.g. tests, the suggestion scanner). Using a
  // dynamic import() keeps the module graph small and works under both
  // CommonJS and ESM.
  const { getGitContent } = await import('./git') as typeof import('./git');

  const entries: Array<{ label: string; content: string }> = [];
  const failures: Array<{ mention: string; reason: string }> = [];

  for (const tok of tokens) {
    const result = getGitContent(tok.ref, opts.root);
    if (!result.success || !result.content) {
      failures.push({ mention: tok.raw, reason: result.error || 'empty result' });
      continue;
    }
    entries.push({ label: result.label, content: result.content });
  }

  // Strip the `@git <ref>` tokens from the prompt, leaving the bare ref.
  let stripped = prompt;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    stripped = stripped.slice(0, tok.start) + tok.ref + stripped.slice(tok.end);
  }

  const gitBlock = formatGitBlock(entries);
  return {
    enrichedPrompt: gitBlock ? gitBlock + stripped.trimStart() : stripped,
    strippedPrompt: stripped,
    loaded: [],
    failures,
  };
}
