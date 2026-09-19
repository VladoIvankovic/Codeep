/**
 * Tool execution - runs agent tool calls against the filesystem and shell.
 *
 * validatePath() ensures all file operations stay within the project root.
 * executeTool() dispatches to individual tool handlers.
 * listDirectory() and htmlToText() are private helpers.
 * createActionLog() converts a ToolCall+ToolResult into a history ActionLog.
 * trustBearingWrite() names the writes that decide what runs later.
 */

import { existsSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, realpathSync } from 'fs';
import { join, dirname, basename, relative, resolve, isAbsolute, sep } from 'path';
import { executeCommandAsync } from './shell';
import { recordWrite, recordEdit, recordDelete, recordMkdir, recordCommand, discardAction, recordResult, type ActionRecord } from './history';
import { loadIgnoreRules, isIgnored } from './gitignore';
import { normalizeToolName } from './toolParsing';
import { getZaiMcpConfig, getZaiVisionConfig, getMinimaxMcpConfig, callZaiMcp, callZaiVisionApi, callMinimaxApi } from './mcpIntegration';
import { ToolCall, ToolResult, ActionLog } from './tools';
import { logger } from './logger';
import { runHook } from './hooks';
import { checkCommandRateLimit } from './ratelimit';
import { isMcpToolName, callSessionTool, isVirtualMcpToolName, callSessionVirtualTool } from './mcpRegistry';
import { resolveHooksDirResult, type HooksDirResult } from './gitHookInstaller';
// SSRF guard (isBlockedIp / assertFetchUrlAllowed) moved to ./ssrfGuard —
// shared with shell.ts for curl/wget URL checks. Re-exported here so the
// existing tests that import it from toolExecution keep working.
export { isBlockedIp, assertFetchUrlAllowed } from './ssrfGuard';
import { fetchUrlGuarded } from './guardedFetch';
import { AcpRequestError } from '../acp/transport.js';

const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

/**
 * Validate path is within project root.
 * Uses realpathSync to resolve symlinks, preventing symlink traversal attacks
 * where a symlink inside the project could point to files outside it.
 */
export function validatePath(path: string, projectRoot: string): { valid: boolean; absolutePath: string; error?: string } {
  let normalizedPath = path;
  if (isAbsolute(path) && path.startsWith(projectRoot)) {
    normalizedPath = relative(projectRoot, path);
  }

  if (isAbsolute(normalizedPath)) {
    return { valid: false, absolutePath: normalizedPath, error: `Absolute path '${path}' not allowed. Use relative paths.` };
  }

  const absolutePath = resolve(projectRoot, normalizedPath);
  const relativePath = relative(projectRoot, absolutePath);

  if (relativePath.startsWith('..')) {
    return { valid: false, absolutePath, error: `Path '${path}' is outside project directory` };
  }

  // Resolve the deepest existing ancestor, not only the complete target. A
  // write to `project/link-to-outside/new.txt` has a non-existent leaf, but
  // still follows the existing symlinked parent. lstat is intentional: unlike
  // existsSync it also sees a broken symlink, which must fail closed rather
  // than be followed by writeFileSync.
  try {
    const realRoot = realpathSync(projectRoot);
    let existingAncestor = absolutePath;
    while (true) {
      try {
        lstatSync(existingAncestor);
        break;
      } catch {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) {
          return { valid: false, absolutePath, error: `Path '${path}' could not be resolved` };
        }
        existingAncestor = parent;
      }
    }

    const realAncestor = realpathSync(existingAncestor);
    const ancestorRelative = relative(realRoot, realAncestor);
    if (ancestorRelative === '..' || ancestorRelative.startsWith(`..${sep}`) || isAbsolute(ancestorRelative)) {
      return { valid: false, absolutePath, error: `Path '${path}' resolves outside project directory (symlink traversal)` };
    }
  } catch {
    // realpathSync fails for broken symlinks and inaccessible ancestors.
    return { valid: false, absolutePath, error: `Path '${path}' could not be resolved` };
  }

  return { valid: true, absolutePath };
}

// ── Files that decide what runs later ────────────────────────────────────────
//
// Writing one of these is not an edit, it is code execution on a delay:
//
//  - `.git/` — git honours `core.fsmonitor`, `core.pager`, `diff.external`,
//    `core.hooksPath`, `core.sshCommand` and `credential.helper` by RUNNING
//    the command they name, so the next `git status` Codeep makes for the
//    status line executes whatever `.git/config` says. Scripts in
//    `.git/hooks/` run on the next commit. A worktree's `.git` is a file
//    pointing at the real directory, so the whole name is off limits and not
//    only what sits beneath it.
//  - the repository's hook directory — `.git/hooks/` by default, but
//    `core.hooksPath` moves it, and `.githooks/` and husky's `.husky/` are
//    exactly that convention. A hook there runs on the user's own next
//    `git commit` in their own terminal, long after the agent stopped.
//  - `.codeep/hooks/` — scripts Codeep itself runs around every tool call.
//  - `.codeep/skills/` — a skill's steps are commands Codeep runs when the
//    skill is used (see skillBundles.ts, which loads project skills).
//  - `.codeep/agents/` — a sub-agent definition. Its `tools:` is the
//    allowlist the nested run is checked against and REPLACES the parent's,
//    so it can hand a delegated run a tool this run was restricted from; its
//    `model:` decides which provider the code in that run's context is sent
//    to. Both take effect the next time anything delegates to that name.
//  - `.codeep/mcp_servers.json`, `.mcp.json` — every entry is a command
//    Codeep spawns.
//  - `.codeep/config.json` — Codeep's own settings for this project.
//
// `.codeep/commands/` is deliberately NOT here, and must stay out: a custom
// command is prompt text, expanded into a message to the model, and the model's
// tool calls then go through every gate in this file. Gating it would put a
// confirmation in front of writing a prompt. That is also the line the agents
// directory falls on the other side of: an agent file is prompt text PLUS a
// tool allowlist and a model, which is the part a prompt cannot change.
//
// WHAT THIS DOES NOT COVER, so nobody reads the list above as a boundary:
// only the tools that take a `path` are gated. `execute_command` reaches the
// same files through any program that writes one — reviewers proved it with
// git 2.54 by having the agent write an ordinary `setup.cjs` (not a name on
// this list, so not gated) and then run `node setup.cjs`, which wrote
// `.git/config`; `cp`, `tee` and `mv` do it in one step and need no file
// written first. There is no fix for that here, because a gate that asked
// about every command able to write a file would be asking about every
// command.
//
// Nor is the classification a property of the file: it is decided at the
// moment of the write, from where the repository keeps its hooks AT THAT
// MOMENT. `write_file ci/deploy.sh` in a repository with the default hook
// directory is an ordinary file and goes through unasked; a later `git config
// core.hooksPath ci` makes that same file a live `pre-commit` without any
// further write for this gate to see. The cache below is dropped before every
// command line so the NEXT write is judged against the new hook directory,
// but nothing re-judges the writes that already happened — reclassifying them
// would mean keeping every path a run has written and re-running the gate
// after each command, and there is still nothing to do about a file already
// on disk. What remains covered is the write that installs the hook itself:
// `core.hooksPath` lives in `.git/config`, which this gate confirms.
//
// What it IS worth is the case it was built for: a model that writes a hook
// or a `.git/config` as part of an ordinary-looking edit, with no shell
// involved at all, which is what a prompt injection reaches for because
// execute_command is the tool users already watch. That write now stops for a
// confirmation in every mode. Someone who has approved a shell command has
// approved a shell command.
//
// The reasons are written for the person answering the confirmation prompt:
// "a config file" tells them nothing, "this decides what git runs" does.

