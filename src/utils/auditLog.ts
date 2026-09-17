/**
 * Audit record — what an agent actually touched.
 *
 * Distinct from `history.ts`, which exists to undo things: that journal keeps
 * file contents so a write can be reversed, records only mutations, and lives
 * in `~/.codeep/history/`. This one answers a different question — *what did
 * this agent do to this project* — so it records reads and refusals too, keeps
 * no file contents at all, and lives with the project it describes.
 *
 * The most valuable entry is the one nothing recorded before: a tool call the
 * capability boundary refused. A boundary you cannot audit is a boundary you
 * have to take on faith.
 *
 * Format is JSON Lines. Appending one line per event survives a crash mid-run,
 * needs no read-modify-write, and stays greppable without a parser.
 *
 * PRIVACY: entries carry command lines, file paths and MCP tool arguments, not
 * file contents. A command or an argument can still contain a secret someone
 * typed into it, exactly as shell history can — treat the directory like shell
 * history, not like source.
 *
 * It sits under `.codeep/`, which most projects already ignore, but Codeep does
 * not edit anyone's `.gitignore` and this module must not claim otherwise. If a
 * project tracks `.codeep/`, the audit log will be committed with it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { appendProjectFile } from './projectPaths.js';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { config } from '../config/index.js';

/** One thing an agent did, or was stopped from doing. */
export interface AuditEvent {
  /** Epoch millis. */
  ts: number;
  /** Groups every event from one agent run. */
  run: string;
  /** Provider-facing tool name, e.g. `read_file`. Absent on run markers. */
  tool?: string;
  /** What kind of thing happened. `refused` is a boundary denial. */
  action: 'run-start' | 'run-end' | 'read' | 'write' | 'edit' | 'delete'
        | 'command' | 'search' | 'list' | 'mkdir' | 'fetch' | 'refused';
  /** File path, command line, or URL — truncated, never file contents. */
  target?: string;
  outcome?: 'ok' | 'error' | 'refused';
  /** Short reason or note. Never a file body. */
  detail?: string;
  /** Run markers only: the active custom bot and what it was granted. */
  agent?: string;
  capabilities?: string[];
  prompt?: string;
}

/** Arguments that carry a file body. They are never part of a target. Names
 *  are compared without `_`/`-` and case, so `newText` is `new_text`. */
const CONTENT_ARGUMENTS = new Set([
  'content', 'contents', 'filecontent', 'filecontents', 'filetext', 'body',
  'oldstring', 'newstring', 'oldstr', 'newstr', 'oldtext', 'newtext',
  'oldcontent', 'newcontent', 'replacement', 'patch', 'diff',
]);
/** Argument names whose value is a credential, compared without `_`/`-` and
 *  case. `token` is judged separately: most `*_token` arguments are secrets,
 *  but a page or continuation token is a cursor the user should see. */
const SECRET_ARGUMENT = /passw|passphrase|secret|apikey|accesskey|privatekey|authorization|credential|cookie/;
const CURSOR_TOKEN_QUALIFIERS = new Set(['page', 'next', 'prev', 'previous', 'continuation', 'cursor', 'sync', 'max', 'min', 'num', 'total', 'count']);
/**
 * Values shaped like a well-known credential, whatever the argument is called.
 * Each alternative consumes the whole credential, because only the matched
 * text is replaced: a pattern that stopped after the prefix would leave the
 * rest of the key on screen.
 */
const SECRET_VALUE = /\b[sr]k[-_](?:live|test|proj|ant)[-_][\w-]+|\bsk-[\w-]{20,}|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bBearer\s+[\w.~+/=-]{16,}/gi;
/** Longest single argument shown. The permission prompt lays out what is
 *  left and says what it drops, so this only bounds a pathological value. */
const MAX_ARGUMENT = 2000;

/** The words of an argument name: `page_token`, `pageToken`, `PAGE-TOKEN`. */
function nameWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/).filter(Boolean);
}

/** True when an argument's name says its value is a credential. */
function isCredentialName(key: string): boolean {
  const words = nameWords(key);
  if (SECRET_ARGUMENT.test(words.join(''))) return true;
  return words.some((w, i) => (w === 'token' || w === 'tokens') && !(i > 0 && CURSOR_TOKEN_QUALIFIERS.has(words[i - 1])));
}

/** A plain value as it should appear: flattened, known credential shapes
 *  replaced where they occur, the rest left readable. */
