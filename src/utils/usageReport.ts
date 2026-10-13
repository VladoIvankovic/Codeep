/**
 * `codeep usage`: what Codeep used, read from the usage ledger.
 *
 * The ledger (usageLedger.ts) is a local, content-free record of every model
 * call and prompt, kept on every platform. This turns it into a short table
 * for a person and, with `--json`, into the document a desktop integration
 * reads — Omarchy's Codeep plugin shows today's and this week's figures from
 * it. No network, no API key, nothing but the ledger; and nothing in the
 * output but counts, model ids and provider names, never prompt text or paths.
 *
 * Days are LOCAL days, as the ledger counts them: someone who codes until 1am
 * is still on the day they started in. They are walked as calendar days
 * (`new Date(y, m, d - k)`), never as multiples of 86 400 000 ms, which on the
 * day a clock goes back lists one date twice and on the day it goes forward
 * misses one.
 */
import { PROVIDERS } from '../config/providers';
import { formatTokenCount } from './tokenTracker';
import { localDate, readUsageReport, type DayUsage, type ModelTokens, type UsageReportData } from './usageLedger';

/** Days `--days` lists when it is not given. */
export const DEFAULT_DAYS = 7;
/** The most `--days` accepts: a year, and a leap day. */
export const MAX_DAYS = 366;
/** "This week" is always the last seven local days, today included, whatever `--days` lists. */
export const WEEK_DAYS = 7;

export interface UsageReportJson {
  schemaVersion: 1;
  generatedAt: string;
  today: {
    date: string;
    prompts: number;
    sessions: number;
    tokens: number;
    byModel: Record<string, ModelTokens>;
  };
  days: Array<{ date: string; prompts: number; tokens: number }>;
  week: { prompts: number; sessions: number; tokens: number };
  total: { prompts: number; sessions: number; activeDays: number; tokens: number; firstDate: string | null };
  models: Record<string, ModelTokens>;
  lastProvider: string | null;
  lastProviderName: string | null;
}

/** input + output + cache reads + cache writes: the sum Omarchy's panel adds. */
export function sumTokens(tokens: ModelTokens): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens;
}

function sumModels(models: Record<string, ModelTokens>): number {
  let total = 0;
  for (const tokens of Object.values(models)) total += sumTokens(tokens);
  return total;
}

/** A provider's display name, or null for an id that is not one of ours
 *  (`PROVIDERS` is a plain object: an id named `constructor` is no provider). */
function providerName(id: string | null): string | null {
  if (id === null || !Object.prototype.hasOwnProperty.call(PROVIDERS, id)) return null;
  return PROVIDERS[id].name;
}

/**
 * The local date `back` days before the one `now` falls on. Calendar
 * arithmetic, at noon: the day exists in every zone whatever its length.
 */
function dateBefore(now: number, back: number): string {
  const at = new Date(now);
  return localDate(new Date(at.getFullYear(), at.getMonth(), at.getDate() - back, 12).getTime());
}

/** Models busiest first, ties by id, so the output does not depend on the
 *  order the ledger happened to be read in. Object.fromEntries defines own
 *  properties, so a model named `__proto__` stays a model. */