const GIT_REASON = 'This file controls what commands git runs — core.fsmonitor, core.pager and diff.external are commands git executes for you.';
const GIT_HOOK_REASON = 'This is a git hook — git runs it on your next commit or push, in your own terminal.';
/** The same gate, for the repository that pointed `core.hooksPath` at its own
 *  root. Every top-level file matches there, so the reason may not say "this
 *  is a git hook": it would tell someone editing `package.json` that their
 *  package manifest is a hook. What is true of all of them is the directory
 *  they sit in, so that is what this says. */
const HOOKS_AT_ROOT_REASON =
  "This repository has named its own top level as its git hook directory (core.hooksPath), so git runs files " +
  'from here by name — writing one can install a hook that runs on your next commit.';
const CODEEP_HOOK_REASON = 'This file runs on every tool call.';
const SKILL_REASON = 'This is a skill — its steps are commands Codeep runs whenever the skill is used.';
const MCP_SERVERS_REASON = 'This file starts MCP servers — every entry is a command Codeep spawns.';
const AGENT_REASON = 'This file defines a sub-agent — the tools it may use and the model it runs on, every time something delegates to it.';
const CODEEP_CONFIG_REASON = "This file is Codeep's own configuration for this project.";
/** The one reason that is not a constant: it carries git's own refusal with
 *  it, because over ACP this prompt is the only place the user is ever told
 *  which key made Codeep refuse and how to clear it. */
const unknownHooksReason = (why: string) =>
  'Codeep could not ask git where this repository keeps its hooks, so it cannot tell whether this write installs ' +
  `one that runs on your next commit. ${why}`;

/** Directory names that are a git hook directory by convention, so a repo
 *  using one is covered before git is asked anything. `.githooks` is the bare
 *  `core.hooksPath` convention and `.husky` is husky's. */
const HOOK_DIRECTORY_NAMES = new Set(['.githooks', '.husky']);

/** Tools whose `path` parameter names a file they create, change or remove. */
const PATH_WRITING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory']);

/**
 * A path's segments as the filesystem will match them: lowercased, because
 * macOS and Windows both hand `.GIT/config` to the same file git reads, and
 * without the trailing dots and spaces Windows silently drops — `.git./config`
 * and `.git /config` are two literal directories on POSIX but land in the real
 * `.git` on Windows, which is the whole point of writing them that way. A
 * segment that is nothing but dots or spaces keeps its own spelling, so `..`
 * stays `..` instead of collapsing to nothing.
 */
function pathSegments(path: string): string[] {
  return path
    .split(/[\\/]+/)
    .filter(s => s && s !== '.')
    .map(s => (s.replace(/[. ]+$/, '') || s).toLowerCase());
}

/**
 * Where this repository's hooks live — resolveHooksDirResult's three-way
 * answer, narrowed to what this gate matches on.
 *
 * - `segments` — the hook directory, relative to the project root.
 * - `none` — there is no hook directory under this root to gate: not a
 *   repository at all, or a `core.hooksPath` pointing outside the project,
 *   which is not somewhere the agent can write anyway. (The `.git/hooks`
 *   default is covered by the `.git` name before git is asked anything.)
 * - `unknown` — git was refused, so the answer is not "no".
 */
type HooksDirectory =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string };

/**
 * The answer per project, for one run.
 *
 * The comment that used to sit here refused a cache, and it was right about
 * the risk and wrong about the cost: `core.hooksPath` really can change
 * mid-run without any write this gate sees — `execute_command` running
 * `git config core.hooksPath .evil` needs no path-writing tool — but paying
 * for that with a fresh resolution on EVERY path-writing call meant two git
 * subprocesses per tool call. Measured over 100 ordinary writes in a real
 * repository: 2484ms without the cache, 4.7ms with it (24.8ms → 0.05ms per
 * call), all of it on the event loop and almost all of it on the common path
 * where no name matches anything.
 *
 * So the answer is cached and thrown away the moment a command runs, which is
 * the only in-run way the answer can change. Every caller that spawns a
 * command line calls forgetHooksDirectory() first: the execute_command tool
 * below, the ACP path that delegates that tool to the client's terminal (see
 * agent.ts), and the two skill runners. `git config core.hooksPath .evil`
 * followed by `write_file .evil/pre-commit` therefore still finds a cold
 * cache, which is the case the old comment was protecting.
 *
 * Keyed by project root because one process serves several workspaces over
 * ACP, and cleared whole rather than per root because a command line can `cd`
 * into any of them.
 */
const hooksDirectoryCache = new Map<string, HooksDirectory>();

