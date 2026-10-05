/**
 * The usage ledger: a local, content-free record of what Codeep used.
 *
 * One line per event in `~/.codeep/usage/<YYYY-MM>.jsonl`:
 *
 *   {"t":…,"k":"u","p":"z.ai","m":"glm-5.3","in":…,"out":…,"cr":…,"cw":…}
 *   {"t":…,"k":"p","s":"b523af5fb0bdffb2","src":"tui"}
 *
 * A `u` line for every model call recordTokenUsage sees — the one place they
 * all pass, from the TUI, ACP, `codeep review --ai`, MCP sampling and the
 * one-shot helpers alike, so the calls `/cost` counts — and a `p` line for
 * every user prompt that goes to a model (the TUI's chat and agent paths,
 * the ACP prompt and the ACP commands that run the agent). Counts, a model
 * id, a provider id and a hash of the session id: never prompt text, file
 * paths or content. Omarchy's Agents panel is told what Codeep used from
 * these lines (renderer/omarchyAgents.ts). Counting starts with the release
 * that wrote the first one; nothing before it is reconstructed.
 *
 * A month is the event's LOCAL month, as a day is its local day: someone
 * who codes until 1am is still on the day they started in, wherever UTC is.
 *
 * Best effort throughout. Appends sit on the request path, so nothing here
 * throws into a caller: a home that cannot hold `~/.codeep` simply records
 * nothing, and the session goes on.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { TokenUsage } from './tokenTracker';
import { logger } from './logger';

// Debug logging helper - writes to log file when CODEEP_DEBUG=1
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

/** Where a prompt came from: the terminal UI, or an editor over ACP. */
export type PromptSource = 'tui' | 'acp';

type UsageLine = { t: number; k: 'u'; p: string; m: string; in: number; out: number; cr: number; cw: number };
type PromptLine = { t: number; k: 'p'; s: string; src: string };
type LedgerLine = UsageLine | PromptLine;

