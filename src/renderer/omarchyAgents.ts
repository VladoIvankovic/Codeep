/**
 * Codeep in Omarchy's Agents panel.
 *
 * Omarchy's bar has one panel for every AI coding agent on the machine, and
 * the panel only draws records: one JSON file per agent in
 * `$XDG_STATE_HOME/omarchy/agents/usage/`, which it picks up "regardless of
 * who wrote it" (shell/plugins/agents/README.md). Omarchy's own collectors
 * write Claude Code's, Codex's and Grok's; Codeep writes `codeep.json` beside
 * them from its usage ledger (utils/usageLedger.ts) and asks nothing of
 * Omarchy — no collector to install, no `omarchy-shell … refresh`, which
 * would run every other agent's collector too. The panel lists the file at
 * its next rescan and watches it from then on.
 *
 * The record carries only what stays true until the next write: the plan
 * (the display name of the provider of the latest model call), the all-time
 * counts, the dates Codeep was used on, and each model's tokens, which feed
 * the panel's "Mostly …" line. Today's and this week's figures stay at zero.
 * Codeep writes only while it runs, so on a day it does not, "1.2M tokens
 * today" would still be standing from yesterday — and read as the panel's
 * mistake.
 *
 * This one file is all Codeep writes in Omarchy's directories. It never edits
 * Omarchy's config: hiding Codeep from Omarchy's side stays Omarchy's own
 * `providers.codeep.enabled`.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { getProvider } from '../config/providers';
import { logger } from '../utils/logger';
import { onLedgerAppend, readUsageSummary, type ModelTokens, type UsageSummary } from '../utils/usageLedger';
import { isOmarchy } from './omarchyTheme';

// Debug logging helper - writes to log file when CODEEP_DEBUG=1
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    logger.debug(args.map(String).join(' '));
  }
};

/** The file name, and the `id` inside it — the panel takes one from the other. */
const AGENT_ID = 'codeep';
const RECORD_FILE = `${AGENT_ID}.json`;

/**
 * `$XDG_STATE_HOME/omarchy/agents/usage`, or `~/.local/state/…` when it is
 * unset or empty — read exactly as the panel (Main.qml's `||`) and its
 * updater (bin/omarchy-agent-usage-update's `:-`) read it. Not
 * omarchyStateDir(): that is where the THEME lives, and Omarchy keeps the
 * theme under ~/.local/state whatever XDG_STATE_HOME says.
 */
export function omarchyAgentsUsageDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'omarchy', 'agents', 'usage');
}

/**
 * The record, in the shape Omarchy's collectors print (bin/omarchy-agent-
 * usage-grok; Main.qml's displayProvider reads it). The fields that are
 * always the same are typed as their value, so a change to one is a change
 * to this contract and not a slip.
 */
export interface OmarchyAgentRecord {
  schemaVersion: 1;
  id: typeof AGENT_ID;
  name: 'Codeep';
  updatedAt: string;
  ready: true;
  tierLabel: string;
  usageStatusText: '';
  authHelpText: '';
  limits: [];
  hasLocalStats: true;
  hasPromptStats: true;
  todayPrompts: 0;
  todaySessions: 0;
  todayTotalTokens: 0;
  todayTokensByModel: Record<string, never>;
  recentDays: [];
  totalPrompts: number;
  totalSessions: number;
  activeDays: number;
  activeDates: string[];
  modelUsage: Record<string, ModelTokens>;
}

/**
 * Brands the panel would misspell. Its friendlyModelName (Main.qml) names a
 * model by upper-casing the first letter of each hyphenated word, with only
 * GPT and DeepSeek spelled out, so `glm-5.3` reads "Glm 5.3" and OpenRouter's
 * `minimax-m3` reads "Minimax M3".
 */
const BRAND_SPELLINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^glm(?=-|$)/i, 'GLM'],
  [/^minimax(?=-|$)/i, 'MiniMax'],
];

/**
 * The key a model goes under in the record: its id in lower case, with a
 * brand the panel would misspell written the way the brand spells itself —
 * `GLM-5.3`, which the panel shows as "GLM 5.3". Lower case first, because
 * the panel upper-cases each word's first letter anyway and providers spell
 * one model differently: MiniMax's own API sends `MiniMax-M3`, OpenRouter
 * `minimax-m3`, and both are one "MiniMax M3". Only the record's keys; the
 * ledger keeps the ids as the providers sent them.
 */
export function omarchyModelKey(model: string): string {
  const key = model.toLowerCase();
  for (const [brand, spelling] of BRAND_SPELLINGS) {
    if (brand.test(key)) return key.replace(brand, spelling);
  }
  return key;
}