/** Drop the cached hook directories. Call before spawning a command line. */
export function forgetHooksDirectory(): void {
  hooksDirectoryCache.clear();
}

/**
 * Where this repository's hooks live, as segments relative to the project
 * root — see HooksDirectory.
 *
 * Asking git is the only way to learn where a repo actually keeps them, and
 * gitHookInstaller already does it with a hardened environment: every
 * command-executing key is neutralised, `core.hooksPath` alone is left under
 * the repo's control, and `git rev-parse` only prints a path. So the
 * resolution cannot run anything the repository chose.
 *
 * resolveHooksDirResult() is the variant that does not throw, and the reason
 * it exists: `none` and `unknown` used to be the same null, and reading a
 * refusal as "no hook directory" switched this gate off in exactly the
 * repositories that earned the refusal. It is still wrapped in a try/catch,
 * and ANY throw counts as unknown — the fail-closed answer must not depend on
 * a promise made by another module.
 */
function hooksDirectorySegments(projectRoot: string, realRoot: string): HooksDirectory {
  const cached = hooksDirectoryCache.get(projectRoot);
  if (cached !== undefined) return cached;
  const answer = resolveHooksDirectory(projectRoot, realRoot);
  hooksDirectoryCache.set(projectRoot, answer);
  return answer;
}

function resolveHooksDirectory(projectRoot: string, realRoot: string): HooksDirectory {
  let result: HooksDirResult;
  try {
    result = resolveHooksDirResult(projectRoot);
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.kind !== 'hooks') return result;
  // Both spellings of the root, as below: git may print the hooks path
  // canonicalised (an absolute `core.hooksPath`, a symlinked checkout), and on
  // macOS that is `/private/var/…` where the root arrived as `/var/…`.
  const rel = insideRoot(projectRoot, result.dir) ?? insideRoot(realRoot, result.dir);
  // `??` and not `||`: '' is the hook directory BEING the project root, which
  // is a repository this has to cover, and pathSegments('') is the empty
  // prefix that says so.
  return rel === null ? { kind: 'none' } : { kind: 'segments', segments: pathSegments(rel) };
}

/**
 * What a project-relative path controls, or null when it controls nothing.
 *
 * Matched on path segments rather than on a prefix, so a nested checkout's
 * `vendor/lib/.git/config` is covered the same as the top-level one.
 *
 * `hooksDir` is the repository's own hook directory. It costs a `git
 * rev-parse` the first time it is asked in a run, so it is asked for only once
 * a name has failed to answer.
 */
function reasonForSegments(relativePath: string, hooksDir: () => HooksDirectory): string | null {
  const segments = pathSegments(relativePath);
  if (segments.includes('.git')) return GIT_REASON;
  if (segments.some(s => HOOK_DIRECTORY_NAMES.has(s))) return GIT_HOOK_REASON;
  const last = segments[segments.length - 1];
  if (last === '.mcp.json') return MCP_SERVERS_REASON;
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] !== '.codeep') continue;
    if (segments[i + 1] === 'hooks') return CODEEP_HOOK_REASON;
    if (segments[i + 1] === 'skills') return SKILL_REASON;
    if (segments[i + 1] === 'agents') return AGENT_REASON;
    if (i + 2 !== segments.length) continue; // `.codeep/<file>` only, not deeper
    if (segments[i + 1] === 'mcp_servers.json') return MCP_SERVERS_REASON;
    if (segments[i + 1] === 'config.json') return CODEEP_CONFIG_REASON;
  }
  const hooks = hooksDir();
  // Git could not be asked, so "this is not a hook" is not something anyone
  // knows. A repository gets that answer when its own config names a program
  // git would run, which is the last repository to hand a write through
  // unasked — so every write in it is confirmed until the config is fixed.
  // Noisy, and that is the trade: the alternative is a `core.hooksPath` this
  // cannot see, pointed anywhere, written into silently.
  if (hooks.kind === 'unknown') return unknownHooksReason(hooks.reason);
  if (hooks.kind === 'none') return null;
  // `every` over the empty prefix is trivially true, which is right: a repo
  // whose `core.hooksPath` IS its root runs `<root>/pre-commit` on the next
  // commit (verified with git 2.54), and that file was going unasked. What
  // would NOT be right is reading that empty prefix as "every path in the
  // project is a hook" — it would put a confirmation in front of every write
  // in the repository. git looks for hooks DIRECTLY in its hook directory, so
  // at the root that is the top level and nothing under it. A hook directory
  // of its own keeps the whole subtree: a hook sources its helpers from
  // beside it, the way husky's `pre-commit` sources `_/husky.sh`.
  const prefix = hooks.segments;
  if (prefix.every((s, i) => segments[i] === s) && (prefix.length > 0 || segments.length === 1)) {
    // Which reason depends on which of those two shapes matched: a hook
    // directory of its own means this file IS one, the root means only that
    // this is the directory git looks in — and that one reports `package.json`
    // along with everything else at the top level.
    return prefix.length > 0 ? GIT_HOOK_REASON : HOOKS_AT_ROOT_REASON;
  }
  return null;
}

/** The path with a symlinked ancestor resolved, or null if it cannot be. */
function realPathThroughLinks(absolutePath: string): string | null {
  let existing = absolutePath;
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(existing); // lstat, so a symlink counts as existing
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return null;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return null;
  }
}

/**
 * The path relative to `root`, or null when it is not inside it.
 *
 * The empty string is a RESULT, not a miss: it means the path is the root
 * itself. Folding it into null cost the hook gate a real repository — one
 * with `core.hooksPath` set to its own root, where git runs `<root>/pre-commit`
 * on the next commit and the relative path of the hook directory is ''.
 */
function insideRoot(root: string, absolutePath: string): string | null {
  const rel = relative(root, absolutePath);
  return !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}

/**
 * The tail of the refusal one of these writes gets when the run has nobody to
 * ask — no permission callback at all, which is how `codeep review --fix`
 * runs in CI. agent.ts builds the refusal; headlessReview.ts recognises it by
 * this text so it can say so in the run output rather than leave it buried in
 * the agent's tool log.
 *
 * One constant, in the module that owns the classification rather than in
 * agent.ts, for two reasons: a reworded refusal that stopped matching would
 * put CI back to failing silently, and agent.js is a module the fix-run tests
 * replace wholesale — a constant read from there would have been undefined in
 * exactly the test that guards this.
 */