/** The tokens one model used, in the field names of Omarchy's records. */
export interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface UsageSummary {
  totalPrompts: number;
  /** Distinct sessions (by the hash of their id), across every month. */
  totalSessions: number;
  /** Local `YYYY-MM-DD` dates with at least one line of either kind, sorted. */
  activeDates: string[];
  activeDays: number;
  /** By model, with any `vendor/` prefix already taken off. */
  modelUsage: Record<string, ModelTokens>;
  /** The provider id of the most recent usage line; null before the first. */
  lastProvider: string | null;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** `~/.codeep/usage`. Resolved on every call, so a test's HOME is the one used. */
export function usageLedgerDir(home: string = homedir()): string {
  return join(home, '.codeep', 'usage');
}

/** `YYYY-MM.jsonl` for the LOCAL month `t` falls in. */
export function ledgerFileName(t: number): string {
  const date = new Date(t);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}.jsonl`;
}

/**
 * The model as the ledger keys it: the id with any `vendor/` prefix taken
 * off (`anthropic/claude-sonnet-5.5` → `claude-sonnet-5.5`), so OpenRouter's
 * ids and the vendor's own land on one model, and Omarchy's name prettifier
 * — which knows nothing of prefixes — reads it. Only the prefix: unlike
 * canonicalContextKey, the case and the dots stay as the id has them.
 */
export function ledgerModelKey(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
}

/**
 * The input tokens that were neither read from nor written to the cache.
 *
 * Every extractor hands recordTokenUsage a `promptTokens` that INCLUDES both
 * (OpenAI-protocol `prompt_tokens` and Responses `input_tokens` count them
 * inside; extractAnthropicUsage adds Anthropic's separate fields back in), and
 * Omarchy's panel adds input, output, cache reads and cache writes together.
 * Stored whole, every cached token would be counted twice.
 */
export function uncachedInputTokens(usage: TokenUsage): number {
  return Math.max(0, count(usage.promptTokens) - count(usage.cacheReadTokens) - count(usage.cacheCreationTokens));
}

/** A model call, as recordTokenUsage saw it. Never throws. */
export function recordUsageInLedger(usage: TokenUsage, model: string, provider: string, t: number = Date.now()): void {
  try {
    append({
      t,
      k: 'u',
      p: String(provider),
      m: ledgerModelKey(String(model)),
      in: uncachedInputTokens(usage),
      out: count(usage.completionTokens),
      cr: count(usage.cacheReadTokens),
      cw: count(usage.cacheCreationTokens),
    });
  } catch (err) {
    debug('Usage ledger: could not record usage:', err);
  }
}

/**
 * A user prompt, as it goes to the model. Called once per prompt by the
 * entry points that send one — never by anything Codeep asks a model on its
 * own (titles, commit messages, summaries, a fix after a failed check). Never
 * throws.
 */
export function recordPromptInLedger(sessionId: string, src: PromptSource, t: number = Date.now()): void {
  try {
    append({ t, k: 'p', s: sessionKey(String(sessionId)), src });
  } catch (err) {
    debug('Usage ledger: could not record a prompt:', err);
  }
}

/**
 * A session id as the ledger keeps it: the first 16 hex digits of its
 * SHA-256. Ids are not always opaque — /rename makes a TUI session's id the
 * name typed for it, and ACP's session/load registers a saved session's name
 * as the id — and the ledger keeps no names, here or in cache.json, which is
 * built from these lines. Hashed when the line is written, so the name never
 * reaches the disk. No salt, on purpose: one session has to hash alike in the
 * TUI and in an ACP server, and in every month, or it would count once per
 * process and per month. That keeps a name out of the file; it does not make
 * a name that can be guessed impossible to check against it.
 */
function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

/**
 * Owner-only, as Omarchy's updater leaves its agents' records (its mktemp
 * makes them 0600): when Codeep was used, and on what, is nobody else's to
 * read on a shared machine. Given when a file or the directory is created —
 * which is the only time a mode applies — so nothing already there changes.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Called after every line that reached the ledger. */
const appendListeners = new Set<() => void>();

/**
 * Hear about every line appended in this process — what keeps Omarchy's
 * record current without the ledger knowing Omarchy exists. Returns the
 * function that stops it.
 */
export function onLedgerAppend(listener: () => void): () => void {
  appendListeners.add(listener);
  return () => { appendListeners.delete(listener); };
}

function append(line: LedgerLine): void {
  let dir: string;
  try {
    dir = usageLedgerDir();
    // ~/.codeep as the rest of Codeep makes it; only the ledger's own
    // directory owner-only.
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch {
    // No ~/.codeep to keep it in (a read-only home, a file in its place):
    // there is nowhere to record, and nothing to tell the user about.
    return;
  }
  // O_APPEND: the kernel puts every write at the end of the file as it is at
  // that moment, so the TUI and an ACP server appending at once interleave
  // whole lines instead of writing over each other's. One small line is one
  // write, synchronous because it is cheap and must not be lost to an exit.
  appendFileSync(join(dir, ledgerFileName(line.t)), JSON.stringify(line) + '\n', { flag: 'a', mode: FILE_MODE });
  for (const listener of appendListeners) {
    try {
      listener();
    } catch (err) {
      debug('Usage ledger: a listener failed:', err);
    }
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** A month's lines, added up. What cache.json keeps for a month that is over. */
interface MonthTotals {
  prompts: number;
  /** The sessions (as the ledger has them, hashed), not their number: one
   *  that runs over midnight at the end of a month is in both months and is
   *  still one session. */
  sessions: string[];
  dates: string[];
  models: Record<string, ModelTokens>;
  /** The month's most recent usage line. */
  last: { t: number; p: string } | null;
}

/** A closed month in the cache: its totals, and the file they were read from. */
interface CachedMonth extends MonthTotals {
  size: number;
  mtimeMs: number;
}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
const CACHE_FILE = 'cache.json';
const CACHE_VERSION = 1;

/**
 * Everything in the ledger, all time.
 *
 * Months before the current one no longer change, so their totals come from
 * `cache.json` for as long as the file's size and mtime are the ones they
 * were read at — a write to the record would otherwise re-read a year of
 * lines each time. The current month is always read: it is the one being
 * appended to. A cache that cannot be read or makes no sense is ignored and
 * written anew, and a line that is not a whole, well-formed event (a crash
 * mid-write, an edit by hand) is skipped. Never throws.
 */
export function readUsageSummary(options: { dir?: string; now?: number } = {}): UsageSummary {
  const months: MonthTotals[] = [];
  try {
    const dir = options.dir ?? usageLedgerDir();
    const current = ledgerFileName(options.now ?? Date.now());
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter(name => MONTH_FILE.test(name)).sort();
    } catch {
      // No ledger yet.
    }
    const cached = readCache(dir);
    const keep = new Map<string, CachedMonth>();
    let changed = false;
    for (const name of names) {
      const file = join(dir, name);
      const closed = name < current;
      let size: number;
      let mtimeMs: number;
      try {
        // Before the read: a line appended in between then shows as a size
        // the cache does not have, and the month is read again next time,
        // rather than cached as complete without it.
        ({ size, mtimeMs } = statSync(file));
      } catch {
        continue;
      }
      const hit = closed ? cached.get(name) : undefined;
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
        months.push(hit);
        keep.set(name, hit);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const totals = totalMonth(text);
      months.push(totals);
      if (closed) {
        keep.set(name, { ...totals, size, mtimeMs });
        changed = true;
      }
    }
    // Also when a month left the cache: its file is gone.
    if (changed || keep.size !== cached.size) writeCache(dir, keep);
  } catch (err) {
    debug('Usage ledger: could not read it:', err);
  }
  return combine(months);
}

function totalMonth(text: string): MonthTotals {
  let prompts = 0;
  const sessions = new Set<string>();
  const dates = new Set<string>();
  const models = new Map<string, ModelTokens>();
  let last: MonthTotals['last'] = null;
  for (const raw of text.split('\n')) {
    const line = parseLine(raw);
    if (!line) continue;
    dates.add(localDate(line.t));
    if (line.k === 'p') {
      prompts++;
      sessions.add(line.s);
      continue;
    }
    const bucket = models.get(line.m) ?? emptyTokens();
    bucket.inputTokens += line.in;
    bucket.outputTokens += line.out;
    bucket.cacheReadInputTokens += line.cr;
    bucket.cacheCreationInputTokens += line.cw;
    models.set(line.m, bucket);
    // Ties go to the later line: it was appended later.
    if (!last || line.t >= last.t) last = { t: line.t, p: line.p };
  }
  return {
    prompts,
    sessions: [...sessions],
    dates: [...dates],
    models: Object.fromEntries(models),
    last,
  };
}

function combine(months: MonthTotals[]): UsageSummary {
  let totalPrompts = 0;
  const sessions = new Set<string>();
  const dates = new Set<string>();
  // A Map, so a model named `constructor` or `__proto__` is a model and not
  // a property every object already has.
  const models = new Map<string, ModelTokens>();
  let last: MonthTotals['last'] = null;
  for (const month of months) {
    totalPrompts += month.prompts;
    for (const session of month.sessions) sessions.add(session);
    for (const date of month.dates) dates.add(date);
    for (const [model, tokens] of Object.entries(month.models)) {
      const bucket = models.get(model) ?? emptyTokens();
      bucket.inputTokens += tokens.inputTokens;
      bucket.outputTokens += tokens.outputTokens;
      bucket.cacheReadInputTokens += tokens.cacheReadInputTokens;
      bucket.cacheCreationInputTokens += tokens.cacheCreationInputTokens;
      models.set(model, bucket);
    }
    if (month.last && (!last || month.last.t >= last.t)) last = month.last;
  }
  const activeDates = [...dates].sort();
  return {
    totalPrompts,
    totalSessions: sessions.size,
    activeDates,
    activeDays: activeDates.length,
    modelUsage: Object.fromEntries(models),
    lastProvider: last?.p ?? null,
  };
}

/** One line, or null when it is not a whole, well-formed event. */
function parseLine(raw: string): LedgerLine | null {
  if (!raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const line = value as Record<string, unknown>;
  if (typeof line.t !== 'number' || !Number.isFinite(line.t)) return null;
  if (line.k === 'p') {
    if (typeof line.s !== 'string' || line.s === '') return null;
    return { t: line.t, k: 'p', s: line.s, src: String(line.src ?? '') };
  }
  if (line.k === 'u') {
    if (typeof line.p !== 'string' || typeof line.m !== 'string') return null;
    const tokens = [line.in, line.out, line.cr, line.cw];
    if (!tokens.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
    const [input, output, cacheRead, cacheWrite] = tokens as number[];
    return { t: line.t, k: 'u', p: line.p, m: line.m, in: input, out: output, cr: cacheRead, cw: cacheWrite };
  }
  return null;
}

// ─── cache.json ──────────────────────────────────────────────────────────────

/** The cached closed months, keyed by file name. Empty when there is no
 *  usable cache, which only costs reading those months again. */
function readCache(dir: string): Map<string, CachedMonth> {
  const months = new Map<string, CachedMonth>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'));
  } catch {
    return months;
  }
  const cache = parsed as { version?: unknown; months?: unknown } | null;
  if (!cache || cache.version !== CACHE_VERSION || !cache.months || typeof cache.months !== 'object') return months;
  for (const [name, entry] of Object.entries(cache.months as Record<string, unknown>)) {
    if (MONTH_FILE.test(name) && isCachedMonth(entry)) months.set(name, entry);
  }
  return months;
}

function isCachedMonth(value: unknown): value is CachedMonth {
  if (!value || typeof value !== 'object') return false;
  const month = value as Record<string, unknown>;
  const isCount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const isStrings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string');
  if (!isCount(month.size) || !isCount(month.mtimeMs) || !isCount(month.prompts)) return false;
  if (!isStrings(month.sessions) || !isStrings(month.dates)) return false;
  if (!month.models || typeof month.models !== 'object' || Array.isArray(month.models)) return false;
  for (const tokens of Object.values(month.models as Record<string, unknown>)) {
    if (!tokens || typeof tokens !== 'object') return false;
    const t = tokens as Record<string, unknown>;
    if (![t.inputTokens, t.outputTokens, t.cacheReadInputTokens, t.cacheCreationInputTokens].every(isCount)) return false;
  }
  const last = month.last as Record<string, unknown> | null;
  if (last !== null && (!last || typeof last !== 'object' || typeof last.t !== 'number' || typeof last.p !== 'string')) return false;
  return true;
}

/**
 * Replaced whole through a temporary file, so a TUI and an ACP server
 * rebuilding it at once leave one of their two caches rather than a mix.
 */
function writeCache(dir: string, months: Map<string, CachedMonth>): void {
  const tmp = join(dir, `.${CACHE_FILE}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, months: Object.fromEntries(months) }), { mode: FILE_MODE });
    renameSync(tmp, join(dir, CACHE_FILE));
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written, or already renamed */ }
    debug('Usage ledger: could not write its cache:', err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A token count as the ledger stores it: a whole number, never negative. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function emptyTokens(): ModelTokens {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD`, local. */
function localDate(t: number): string {
  const date = new Date(t);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