function byTokens(models: Record<string, ModelTokens>): Record<string, ModelTokens> {
  const sorted = Object.entries(models).sort(([a, x], [b, y]) => sumTokens(y) - sumTokens(x) || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(sorted.map(([model, tokens]) => [model, {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadInputTokens: tokens.cacheReadInputTokens,
    cacheCreationInputTokens: tokens.cacheCreationInputTokens,
  }]));
}

/**
 * The document `--json` prints, from what the ledger holds. Keys are in the
 * order the schema lists them: a consumer is free to rely on it.
 */
export function buildUsageReport(
  data: UsageReportData,
  options: { now: number; days?: number },
): UsageReportJson {
  const { summary } = data;
  const dayCount = options.days ?? DEFAULT_DAYS;
  const empty: DayUsage = { prompts: 0, sessions: [], models: {} };
  const dayOf = (date: string): DayUsage => data.days.get(date) ?? empty;

  const todayDate = dateBefore(options.now, 0);
  const today = dayOf(todayDate);

  const listed: UsageReportJson['days'] = [];
  for (let back = dayCount - 1; back >= 0; back--) {
    const date = dateBefore(options.now, back);
    const day = dayOf(date);
    listed.push({ date, prompts: day.prompts, tokens: sumModels(day.models) });
  }

  // Sessions are counted over the week, not added up per day: one that ran on
  // three of the days is one.
  let weekPrompts = 0;
  let weekTokens = 0;
  const weekSessions = new Set<string>();
  for (let back = WEEK_DAYS - 1; back >= 0; back--) {
    const day = dayOf(dateBefore(options.now, back));
    weekPrompts += day.prompts;
    weekTokens += sumModels(day.models);
    for (const session of day.sessions) weekSessions.add(session);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(options.now).toISOString(),
    today: {
      date: todayDate,
      prompts: today.prompts,
      sessions: today.sessions.length,
      tokens: sumModels(today.models),
      byModel: byTokens(today.models),
    },
    days: listed,
    week: { prompts: weekPrompts, sessions: weekSessions.size, tokens: weekTokens },
    total: {
      prompts: summary.totalPrompts,
      sessions: summary.totalSessions,
      activeDays: summary.activeDays,
      tokens: sumModels(summary.modelUsage),
      firstDate: summary.activeDates[0] ?? null,
    },
    models: byTokens(summary.modelUsage),
    lastProvider: summary.lastProvider,
    lastProviderName: providerName(summary.lastProvider),
  };
}

// ─── The table ───────────────────────────────────────────────────────────────

const pad = (text: string, width: number) => text.padStart(width);

/**
 * The same figures as a short table, for a terminal or the chat. `daysListed`
 * adds the per-day rows — only when `--days` was asked for, so the default
 * stays short.
 */
export function formatUsageReport(report: UsageReportJson, options: { daysListed?: boolean } = {}): string {
  const rows: Array<[string, number, number, number]> = [
    ['Today', report.today.prompts, report.today.sessions, report.today.tokens],
    ['Last 7 days', report.week.prompts, report.week.sessions, report.week.tokens],
    ['All time', report.total.prompts, report.total.sessions, report.total.tokens],
  ];
  const lines: string[] = [];
  lines.push(`Codeep usage — ${report.today.date}`);
  lines.push('');
  lines.push(`${'Period'.padEnd(12)} ${pad('Prompts', 8)} ${pad('Sessions', 9)} ${pad('Tokens', 9)}`);
  for (const [name, prompts, sessions, tokens] of rows) {
    lines.push(`${name.padEnd(12)} ${pad(String(prompts), 8)} ${pad(String(sessions), 9)} ${pad(formatTokenCount(tokens), 9)}`);
  }

  if (report.total.firstDate) {
    lines.push('');
    lines.push(`Since ${report.total.firstDate}, on ${report.total.activeDays} day${report.total.activeDays === 1 ? '' : 's'}.`);
  } else {
    lines.push('');
    lines.push('Nothing recorded yet. Codeep counts from the first prompt it sends.');
  }

  if (options.daysListed) {
    lines.push('');
    lines.push(`Last ${report.days.length} days`);
    for (const day of report.days) {
      lines.push(`  ${day.date}  ${pad(String(day.prompts), 6)} prompts  ${pad(formatTokenCount(day.tokens), 8)} tokens`);
    }
  }

  const models = Object.entries(report.models);
  if (models.length > 0) {
    lines.push('');
    lines.push('Tokens by model (all time)');
    const width = Math.min(32, Math.max(...models.map(([model]) => model.length)));
    for (const [model, tokens] of models) {
      const name = model.length > width ? `${model.slice(0, width - 1)}…` : model;
      lines.push(
        `  ${name.padEnd(width)}  ${pad(formatTokenCount(sumTokens(tokens)), 8)}` +
        `   in ${formatTokenCount(tokens.inputTokens)} · out ${formatTokenCount(tokens.outputTokens)}` +
        ` · cache ${formatTokenCount(tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens)}`,
      );
    }
  }

  if (report.lastProviderName) {
    lines.push('');
    lines.push(`Last used through ${report.lastProviderName}.`);
  }
  return lines.join('\n');
}

// ─── The command ─────────────────────────────────────────────────────────────

export const USAGE_HELP = `Usage: codeep usage [--json] [--days N]

What Codeep has used, from the usage ledger in ~/.codeep/usage. It never
leaves this machine and holds no prompt text.

  --json      One JSON document (schemaVersion 1) instead of the table
  --days N    List the last N days, 1 to ${MAX_DAYS} (the JSON lists ${DEFAULT_DAYS} by default)
  -h, --help  This text
`;

export type ParsedUsageArgs =
  | { ok: true; json: boolean; days: number; daysGiven: boolean }
  | { ok: false; help: true }
  | { ok: false; help: false; message: string };

/**
 * `usage`'s own arguments. Strict where a prompt's launcher is not: a
 * misspelled flag would otherwise print a table that is not the one asked
 * for, to a script that parses it.
 */
export function parseUsageArgs(args: string[]): ParsedUsageArgs {
  let json = false;
  let days = DEFAULT_DAYS;
  let daysGiven = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { ok: false, help: true };
    if (arg === '--json') {
      json = true;
      continue;
    }
    let value: string | undefined;
    if (arg === '--days') {
      value = args[++i];
    } else if (arg.startsWith('--days=')) {
      value = arg.slice('--days='.length);
    } else {
      return { ok: false, help: false, message: `codeep usage: unknown argument "${arg.slice(0, 40)}"` };
    }
    // Digits only: parseInt would take "7days" and "1e3" for numbers.
    if (value === undefined || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > MAX_DAYS) {
      return { ok: false, help: false, message: `codeep usage: --days needs a whole number from 1 to ${MAX_DAYS}` };
    }
    days = Number(value);
    daysGiven = true;
  }
  return { ok: true, json, days, daysGiven };
}