export const NO_CONFIRMER_REFUSAL = 'Nobody could be asked to confirm it, so nothing was written.';

export interface TrustBearingWrite {
  /** The path exactly as the tool call named it, for the prompt. */
  path: string;
  /** The absolute path the classification matched — one spelling per file, so
   *  a "never again" answer given for `.git/config` also covers
   *  `./.git/config` and the symlink that reaches it. Never shown to anyone;
   *  it exists to key that answer (see agent.ts). */
  file: string;
  /** One plain sentence about what the file controls. */
  reason: string;
}

/**
 * What a tool call would write that decides what runs later, or null.
 *
 * Callers use this for two things: to force a confirmation the mode would
 * otherwise skip (see agent.ts), and to tell the person answering it what
 * they are approving.
 *
 * A symlink inside the project can point at one of these names — `ln -s .git
 * tools/cfg` makes a write to `tools/cfg/config` land in the real `.git`, and
 * validatePath allows it because it never leaves the project — so the
 * resolved path is classified alongside the one the model asked for.
 */
export function trustBearingWrite(toolCall: ToolCall, projectRoot: string): TrustBearingWrite | null {
  if (!PATH_WRITING_TOOLS.has(normalizeToolName(toolCall.tool))) return null;
  const path = toolCall.parameters?.path;
  if (typeof path !== 'string' || !path) return null;

  const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  let realRoot = projectRoot;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    // Unreadable root: the given path is all there is to go on.
  }

  const candidates = [absolute];
  const resolved = realPathThroughLinks(absolute);
  if (resolved && resolved !== absolute) candidates.push(resolved);

  // Looked up at most once per call, and only if a candidate gets far enough
  // to need it. The cache behind it spans the run; this spans the call, so
  // the two candidates below share one lookup.
  let hooksDir: HooksDirectory | undefined;
  const hooksDirOnce = () => {
    if (hooksDir === undefined) hooksDir = hooksDirectorySegments(projectRoot, realRoot);
    return hooksDir;
  };

  for (const candidate of candidates) {
    // Only the part below the project root is classified. The root's own
    // path is not the agent's doing, and on macOS it usually arrives
    // unresolved (/var/folders/… for /private/var/folders/…), so both
    // spellings get a chance to match.
    const rel = insideRoot(projectRoot, candidate) ?? insideRoot(realRoot, candidate);
    const reason = rel && reasonForSegments(rel, hooksDirOnce);
    // The resolved candidate is the stable name for this file, so it keys the
    // answer when there is one.
    if (reason) return { path, file: resolved ?? candidate, reason };
  }
  return null;
}

/**
 * List directory contents, respecting .gitignore rules.
 * Tracks visited inodes to prevent infinite loops caused by circular symlinks.
 */
function listDirectory(
  dir: string,
  projectRoot: string,
  recursive: boolean,
  prefix: string = '',
  ignoreRules?: ReturnType<typeof loadIgnoreRules>,
  visitedInodes: Set<number> = new Set()
): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  const rules = ignoreRules || loadIgnoreRules(projectRoot);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (isIgnored(fullPath, rules)) continue;

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      try {
        // Recursive listing must not follow an in-workspace symlink into an
        // external directory. Top-level paths already pass validatePath, but
        // each discovered symlink needs the same boundary check.
        if (entry.isSymbolicLink() && !validatePath(fullPath, projectRoot).valid) continue;
        const st = statSync(fullPath); // follows symlinks
        if (st.isDirectory()) {
          if (visitedInodes.has(st.ino)) continue; // circular symlink — skip
          files.push(`${prefix}${entry.name}/`);
          if (recursive) {
            visitedInodes.add(st.ino);
            files.push(...listDirectory(fullPath, projectRoot, true, prefix + '  ', rules, visitedInodes));
            visitedInodes.delete(st.ino);
          }
        } else {
          files.push(`${prefix}${entry.name}`);
        }
      } catch {
        // Broken symlink or permission error — skip silently
      }
    } else {
      files.push(`${prefix}${entry.name}`);
    }
  }

  return files;
}

/**
 * Convert HTML to readable plain text, preserving structure.
 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  text = mainMatch?.[1] || articleMatch?.[1] || bodyMatch?.[1] || text;

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n');
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  text = text.replace(/<\/[uo]l>/gi, '\n');
  text = text.replace(/<[uo]l[^>]*>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/th>/gi, '\t');
  text = text.replace(/<\/td>/gi, '\t');
  text = text.replace(/<hr[^>]*>/gi, '\n---\n');
  text = text.replace(/<\/blockquote>/gi, '\n');
  text = text.replace(/<blockquote[^>]*>/gi, '\n> ');
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  text = text.replace(/<[^>]+>/g, '');

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Optional filesystem delegation. When an ACP client advertises `fs`
 * capability (Zed always does, VS Code may), the server should route
 * read/write through the client instead of touching disk directly — that
 * way the client's unsaved buffers, undo history, and virtual filesystems
 * stay authoritative. Callbacks must already use absolute paths.
 *
 * A writeTextFile that rejects with AcpRequestError means the client
 * answered and refused the write; the tool then fails instead of writing
 * to disk behind the editor.
 */
export interface FsCallbacks {
  readTextFile?: (absolutePath: string) => Promise<string>;
  writeTextFile?: (absolutePath: string, content: string) => Promise<void>;
}

/**
 * Execute a tool call and return the result.
 *
 * `fs` is optional — if provided and the relevant method is defined, file
 * read/write is delegated to the client. Otherwise we fall back to direct
 * disk I/O. A delegated call that throws also falls back to disk so a
 * single client hiccup doesn't kill the agent loop — except a write the
 * client explicitly refused, which fails the tool (see isRefusedWrite).
 *
 * `signal` stops a running execute_command when it fires.
 */