/** The ledger's tokens by model under the record's keys. Two ids that come to
 *  one key — `minimax-m3` through OpenRouter, `MiniMax-M3` direct — are one
 *  model in the panel, so their tokens are added together. */
function omarchyModelUsage(byModel: Record<string, ModelTokens>): Record<string, ModelTokens> {
  const out: Record<string, ModelTokens> = {};
  for (const [model, tokens] of Object.entries(byModel)) {
    const key = omarchyModelKey(model);
    const sum = out[key] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    out[key] = {
      inputTokens: sum.inputTokens + tokens.inputTokens,
      outputTokens: sum.outputTokens + tokens.outputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + tokens.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + tokens.cacheCreationInputTokens,
    };
  }
  return out;
}

/**
 * Codeep's record for what the ledger holds.
 *
 * The plan is the provider of the latest model call, by its display name
 * ("Z.AI (ZhipuAI)", "OpenRouter") — what Codeep was used through, as Claude
 * Code's record names its subscription. No limits: Codeep sees no
 * provider's allowance. `recentDays` stays empty; in Omarchy's format its
 * `messageCount` is a day's TOKENS, one of the figures that would go stale.
 */
export function omarchyAgentRecord(summary: UsageSummary, now: Date = new Date()): OmarchyAgentRecord {
  return {
    schemaVersion: 1,
    id: AGENT_ID,
    name: 'Codeep',
    updatedAt: now.toISOString(),
    ready: true,
    tierLabel: (summary.lastProvider && getProvider(summary.lastProvider)?.name) || '',
    usageStatusText: '',
    authHelpText: '',
    limits: [],
    hasLocalStats: true,
    hasPromptStats: true,
    todayPrompts: 0,
    todaySessions: 0,
    todayTotalTokens: 0,
    todayTokensByModel: {},
    recentDays: [],
    totalPrompts: summary.totalPrompts,
    totalSessions: summary.totalSessions,
    activeDays: summary.activeDays,
    activeDates: summary.activeDates,
    modelUsage: omarchyModelUsage(summary.modelUsage),
  };
}

export interface OmarchyAgentsOptions {
  /** Whether the record should exist now — the /settings switch. Asked at
   *  every write, so switching it needs no restart, and a write that finds
   *  it off takes the record away. Default: always. */
  enabled?: () => boolean;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Omarchy's theme state directory, which says this is Omarchy at all —
   *  see isOmarchy(). Defaults to omarchyStateDir(). */
  stateDir?: string;
  /** Where the record goes. Defaults to omarchyAgentsUsageDir(). */
  usageDir?: string;
  /** The ledger to read. Defaults to ~/.codeep/usage. */
  ledgerDir?: string;
}

/**
 * Bring the record up to date: on Omarchy, with the setting on and a line in
 * the ledger, write it; with the setting off, take it away. Returns whether
 * it wrote. Never throws.
 *
 * Off is not only the /settings switch, which takes the record away itself:
 * the setting can be turned off in config.json by hand, or in the terminal
 * while an ACP server has a write waiting. Removing the record at the next
 * write keeps any of those from leaving the last one in the panel for good.
 *
 * A record that would differ from the one already there only in `updatedAt`
 * is left as it is: rewriting it gets the panel to read it again for nothing
 * and, with Omarchy's sync on, rewrites the user's synced snapshot too.
 *
 * Replaced whole, the way Omarchy's updater replaces its own: written to
 * `.codeep.<random>` beside it and renamed over `codeep.json`, so the panel
 * never reads half a record. The temporary name must not end in `.json` —
 * the panel finds agents with `find -name '*.json'`, and would list it.
 */