export interface UsageCommandIo {
  /** Resolves once the text has been handed to the stream — so the process
   *  can end afterwards without cutting a pipe short. */
  stdout: (text: string) => Promise<void>;
  stderr: (text: string) => Promise<void>;
  now?: () => number;
  /** The ledger to read. Defaults to ~/.codeep/usage. */
  ledgerDir?: string;
}

const writeTo = (stream: NodeJS.WriteStream) => (text: string) =>
  new Promise<void>(resolve => { stream.write(text, () => resolve()); });

/**
 * Run `codeep usage` and return its exit code: 0, or 2 for arguments it does
 * not take. `--json` prints the document and nothing else on stdout.
 */
export async function runUsageCommand(args: string[], io: Partial<UsageCommandIo> = {}): Promise<number> {
  const stdout = io.stdout ?? writeTo(process.stdout);
  const stderr = io.stderr ?? writeTo(process.stderr);
  const parsed = parseUsageArgs(args);
  if (!parsed.ok) {
    if (parsed.help) {
      await stdout(USAGE_HELP);
      return 0;
    }
    await stderr(`${parsed.message}\n\n${USAGE_HELP}`);
    return 2;
  }
  const now = (io.now ?? Date.now)();
  const report = buildUsageReport(readUsageReport({ dir: io.ledgerDir, now }), { now, days: parsed.days });
  await stdout(parsed.json ? `${JSON.stringify(report)}\n` : `${formatUsageReport(report, { daysListed: parsed.daysGiven })}\n`);
  return 0;
}