export async function executeTool(
  toolCall: ToolCall,
  projectRoot: string,
  fs?: FsCallbacks,
  mcpSessionId?: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = normalizeToolName(toolCall.tool);
  const parameters = toolCall.parameters;

  debug(`Executing tool: ${tool}`, parameters.path || parameters.command || '');

  // pre_tool_call hook runs first, even for MCP tools. A `pre_tool_call`
  // script is the policy gate (block writes to certain dirs, refuse risky
  // commands, deny outbound calls to specific MCP servers, etc.), so
  // letting MCP traffic bypass it would defeat the gate's purpose.
  // Failing closed is the safe default.
  const preHook = runHook({ event: 'pre_tool_call', workspaceRoot: projectRoot, toolName: tool, toolParams: parameters });
  if (preHook.blocked) {
    const msg = preHook.stderr?.trim() || preHook.stdout?.trim() || `pre_tool_call hook exited ${preHook.exitCode}`;
    return {
      success: false,
      output: '',
      error: `Blocked by pre_tool_call hook: ${msg}`,
      tool,
      parameters,
    };
  }

  // MCP-prefixed tool names (`<server>__<tool>`) route through the
  // per-session MCP registry. We still fire on_error so logging hooks
  // see MCP failures the same way they see built-in failures, but skip
  // post_edit — MCP tools aren't file-edit operations in the local sense
  // (they may do anything; we don't have enough info to call it an edit).
  //
  // IMPORTANT: lookup uses the RAW tool name from the model, not the
  // normalized one. `normalizeToolName` lowercases and converts hyphens
  // to underscores — fine for built-in tools, but it mangles MCP server
  // names that legitimately contain hyphens (e.g. `my-fs__read_file`
  // would become `my_fs__read_file` and miss the registry lookup).
  const rawTool = toolCall.tool;

  // invoke_skill — agent-driven skill bundle invocation. Returns the
  // bundle's SKILL.md body so the agent can read its instructions in
  // the next iteration. Project-scoped bundles win over global.
  if (rawTool === 'invoke_skill') {
    const name = String((parameters as Record<string, unknown>).name ?? '').trim();
    if (!name) {
      return { success: false, output: '', error: 'invoke_skill requires a `name` argument', tool: rawTool, parameters };
    }
    try {
      const { findSkillBundle } = await import('./skillBundles');
      const bundle = findSkillBundle(name, projectRoot);
      if (!bundle) {
        return { success: false, output: '', error: `Skill "${name}" not found. Use the catalog in your system prompt or ask the user to /skills bundles.`, tool: rawTool, parameters };
      }
      // Prefix the body with a header so the model sees clear framing.
      const output = `# Skill: ${bundle.name}\n_${bundle.description}_\n\n${bundle.body}`;
      return { success: true, output, tool: rawTool, parameters };
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message, tool: rawTool, parameters };
    }
  }

  if (isMcpToolName(rawTool) && mcpSessionId) {
    let result: ToolResult;
    try {
      // Virtual wrappers (resource_list / resource_read / prompt_list /
      // prompt_get) live in mcpRegistry alongside the real tools. We
      // dispatch them through their own helper so the registry stays the
      // single source of truth for what's namespaced under each server.
      const output = isVirtualMcpToolName(rawTool)
        ? await callSessionVirtualTool(mcpSessionId, rawTool, parameters)
        : await callSessionTool(mcpSessionId, rawTool, parameters);
      result = { success: true, output, tool: rawTool, parameters };
    } catch (err) {
      result = { success: false, output: '', error: (err as Error).message, tool: rawTool, parameters };
    }
    if (!result.success) {
      runHook({ event: 'on_error', workspaceRoot: projectRoot, toolName: rawTool, toolParams: parameters });
    }
    return result;
  }

  // Wrap the original dispatch so we can run on_error / post_edit hooks
  // around it without indenting every case.
  const result = await dispatchTool(tool, parameters, projectRoot, fs, toolCall, signal);

  if (!result.success) {
    runHook({
      event: 'on_error',
      workspaceRoot: projectRoot,
      toolName: tool,
      toolParams: parameters,
    });
  } else if (tool === 'write_file' || tool === 'edit_file') {
    const filePath = parameters.path as string | undefined;
    if (filePath) {
      const abs = isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
      // post_edit is advisory — non-zero exit doesn't roll back the write.
      // Typical use is `prettier --write "$CODEEP_HOOK_FILE"`.
      runHook({
        event: 'post_edit',
        workspaceRoot: projectRoot,
        toolName: tool,
        filePath: abs,
      });
    }
  }

  return result;
}

/**
 * True when the client answered fs/write_text_file with an error, i.e. it
 * received the write and said no (read-only buffer, rejected by the user…).
 * Writing the file to disk anyway would leave the editor and the disk
 * disagreeing, and the editor's next save would silently undo the change.
 * "Method not found" is the exception: the client does not implement the
 * method after all, which is the same as having no delegation. A timeout
 * or a broken transport is not an answer either, so both keep the disk
 * fallback.
 */
function isRefusedWrite(err: unknown): err is AcpRequestError {
  return err instanceof AcpRequestError && err.code !== -32601;
}

