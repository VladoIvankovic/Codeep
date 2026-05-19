/**
 * `/insights` — agent activity summary over a configurable window.
 *
 * Source of truth: `~/.codeep/history/<id>.json`, one file per agent
 * run, written by the agent loop. Schema (relevant fields):
 *   { id, startTime, endTime, prompt, projectRoot, actions: [
 *       { type: 'write' | 'read' | 'execute' | …, path?, command?, timestamp }
 *     ]
 *   }
 *
 * We deliberately don't read sessions/*.json here — sessions store
 * chat history without tool-level detail, while history/ captures the
 * exact actions which is what users want to see ("which file did I
 * touch most this week?").
 *
 * Cost / token usage is per-process and lost across restarts (the
 * token tracker is in-memory), so /insights reports actions and time
 * but not historical dollar amounts. The current session's cost still
 * shows in /cost.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

interface HistoryAction {
  id: string;
  timestamp: number;
  type: string;
  path?: string;
  command?: string;
  args?: string[];
}

interface HistoryRun {
  id: string;
  startTime: number;
  endTime?: number;
  prompt: string;
  projectRoot?: string;
  actions: HistoryAction[];
}

function loadHistoryRuns(sinceMs: number): HistoryRun[] {
  const dir = join(homedir(), '.codeep', 'history');
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }

  const runs: HistoryRun[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      const run = JSON.parse(raw) as HistoryRun;
      if (typeof run.startTime !== 'number') continue;
      if (run.startTime < sinceMs) continue;
      runs.push(run);
    } catch {
      // skip malformed
    }
  }
  return runs.sort((a, b) => b.startTime - a.startTime);
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function relativeDayBucket(ts: number, now: number): string {
  const dayMs = 86_400_000;
  const days = Math.floor((now - ts) / dayMs);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

interface InsightsOptions {
  /** Days to look back. Default 7. */
  days?: number;
}

/**
 * Format `/insights` output as Markdown. Returns a friendly empty-state
 * message when there's no history in the window — we don't error.
 */
export function formatInsights(opts: InsightsOptions = {}): string {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const now = Date.now();
  const sinceMs = now - days * 86_400_000;
  const runs = loadHistoryRuns(sinceMs);

  const lines: string[] = [`## Activity — last ${days} day${days === 1 ? '' : 's'}`, ''];

  if (runs.length === 0) {
    lines.push(`_No agent runs in the last ${days} day${days === 1 ? '' : 's'}._`);
    lines.push('');
    lines.push('Run an agent task with `/agent <task>` (or just type a request when agent mode is on) — the activity here populates from `~/.codeep/history/`.');
    return lines.join('\n');
  }

  // ── Headline metrics ──────────────────────────────────────────────────────
  const totalRuns = runs.length;
  const totalActions = runs.reduce((s, r) => s + (r.actions?.length ?? 0), 0);
  const totalActiveMs = runs.reduce((s, r) => s + Math.max(0, (r.endTime ?? r.startTime) - r.startTime), 0);
  const avgActions = (totalActions / totalRuns).toFixed(1);
  const distinctDays = new Set(runs.map((r) => new Date(r.startTime).toISOString().slice(0, 10))).size;

  lines.push(
    `**${totalRuns}** run${totalRuns === 1 ? '' : 's'}`
    + `  ·  **${totalActions}** tool action${totalActions === 1 ? '' : 's'}`
    + `  ·  **${fmtDuration(totalActiveMs)}** active`
    + `  ·  **${distinctDays}**/${days} active day${distinctDays === 1 ? '' : 's'}`
    + `  ·  avg **${avgActions}** action${avgActions === '1.0' ? '' : 's'}/run`,
  );

  // ── By project ────────────────────────────────────────────────────────────
  const byProject = new Map<string, { runs: number; actions: number; activeMs: number }>();
  for (const r of runs) {
    const proj = r.projectRoot ? basename(r.projectRoot) : '(no project)';
    const cur = byProject.get(proj) ?? { runs: 0, actions: 0, activeMs: 0 };
    cur.runs++;
    cur.actions += r.actions?.length ?? 0;
    cur.activeMs += Math.max(0, (r.endTime ?? r.startTime) - r.startTime);
    byProject.set(proj, cur);
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1].activeMs - a[1].activeMs);

  if (projects.length > 0) {
    lines.push('', '### By project', '');
    lines.push('| Project | Runs | Actions | Active time |');
    lines.push('|---|---:|---:|---:|');
    for (const [name, s] of projects.slice(0, 8)) {
      lines.push(`| \`${name}\` | ${s.runs} | ${s.actions} | ${fmtDuration(s.activeMs)} |`);
    }
    if (projects.length > 8) lines.push(`| _… and ${projects.length - 8} more_ | | | |`);
  }

  // ── Top tool types ────────────────────────────────────────────────────────
  const byType = new Map<string, number>();
  for (const r of runs) {
    for (const a of r.actions ?? []) {
      byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
    }
  }
  const tools = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    lines.push('', '### Top tools', '');
    for (const [name, count] of tools.slice(0, 8)) {
      lines.push(`- \`${name}\` × **${count}**`);
    }
  }

  // ── Top files touched ─────────────────────────────────────────────────────
  const byPath = new Map<string, number>();
  for (const r of runs) {
    for (const a of r.actions ?? []) {
      if (a.path) byPath.set(a.path, (byPath.get(a.path) ?? 0) + 1);
    }
  }
  const files = [...byPath.entries()].sort((a, b) => b[1] - a[1]);
  if (files.length > 0) {
    lines.push('', '### Most-touched files', '');
    for (const [path, count] of files.slice(0, 8)) {
      // Trim home prefix for readability
      const display = path.replace(homedir(), '~');
      lines.push(`- \`${display}\` × **${count}**`);
    }
  }

  // ── Recent runs ───────────────────────────────────────────────────────────
  lines.push('', '### Recent runs', '');
  for (const r of runs.slice(0, 10)) {
    const when = relativeDayBucket(r.startTime, now);
    const dur = fmtDuration(Math.max(0, (r.endTime ?? r.startTime) - r.startTime));
    const proj = r.projectRoot ? basename(r.projectRoot) : '—';
    const prompt = (r.prompt || '').replace(/\s+/g, ' ').trim();
    const promptShort = prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt;
    lines.push(`- _${when}_ · **${proj}** · ${dur} · ${promptShort}`);
  }

  // ── Session cost callout ──────────────────────────────────────────────────
  // We only track tokens in-memory per process, so historical cost isn't
  // available. Tell the user where to look for the current session.
  lines.push('', "_For this session's cost + cache savings, run `/cost`._");

  return lines.join('\n');
}
