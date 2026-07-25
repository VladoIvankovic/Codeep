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
 *   @./local.ts            → relative-to-cwd file
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

import { existsSync, statSync, readFileSync, readdirSync, type Dirent } from 'fs';
import { join, isAbsolute, relative, resolve, sep } from 'path';

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
   * The root directory mentions are resolved against when they're
   * relative (not starting with `/` or `.`). Usually the project root
   * or `process.cwd()`.
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
    if (isSensitiveFile(resolved.fullPath)) {
      failures.push({ mention: tok.raw, reason: 'looks like a secrets file — use /add to attach it deliberately' });
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

    const walked = walkDirectory(resolved.fullPath, opts.root, seen);
    if (walked.files.length === 0) {
      failures.push({ mention: tok.raw, reason: walked.capped ? `stopped at ${MAX_FOLDER_BYTES / 1024}KB cap` : 'no source files found' });
      continue;
    }

    loaded.push(...walked.files);
    if (walked.capped) {
      failures.push({ mention: tok.raw, reason: `stopped at ${MAX_FOLDER_BYTES / 1024}KB cap, loaded ${walked.files.length} file(s)` });
    }
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
    const walked = walkDirectory(resolved.fullPath, opts.root, seen);
    if (walked.files.length === 0) {
      folderFailures.push({ mention: tok.raw, reason: walked.capped ? `stopped at ${MAX_FOLDER_BYTES / 1024}KB cap` : 'no source files found' });
      continue;
    }
    folderLoaded.push(...walked.files);
    if (walked.capped) {
      folderFailures.push({ mention: tok.raw, reason: `stopped at ${MAX_FOLDER_BYTES / 1024}KB cap, loaded ${walked.files.length} file(s)` });
    }
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

/**
 * Walk a directory and return its source files, capped at
 * `MAX_FOLDER_BYTES` total content. Mutates `seen` so repeat folders
 * don't duplicate files.
 */
function walkDirectory(
  dir: string,
  root: string,
  seen: Set<string>,
): { files: Array<{ fullPath: string; relativePath: string; content: string }>; capped: boolean } {
  const files: Array<{ fullPath: string; relativePath: string; content: string }> = [];
  let totalBytes = 0;
  let capped = false;

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
      if (isDir) {
        if (DEFAULT_IGNORE_DIRS.has(name)) continue;
        walk(full, depth + 1);
      } else {
        if (!shouldSuggest(name)) continue;
        if (seen.has(full)) continue;
        const fstat = safeStat(full);
        if (!fstat.exists || !fstat.isFile) continue;
        if (fstat.size > MAX_MENTION_BYTES) continue;
        const content = safeRead(full);
        if (content === null) continue;
        if (totalBytes + content.length > MAX_FOLDER_BYTES) {
          capped = true;
          return;
        }
        totalBytes += content.length;
        seen.add(full);
        files.push({ fullPath: full, relativePath: relative(root, full), content });
      }
    }
  };

  walk(dir, 0);
  return { files, capped };
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
 *   `./rel/...`  → resolved against cwd (not root), like a normal import.
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
    fullPath = resolve(process.cwd(), mentionPath);
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
 */
const SENSITIVE_FILE_RE =
  /^(\.env(\..*)?|\.netrc|\.npmrc|\.pgpass|credentials|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|keystore))$/i;

/** True if `fullPath`'s basename looks like it holds secrets. */
export function isSensitiveFile(fullPath: string): boolean {
  const name = fullPath.split(sep).pop() ?? fullPath;
  return SENSITIVE_FILE_RE.test(name);
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