async function dispatchTool(
  tool: string,
  parameters: Record<string, unknown>,
  projectRoot: string,
  fs: FsCallbacks | undefined,
  toolCall: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'read_file': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        // Try client delegation first. The client owns the source of truth
        // for unsaved buffers, so we prefer it even if the file also exists
        // on disk. The 100 KB cap below is enforced on the delegated result
        // too — a malicious or misconfigured client could otherwise return
        // an arbitrarily large blob that blows up the agent's context.
        if (fs?.readTextFile) {
          try {
            const content = await fs.readTextFile(validation.absolutePath);
            // Cap is on character count, not raw bytes — JS strings are
            // UTF-16 in memory, so 100K chars ≈ 200K bytes of process
            // memory plus whatever the model context costs. Either way,
            // a 1GB blob from a misbehaving client gets rejected here.
            if (content.length > 100 * 1024) {
              return { success: false, output: '', error: `File too large (${content.length} chars via client). Max: 100K chars`, tool, parameters };
            }
            return { success: true, output: content, tool, parameters };
          } catch (err) {
            debug('fs/read_text_file delegation failed, falling back to disk:', err);
            // fall through to disk read
          }
        }

        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };

        const stat = statSync(validation.absolutePath);
        if (stat.isDirectory()) return { success: false, output: '', error: `Path is a directory, not a file: ${path}`, tool, parameters };
        if (stat.size > 100 * 1024) return { success: false, output: '', error: `File too large (${stat.size} bytes). Max: 100KB`, tool, parameters };

        return { success: true, output: readFileSync(validation.absolutePath, 'utf-8'), tool, parameters };
      }

      case 'write_file': {
        const path = parameters.path as string;
        let content = parameters.content as string;

        if (!path) {
          debug('write_file failed: missing path');
          return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };
        }
        if (content === undefined || content === null) {
          debug('write_file failed: content was undefined');
          return { success: false, output: '', error: 'File content was empty or truncated by the API. Try writing a smaller file or splitting into multiple writes.', tool, parameters };
        }

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        // Client delegation: lets editors keep dirty buffers, undo history,
        // and lint-on-save reactions consistent. The client is responsible
        // for creating parent directories — VS Code's WorkspaceEdit does;
        // for the disk fallback below we do it ourselves.
        // The undo record is taken before the write, so it holds what the
        // file was, and once only: a delegation that falls through to disk
        // keeps it. A write that never happens must not leave it behind.
        let rec: ActionRecord | null = null;
        if (fs?.writeTextFile) {
          try {
            const existed = existsSync(validation.absolutePath);
            rec = recordWrite(validation.absolutePath);
            await fs.writeTextFile(validation.absolutePath, content);
            recordResult(rec, content);
            return { success: true, output: `${existed ? 'Updated' : 'Created'} file: ${path}`, tool, parameters };
          } catch (err) {
            if (isRefusedWrite(err)) {
              discardAction(rec);
              return { success: false, output: '', error: `The editor refused to write ${path}: ${err.message}`, tool, parameters };
            }
            debug('fs/write_text_file delegation failed, falling back to disk:', err);
            // fall through to disk write
          }
        }

        const existed = existsSync(validation.absolutePath);
        if (!rec) rec = recordWrite(validation.absolutePath);
        try {
          const dir = dirname(validation.absolutePath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(validation.absolutePath, content, 'utf-8');
        } catch (err) {
          discardAction(rec);
          throw err;
        }
        recordResult(rec, content);
        return { success: true, output: `${existed ? 'Updated' : 'Created'} file: ${path}`, tool, parameters };
      }

      case 'edit_file': {
        const path = parameters.path as string;
        const oldText = parameters.old_text as string;
        const newText = parameters.new_text as string;

        if (!path || oldText === undefined || newText === undefined) {
          return { success: false, output: '', error: 'Missing required parameters', tool, parameters };
        }

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        // Read through the client when delegation is available — the dirty
        // buffer in the editor is the authoritative version for an edit.
        let content: string;
        let readDelegated = false;
        if (fs?.readTextFile) {
          try {
            content = await fs.readTextFile(validation.absolutePath);
            readDelegated = true;
          } catch (err) {
            debug('fs/read_text_file (in edit_file) failed, falling back to disk:', err);
            if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };
            content = readFileSync(validation.absolutePath, 'utf-8');
          }
        } else {
          if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `File not found: ${path}`, tool, parameters };
          content = readFileSync(validation.absolutePath, 'utf-8');
        }

        if (!content.includes(oldText)) {
          return { success: false, output: '', error: 'Text not found in file. Make sure old_text matches exactly.', tool, parameters };
        }

        let matchCount = 0;
        let searchPos = 0;
        while ((searchPos = content.indexOf(oldText, searchPos)) !== -1) {
          matchCount++;
          searchPos += oldText.length;
        }

        if (matchCount > 1) {
          return { success: false, output: '', error: `old_text matches ${matchCount} locations in the file. Provide more surrounding context to make it unique (only 1 match allowed).`, tool, parameters };
        }

        // Recorded before the write; dropped again if the write never happens.
        const rec = recordEdit(validation.absolutePath);
        // Function replacer so newText is written literally — a plain-string
        // replacement interprets $&, $1, $$ etc., which silently corrupts any
        // edit whose new_text contains `$` (shell vars, template literals, regex).
        const updated = content.replace(oldText, () => newText);

        if (fs?.writeTextFile) {
          try {
            await fs.writeTextFile(validation.absolutePath, updated);
            recordResult(rec, updated);
            return { success: true, output: `Edited file: ${path}`, tool, parameters };
          } catch (err) {
            if (isRefusedWrite(err)) {
              discardAction(rec);
              return { success: false, output: '', error: `The editor refused to write ${path}: ${err.message}`, tool, parameters };
            }
            debug('fs/write_text_file (in edit_file) failed, falling back to disk:', err);
            // If we read through the client but write back to disk, the
            // editor's dirty buffer could be discarded next save. Log and
            // continue — better than silently dropping the edit.
            if (readDelegated) debug('warning: edit_file read via client but writing to disk');
          }
        }
        try {
          writeFileSync(validation.absolutePath, updated, 'utf-8');
        } catch (err) {
          discardAction(rec);
          throw err;
        }
        recordResult(rec, updated);
        return { success: true, output: `Edited file: ${path}`, tool, parameters };
      }

      case 'delete_file': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };
        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `Path not found: ${path}`, tool, parameters };

        recordDelete(validation.absolutePath);
        const stat = statSync(validation.absolutePath);
        if (stat.isDirectory()) {
          rmSync(validation.absolutePath, { recursive: true, force: true });
          return { success: true, output: `Deleted directory: ${path}`, tool, parameters };
        } else {
          unlinkSync(validation.absolutePath);
          return { success: true, output: `Deleted file: ${path}`, tool, parameters };
        }
      }

      case 'list_files': {
        const path = (parameters.path as string) || '.';
        const recursive = (parameters.recursive as boolean) || false;

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };
        if (!existsSync(validation.absolutePath)) return { success: false, output: '', error: `Directory not found: ${path}`, tool, parameters };

        const stat = statSync(validation.absolutePath);
        if (!stat.isDirectory()) return { success: false, output: '', error: `Path is not a directory: ${path}`, tool, parameters };

        const files = listDirectory(validation.absolutePath, projectRoot, recursive);
        return { success: true, output: files.join('\n'), tool, parameters };
      }

      case 'create_directory': {
        const path = parameters.path as string;
        if (!path) return { success: false, output: '', error: 'Missing required parameter: path', tool, parameters };

        const validation = validatePath(path, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        if (existsSync(validation.absolutePath)) {
          const stat = statSync(validation.absolutePath);
          if (stat.isDirectory()) return { success: true, output: `Directory already exists: ${path}`, tool, parameters };
          return { success: false, output: '', error: `Path exists but is a file: ${path}`, tool, parameters };
        }

        recordMkdir(validation.absolutePath);
        mkdirSync(validation.absolutePath, { recursive: true });
        return { success: true, output: `Created directory: ${path}`, tool, parameters };
      }

      case 'execute_command': {
        const command = parameters.command as string;
        const args = (parameters.args as string[]) || [];

        if (!command) return { success: false, output: '', error: 'Missing required parameter: command', tool, parameters };

        // A command is the one thing in a run that can move this repository's
        // hooks — `git config core.hooksPath .evil` — without any write the
        // gate above sees. Drop the cached answer before it runs, so the next
        // `write_file .evil/pre-commit` asks git again rather than trusting
        // where the hooks were a moment ago.
        forgetHooksDirectory();

        // Command throttle — guards against agent loops that spawn commands
        // every iteration (each can be up to 2 minutes of subprocess time).
        // Rate-limited *after* permission resolution: an allowed command
        // consumes budget, a denied one never reaches here.
        const cmdRate = checkCommandRateLimit();
        if (!cmdRate.allowed) {
          return { success: false, output: '', error: cmdRate.message || 'Command rate limit exceeded', tool, parameters };
        }

        recordCommand(command, args);

        const result = await executeCommandAsync(command, args, {
          cwd: projectRoot,
          projectRoot,
          timeout: 120000,
          signal,
        });

        if (result.success) return { success: true, output: result.stdout || '(no output)', tool, parameters };
        return { success: false, output: result.stdout, error: result.stderr, tool, parameters };
      }

      case 'search_code': {
        const pattern = parameters.pattern as string;
        const searchPath = (parameters.path as string) || '.';

        if (!pattern) return { success: false, output: '', error: 'Missing required parameter: pattern', tool, parameters };

        const validation = validatePath(searchPath, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        const result = await executeCommandAsync('grep', ['-rn', '--include=*.{ts,tsx,js,jsx,json,md,css,html,py,go,rs,rb,kt,kts,swift,php,java,cs,c,cpp,h,hpp,vue,svelte,yaml,yml,toml,sh,sql,xml,scss,less}', pattern, validation.absolutePath], {
          cwd: projectRoot,
          projectRoot,
          timeout: 30000,
        });

        if (result.exitCode === 0) {
          const lines = result.stdout.split('\n').slice(0, 50);
          return { success: true, output: lines.join('\n') || 'No matches found', tool, parameters };
        } else if (result.exitCode === 1) {
          return { success: true, output: 'No matches found', tool, parameters };
        }
        return { success: false, output: '', error: result.stderr || 'Search failed', tool, parameters };
      }

      case 'find_files': {
        const pattern = parameters.pattern as string;
        const searchPath = (parameters.path as string) || '.';

        if (!pattern) return { success: false, output: '', error: 'Missing required parameter: pattern', tool, parameters };

        const validation = validatePath(searchPath, projectRoot);
        if (!validation.valid) return { success: false, output: '', error: validation.error, tool, parameters };

        const findArgs: string[] = [validation.absolutePath, '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.codeep', '-o', '-name', 'dist', '-o', '-name', 'build', '-o', '-name', '.next', ')', '-prune', '-o'];

        if (pattern.includes('/')) {
          findArgs.push('-path', `*/${pattern}`, '-print');
        } else {
          findArgs.push('-name', pattern, '-print');
        }

        const result = await executeCommandAsync('find', findArgs, { cwd: projectRoot, projectRoot, timeout: 15000 });

        if (result.exitCode === 0 || result.stdout) {
          const files = result.stdout.split('\n').filter(Boolean);
          const relativePaths = files.map(f => relative(projectRoot, f) || f).slice(0, 100);
          if (relativePaths.length === 0) return { success: true, output: `No files matching "${pattern}"`, tool, parameters };
          return { success: true, output: `Found ${relativePaths.length} file(s):\n${relativePaths.join('\n')}`, tool, parameters };
        }
        return { success: false, output: '', error: result.stderr || 'Find failed', tool, parameters };
      }

      case 'fetch_url': {
        const url = parameters.url as string;
        if (!url) return { success: false, output: '', error: 'Missing required parameter: url', tool, parameters };

        // Every redirect hop is SSRF-checked and pinned — see guardedFetch.ts.
        const result = await fetchUrlGuarded(url, (args) => executeCommandAsync('curl', args, {
          cwd: projectRoot,
          projectRoot,
          timeout: 35000,
        }));

        if (result.ok) {
          let content = result.body;
          if (content.includes('<html') || content.includes('<!DOCTYPE')) {
            content = htmlToText(content);
          }
          if (content.length > 10000) content = content.substring(0, 10000) + '\n\n... (truncated)';
          return { success: true, output: content, tool, parameters };
        }
        return { success: false, output: '', error: result.error, tool, parameters };
      }

      // === Z.AI MCP Tools ===

      case 'web_search': {
        const mcpConfig = getZaiMcpConfig();
        if (!mcpConfig) return { success: false, output: '', error: 'web_search requires a Z.AI API key. Configure one via /provider z.ai', tool, parameters };

        const query = parameters.query as string;
        if (!query) return { success: false, output: '', error: 'Missing required parameter: query', tool, parameters };

        const args: Record<string, unknown> = { search_query: query };
        if (parameters.domain_filter) args.search_domain_filter = parameters.domain_filter;
        if (parameters.recency) args.search_recency_filter = parameters.recency;

        const result = await callZaiMcp(mcpConfig.endpoints.webSearch, 'webSearchPrime', args, mcpConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'web_read': {
        const mcpConfig = getZaiMcpConfig();
        if (!mcpConfig) return { success: false, output: '', error: 'web_read requires a Z.AI API key. Configure one via /provider z.ai', tool, parameters };

        const url = parameters.url as string;
        if (!url) return { success: false, output: '', error: 'Missing required parameter: url', tool, parameters };
        try { new URL(url); } catch { return { success: false, output: '', error: 'Invalid URL format', tool, parameters }; }

        const args: Record<string, unknown> = { url };
        if (parameters.format) args.return_format = parameters.format;

        const result = await callZaiMcp(mcpConfig.endpoints.webReader, 'webReader', args, mcpConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'github_read': {
        const mcpConfig = getZaiMcpConfig();
        if (!mcpConfig) return { success: false, output: '', error: 'github_read requires a Z.AI API key. Configure one via /provider z.ai', tool, parameters };

        const repo = parameters.repo as string;
        const action = parameters.action as string;
        if (!repo) return { success: false, output: '', error: 'Missing required parameter: repo', tool, parameters };
        if (!repo.includes('/')) return { success: false, output: '', error: 'Invalid repo format. Use owner/repo (e.g. facebook/react)', tool, parameters };
        if (!action || !['search', 'tree', 'read_file'].includes(action)) {
          return { success: false, output: '', error: 'Invalid action. Must be: search, tree, or read_file', tool, parameters };
        }

        let mcpToolName: string;
        const args: Record<string, unknown> = { repo_name: repo };

        if (action === 'search') {
          mcpToolName = 'search_doc';
          const query = parameters.query as string;
          if (!query) return { success: false, output: '', error: 'Missing required parameter: query (for action=search)', tool, parameters };
          args.query = query;
        } else if (action === 'tree') {
          mcpToolName = 'get_repo_structure';
          if (parameters.path) args.dir_path = parameters.path;
        } else {
          mcpToolName = 'read_file';
          const filePath = parameters.path as string;
          if (!filePath) return { success: false, output: '', error: 'Missing required parameter: path (for action=read_file)', tool, parameters };
          args.file_path = filePath;
        }

        const result = await callZaiMcp(mcpConfig.endpoints.zread, mcpToolName, args, mcpConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      // === MiniMax MCP Tools ===

      case 'minimax_web_search': {
        const mmConfig = getMinimaxMcpConfig();
        if (!mmConfig) return { success: false, output: '', error: 'minimax_web_search requires a MiniMax API key. Configure one via /provider minimax', tool, parameters };

        const query = parameters.query as string;
        if (!query) return { success: false, output: '', error: 'Missing required parameter: query', tool, parameters };

        const result = await callMinimaxApi(mmConfig.host, '/v1/coding_plan/search', { q: query }, mmConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'zai_analyze_image': {
        const zaiVisionConfig = getZaiVisionConfig();
        if (!zaiVisionConfig) return { success: false, output: '', error: 'zai_analyze_image requires a Z.AI API key. Configure one via /provider z.ai-api', tool, parameters };

        const prompt = parameters.prompt as string;
        const imageUrl = parameters.image_url as string;
        if (!prompt) return { success: false, output: '', error: 'Missing required parameter: prompt', tool, parameters };
        if (!imageUrl) return { success: false, output: '', error: 'Missing required parameter: image_url', tool, parameters };

        const result = await callZaiVisionApi(zaiVisionConfig.baseUrl, zaiVisionConfig.apiKey, prompt, imageUrl);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      case 'minimax_understand_image': {
        const mmConfig = getMinimaxMcpConfig();
        if (!mmConfig) return { success: false, output: '', error: 'minimax_understand_image requires a MiniMax API key. Configure one via /provider minimax', tool, parameters };

        const prompt = parameters.prompt as string;
        const imageUrl = parameters.image_url as string;
        if (!prompt) return { success: false, output: '', error: 'Missing required parameter: prompt', tool, parameters };
        if (!imageUrl) return { success: false, output: '', error: 'Missing required parameter: image_url', tool, parameters };

        const result = await callMinimaxApi(mmConfig.host, '/v1/coding_plan/vlm', { prompt, image_url: imageUrl }, mmConfig.apiKey);
        const output = result.length > 15000 ? result.substring(0, 15000) + '\n\n... (truncated)' : result;
        return { success: true, output, tool, parameters };
      }

      default:
        return { success: false, output: '', error: `Unknown tool: ${tool}`, tool, parameters };
    }
  } catch (error) {
    const err = error as Error;
    return { success: false, output: '', error: err.message, tool, parameters };
  }
}

/**
 * Create action log from tool result
 */
export function createActionLog(toolCall: ToolCall, result: ToolResult): ActionLog {
  const normalizedTool = normalizeToolName(toolCall.tool);

  const typeMap: Record<string, ActionLog['type']> = {
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    delete_file: 'delete',
    execute_command: 'command',
    search_code: 'search',
    list_files: 'list',
    create_directory: 'mkdir',
    find_files: 'search',
    fetch_url: 'fetch',
    web_search: 'fetch',
    web_read: 'fetch',
    github_read: 'fetch',
    minimax_web_search: 'fetch',
    minimax_understand_image: 'fetch',
  };

  const target = (toolCall.parameters.path as string) ||
    (toolCall.parameters.command as string) ||
    (toolCall.parameters.pattern as string) ||
    (toolCall.parameters.url as string) ||
    (toolCall.parameters.query as string) ||
    (toolCall.parameters.repo as string) ||
    'unknown';

  let details: string | undefined;
  if (result.success) {
    if (normalizedTool === 'write_file' && toolCall.parameters.content) {
      details = toolCall.parameters.content as string;
    } else if (normalizedTool === 'edit_file' && toolCall.parameters.new_text) {
      details = toolCall.parameters.new_text as string;
    } else if (normalizedTool === 'execute_command') {
      details = result.output.slice(0, 1000);
    } else {
      details = result.output.slice(0, 500);
    }
  } else {
    details = result.error;
  }

  return {
    type: typeMap[normalizedTool] || 'command',
    target,
    result: result.success ? 'success' : 'error',
    details,
    timestamp: Date.now(),
  };
}