export function writeOmarchyAgentRecord(options: OmarchyAgentsOptions = {}): boolean {
  try {
    if (!isOmarchy(options.platform, options.stateDir)) return false;
    const dir = options.usageDir ?? omarchyAgentsUsageDir();
    if (options.enabled && !options.enabled()) {
      removeOmarchyAgentRecord({ usageDir: dir });
      return false;
    }
    const summary = readUsageSummary({ dir: options.ledgerDir });
    // Every line there is, of either kind, has a date.
    if (summary.activeDays === 0) return false;
    const record = omarchyAgentRecord(summary);
    const file = join(dir, RECORD_FILE);
    if (holdsRecord(file, record)) return false;
    // Omarchy's updater makes the directory the same way.
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${AGENT_ID}.${randomBytes(6).toString('hex')}`);
    try {
      // 0600, as Omarchy's own records are (its updater's mktemp makes them
      // so), whatever the umask; the rename keeps it.
      writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* never written, or already renamed */ }
      throw err;
    }
    return true;
  } catch (err) {
    debug('Omarchy agents: could not write the record:', err);
    return false;
  }
}

/** Whether `file` already holds `record`, `updatedAt` aside. */
function holdsRecord(file: string, record: OmarchyAgentRecord): boolean {
  try {
    const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return JSON.stringify({ ...current, updatedAt: null }) === JSON.stringify({ ...record, updatedAt: null });
  } catch {
    return false;
  }
}

/**
 * Take Codeep out of the panel: delete `codeep.json` — but only if it parses
 * and says it is Codeep's. A file of that name that is anything else was put
 * there by someone else, and is theirs. Returns whether it deleted. Never
 * throws.
 */
export function removeOmarchyAgentRecord(options: Pick<OmarchyAgentsOptions, 'usageDir'> = {}): boolean {
  const file = join(options.usageDir ?? omarchyAgentsUsageDir(), RECORD_FILE);
  try {
    const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || (record as { id?: unknown }).id !== AGENT_ID) return false;
    unlinkSync(file);
    return true;
  } catch {
    // Not there, not readable, not JSON: nothing of Codeep's to remove.
    return false;
  }
}

/**
 * The /settings switch, applied at once: On writes the record now (when the
 * ledger has something to say), Off takes it away.
 */
export function applyOmarchyAgentsPanel(on: boolean, options: OmarchyAgentsOptions = {}): void {
  if (on) writeOmarchyAgentRecord({ ...options, enabled: () => true });
  else removeOmarchyAgentRecord(options);
}

export interface OmarchyAgentRecordWatch {
  /** Write now if a write is waiting — what process exit does. */
  flush(): void;
  /** Stop listening, dropping any write that is waiting. */
  stop(): void;
}

/** The running watch. One per process. */
let active: OmarchyAgentRecordWatch | null = null;

/**
 * Keep the record current for as long as the process runs.
 *
 * Returns null — doing nothing at all — anywhere but Omarchy.
 *
 * The first write comes `delayMs` (two seconds) after the ledger takes a
 * line, so Codeep is in the panel moments after it is used. After that,
 * writes are at least `intervalMs` (a minute) apart. An agent run makes a
 * model call every few seconds, and a write after each one re-read the whole
 * month each time and had the panel re-read the record — and, with Omarchy's
 * sync on, rewrite the user's synced snapshot — while the record holds no
 * figure that a minute makes stale. A line that comes while a write is
 * waiting is in that write, which reads the ledger when it happens; a line
 * that comes after it starts the next one, so the last line is always
 * written.
 *
 * The timer is unref'd, so a waiting write never keeps the process alive;
 * the exit hook makes it instead, synchronously. Not when the process is
 * ended by SIGTERM or SIGHUP (a terminal window closed on it): the config
 * store's exit hook (when-exit, which conf's atomically installs) re-raises
 * those, and Node then ends without an 'exit' event. The lines are in the
 * ledger by then, and the next write, from any Codeep process, has them.
 *
 * Every write asks `enabled()` again, so a record switched off is taken away
 * rather than put back by a write that was already waiting.
 */
export function keepOmarchyAgentRecord(
  options: OmarchyAgentsOptions & { delayMs?: number; intervalMs?: number } = {},
): OmarchyAgentRecordWatch | null {
  if (!isOmarchy(options.platform, options.stateDir)) return null;
  const delayMs = options.delayMs ?? 2000;
  const intervalMs = options.intervalMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When the last write was made: none yet. */
  let lastWrite = -Infinity;

  const write = () => {
    timer = null;
    lastWrite = Date.now();
    writeOmarchyAgentRecord(options);
  };
  const stopListening = onLedgerAppend(() => {
    // The write already waiting will have this line too.
    if (timer) return;
    // No sooner than delayMs, and never more than intervalMs off — which also
    // keeps a clock set back from holding the write up.
    const wait = Math.min(intervalMs, Math.max(delayMs, lastWrite + intervalMs - Date.now()));
    timer = setTimeout(write, wait);
    timer.unref?.();
  });
  // Synchronous, as an exit handler has to be: the write is.
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    write();
  };
  process.on('exit', flush);

  const handle: OmarchyAgentRecordWatch = {
    flush,
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      stopListening();
      process.removeListener('exit', flush);
      if (active === handle) active = null;
    },
  };
  active?.stop();
  active = handle;
  return handle;
}