function showValue(value: string | number | boolean): string {
  let text = String(value).replace(SECRET_VALUE, '[redacted]').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_ARGUMENT) text = `${text.slice(0, MAX_ARGUMENT)}…[+${text.length - MAX_ARGUMENT} chars]`;
  return text;
}

function isPlain(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * An MCP tool's arguments, as `name=value` pairs in the order given. The
 * argument names are the server's, not the built-in `command`/`path`/`url`
 * ones: `postgres__query` carries its SQL in `sql`, and a call described by
 * its name alone would be approved in the permission prompt unseen.
 *
 * Plain values and lists of plain values are shown — an exec tool's `args`
 * is what it will run. A list holding objects, or an object, is where servers
 * put file bodies under names of their own (`files[].content`,
 * `edits[].newText`), so it is counted, never printed.
 */
function describeMcpArguments(p: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(p)) {
    const name = key.toLowerCase().replace(/[-_]/g, '');
    if (CONTENT_ARGUMENTS.has(name) || value === undefined || value === null) continue;
    if (isCredentialName(key) && (isPlain(value) || Array.isArray(value))) {
      parts.push(`${key}=[redacted]`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(value.every(isPlain)
        ? `${key}=${value.map(showValue).join(' ')}`
        : `${key}=[${value.length} ${value.length === 1 ? 'item' : 'items'}]`);
      continue;
    }
    if (typeof value === 'object') {
      const size = Object.keys(value).length;
      parts.push(`${key}={${size} ${size === 1 ? 'key' : 'keys'}}`);
      continue;
    }
    parts.push(`${key}=${showValue(value as string | number | boolean)}`);
  }
  return parts.join(', ');
}

/** A one-line, content-free description of what a tool call was aimed at.
 *  Paths, commands and URLs are the point of the record; file bodies are not,
 *  and `content`/`old_string` style arguments are never read here. */
export function describeAuditTarget(call: { tool: string; parameters: Record<string, unknown> }): string {
  const p = call.parameters ?? {};
  const str = (k: string) => (typeof p[k] === 'string' ? p[k] as string : undefined);

  // MCP tools (`<server>__<tool>`; no built-in name contains `__`).
  if (call.tool.includes('__')) return describeMcpArguments(p) || call.tool;

  const command = str('command');
  if (command) {
    const args = Array.isArray(p.args) ? p.args.map(String) : [];
    return [command, ...args].join(' ');
  }
  return str('path') ?? str('url') ?? str('pattern') ?? str('query') ?? str('directory') ?? call.tool;
}

const MAX_TARGET = 300;
const MAX_DETAIL = 200;
const MAX_PROMPT = 400;

function auditDir(projectRoot: string): string {
  return join(projectRoot, '.codeep', 'audit');
}

/** One file per day keeps a long-lived project from growing a single huge log
 *  while staying trivial to find — no index, no rotation logic. */
function auditFile(projectRoot: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(auditDir(projectRoot), `${day}.jsonl`);
}

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Audit is on unless explicitly disabled. A record you have to remember to
 *  switch on is not a record you can rely on having. */
export function isAuditEnabled(): boolean {
  return config.get('auditLog') !== false;
}

/**
 * Append one event. Never throws: an unwritable project (read-only checkout,
 * full disk, a directory we lack permission for) must not take the agent down
 * with it. A missing audit line is a gap in the record; a crashed run is worse.
 */
export function recordAuditEvent(projectRoot: string, event: AuditEvent): void {
  if (!isAuditEnabled()) return;
  try {
    const line: AuditEvent = {
      ...event,
      target: clip(event.target, MAX_TARGET),
      detail: clip(event.detail, MAX_DETAIL),
      prompt: clip(event.prompt, MAX_PROMPT),
    };
    // Drop undefined keys so a line stays small and diffs stay readable.
    const compact = Object.fromEntries(
      Object.entries(line).filter(([, v]) => v !== undefined),
    );
    // .codeep/ can come with a cloned repo: never append through a symlink.
    appendProjectFile(projectRoot, auditFile(projectRoot), JSON.stringify(compact) + '\n');
  } catch {
    /* an unwritable (or symlinked) audit log must never fail the run */
  }
}

/** Open a run and return its id. Records the agent and the capabilities it was
 *  granted, so a later reader can tell what the boundary *was* at the time —
 *  a bot edited afterwards must not rewrite the history of what it could do. */
export function beginAuditRun(
  projectRoot: string,
  opts: { prompt: string; agent?: string; capabilities?: string[] },
): string {
  const run = randomBytes(6).toString('hex');
  recordAuditEvent(projectRoot, {
    ts: Date.now(),
    run,
    action: 'run-start',
    prompt: opts.prompt,
    agent: opts.agent,
    capabilities: opts.capabilities,
  });
  return run;
}

export function endAuditRun(
  projectRoot: string,
  run: string,
  outcome: 'ok' | 'error',
  detail?: string,
): void {
  recordAuditEvent(projectRoot, { ts: Date.now(), run, action: 'run-end', outcome, detail });
}

/** One run, reassembled from its lines. */
export interface AuditRun {
  run: string;
  startedAt: number;
  endedAt?: number;
  prompt?: string;
  agent?: string;
  capabilities?: string[];
  outcome?: 'ok' | 'error';
  events: AuditEvent[];
  refusals: number;
}

/**
 * Read back the most recent runs, newest first.
 *
 * Malformed lines are skipped rather than throwing: an append-only log written
 * by a process that may be killed mid-write will occasionally end in a partial
 * line, and one torn line must not make the whole record unreadable.
 */
export function readAuditRuns(projectRoot: string, limit = 20): AuditRun[] {
  const dir = auditDir(projectRoot);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const runs = new Map<string, AuditRun>();
  for (const file of files) {
    let raw: string;
    try {
      const path = join(dir, file);
      if (statSync(path).size > 8 * 1024 * 1024) continue; // skip an absurd file
      raw = readFileSync(path, 'utf8');
    } catch { continue; }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: AuditEvent;
      try { event = JSON.parse(line) as AuditEvent; } catch { continue; }
      if (!event || typeof event.run !== 'string' || typeof event.ts !== 'number') continue;

      let entry = runs.get(event.run);
      if (!entry) {
        entry = { run: event.run, startedAt: event.ts, events: [], refusals: 0 };
        runs.set(event.run, entry);
      }
      if (event.action === 'run-start') {
        entry.startedAt = event.ts;
        entry.prompt = event.prompt;
        entry.agent = event.agent;
        entry.capabilities = event.capabilities;
      } else if (event.action === 'run-end') {
        entry.endedAt = event.ts;
        entry.outcome = event.outcome === 'error' ? 'error' : 'ok';
      } else {
        entry.events.push(event);
        if (event.action === 'refused') entry.refusals++;
      }
    }
    if (runs.size >= limit * 2) break; // enough files read to satisfy `limit`
  }

  return [...runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

/** Render recent runs for `/audit`. Deliberately compact: the question this
 *  answers is "what has been happening here", and a wall of every event
 *  answers it worse than a summary with the refusals called out. */
export function formatAuditLog(projectRoot: string, limit = 10): string {
  const runs = readAuditRuns(projectRoot, limit);
  if (runs.length === 0) {
    return isAuditEnabled()
      ? 'No agent runs recorded in this project yet.\n\nThe record starts at the next run and lives in `.codeep/audit/`.'
      : 'Audit recording is off for this project. Turn it on with `/audit on`.';
  }

  const lines: string[] = ['**Recent agent runs** — `.codeep/audit/`', ''];
  for (const run of runs) {
    const when = new Date(run.startedAt).toLocaleString();
    const took = run.endedAt ? `${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s` : 'unfinished';
    const who = run.agent ? `**${run.agent}**` : 'default agent';
    const grant = run.capabilities?.length ? ` (${run.capabilities.join(', ')})` : '';
    const mark = run.outcome === 'error' ? '✗' : '✓';

    lines.push(`${mark} ${when} · ${who}${grant} · ${took}`);
    if (run.prompt) lines.push(`   ${run.prompt}`);

    // Summarise by action so a hundred reads collapse to "read ×100".
    const tally = new Map<string, number>();
    for (const e of run.events) tally.set(e.action, (tally.get(e.action) ?? 0) + 1);
    const summary = [...tally.entries()].map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)).join(', ');
    if (summary) lines.push(`   ${summary}`);

    // Refusals are the reason this record exists, so they are never collapsed.
    for (const e of run.events.filter(e => e.action === 'refused')) {
      lines.push(`   ⨯ refused: ${e.tool}${e.target ? ` → ${e.target}` : ''}`);
    }
    lines.push('');
  }
  lines.push('_Paths and commands only — file contents are never recorded._');
  return lines.join('\n');
}
