/**
 * Structured skill bundles — Codeep's answer to Claude Code-style skills.
 *
 * Unlike the JSON-manifest "skills" in `skills.ts` (which are sequential
 * step lists triggered by the user via `/<name>`), bundles are
 * agent-discovered capabilities the model picks up on its own. Each
 * bundle lives in a directory:
 *
 *   <workspace>/.codeep/skills/<name>/SKILL.md   (project-scoped)
 *   ~/.codeep/skills/<name>/SKILL.md             (global)
 *
 * Project bundles shadow global ones with the same name. The bundle dir
 * may also contain auxiliary files (`assets/`, `scripts/`, …) that the
 * SKILL.md body refers to — we don't enforce any sub-structure.
 *
 * The SKILL.md format is a deliberate superset of Claude Code's skills
 * format so existing skills can be dropped in unchanged. Frontmatter
 * keys we recognise:
 *
 *   name:               (required) short slug; matches dir name by default
 *   description:        (required) one-sentence summary for the catalog
 *   allowed-tools:      (optional) array of tool names this skill may call
 *   triggers:           (optional) array of phrases that hint when to use
 *   version:            (optional) semver string
 *   author:             (optional) free text
 *
 * Codeep-specific extensions (skipped by Claude Code parsers, valid YAML):
 *
 *   codeep-min-version: (optional) require Codeep CLI ≥ this version
 *   codeep-requires-mcp: (optional) array of MCP server names that must
 *                        be registered for this skill to run
 *
 * The body of SKILL.md is freeform Markdown — instructions the agent
 * reads when it decides to invoke the skill.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface SkillBundleMeta {
  /** Slug — defaults to the directory name if frontmatter `name` is missing. */
  name: string;
  /** One-line summary shown in the catalog. */
  description: string;
  /** Filesystem path of the bundle directory. */
  source: string;
  /** 'project' if loaded from `<workspace>/.codeep/skills`, else 'global'. */
  scope: 'project' | 'global';
  /** Subset of tools the skill is allowed to call (advisory in v2.0; enforced in 2.1+). */
  allowedTools: string[];
  /** Hint phrases that suggest when to use this skill (sysprompt-only signal). */
  triggers: string[];
  /** Optional semver string. */
  version?: string;
  /** Optional author free text. */
  author?: string;
  /** Optional minimum Codeep version (semver string). */
  codeepMinVersion?: string;
  /** Optional list of MCP servers the skill needs registered. */
  requiresMcp: string[];
  /** Raw frontmatter — kept for `/skills detail <name>` introspection. */
  frontmatterRaw: Record<string, unknown>;
}

export interface SkillBundle extends SkillBundleMeta {
  /** Body content (everything after the frontmatter). */
  body: string;
}

interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  body: string;
}

/**
 * Tolerant YAML-frontmatter parser — handles `key: value`, `key: [a, b]`,
 * and `key:` followed by `- item` block-list lines. Quoted strings are
 * unquoted. We don't ship a real YAML dep for this — the keys we care
 * about are scalars or simple arrays.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // BOM + CRLF normalisation. Real-world files copy/paste from various
  // editors and pick up either; YAML strictly forbids tabs in scalars
  // but we don't care for the keys we read.
  const normalised = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = normalised.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: normalised };

  const meta: Record<string, unknown> = {};
  const lines = match[1].split('\n');
  let currentList: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) { currentList = null; continue; }

    // Block-list item: `  - foo`
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      currentList.push(stripQuotes(listItem[1]));
      continue;
    }

    // `key: value` or `key:` (open list)
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let value: string | string[] = kv[2];

    if (value === '') {
      // Empty → expecting a block list below
      currentList = [];
      meta[key] = currentList;
      continue;
    }

    // Inline list: `[a, b, c]`
    const inline = value.match(/^\[(.*)\]$/);
    if (inline) {
      value = inline[1].split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
    } else {
      value = stripQuotes(value);
    }
    meta[key] = value;
    currentList = null;
  }
  return { meta, body: match[2].trimStart() };
}

export function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function loadFromDir(dir: string, scope: 'project' | 'global'): SkillBundle[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  const bundles: SkillBundle[] = [];
  for (const entry of entries) {
    const bundleDir = join(dir, entry);
    let stat;
    try { stat = statSync(bundleDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const skillFile = join(bundleDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    let raw: string;
    try { raw = readFileSync(skillFile, 'utf-8'); } catch { continue; }
    // Cap at 256 KB — any bigger and the user is shipping something
    // that doesn't belong in a SKILL.md. Skip silently to avoid OOM
    // surprises when an agent run loads dozens of bundles.
    if (raw.length > 256 * 1024) continue;

    const { meta, body } = parseFrontmatter(raw);
    const name = typeof meta.name === 'string' && meta.name ? meta.name : entry;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue; // sanitise

    const description = typeof meta.description === 'string' ? meta.description : '';
    if (!description) continue; // catalog entry without a description is noise

    bundles.push({
      name: name.toLowerCase(),
      description,
      source: bundleDir,
      scope,
      allowedTools: asStringArray(meta['allowed-tools']) ?? [],
      triggers: asStringArray(meta.triggers) ?? [],
      version: typeof meta.version === 'string' ? meta.version : undefined,
      author: typeof meta.author === 'string' ? meta.author : undefined,
      codeepMinVersion: typeof meta['codeep-min-version'] === 'string' ? meta['codeep-min-version'] : undefined,
      requiresMcp: asStringArray(meta['codeep-requires-mcp']) ?? [],
      frontmatterRaw: meta,
      body,
    });
  }
  return bundles;
}

export function asStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string') as string[];
  if (typeof v === 'string') return [v];
  return null;
}

/**
 * Load all skill bundles available in this workspace. Project entries
 * shadow global entries with the same name.
 */
export function loadSkillBundles(workspaceRoot?: string): SkillBundle[] {
  const global = loadFromDir(join(homedir(), '.codeep', 'skills'), 'global');
  const project = workspaceRoot
    ? loadFromDir(join(workspaceRoot, '.codeep', 'skills'), 'project')
    : [];

  const byName = new Map<string, SkillBundle>();
  for (const b of global) byName.set(b.name, b);
  for (const b of project) byName.set(b.name, b);  // project wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a single bundle by name (case-insensitive). */
export function findSkillBundle(name: string, workspaceRoot?: string): SkillBundle | null {
  const lower = name.toLowerCase();
  return loadSkillBundles(workspaceRoot).find(b => b.name === lower) ?? null;
}

/**
 * Build a compact catalog block for the agent's system prompt. Each entry
 * is `name — description (triggers)` so the model can pattern-match user
 * intent to a skill name. Capped so a workspace with hundreds of skills
 * can't blow the token budget.
 */
export function formatBundlesForSysprompt(bundles: SkillBundle[]): string {
  if (bundles.length === 0) return '';
  const CAP_PER_LINE = 200;
  const CAP_TOTAL = 4000;
  const lines: string[] = [
    '## Available skill bundles',
    '',
    'You can invoke any of these by calling the `invoke_skill` tool with `{"name": "<skill_name>"}`. The tool returns the skill\'s SKILL.md content — follow its instructions step by step. Each skill is a curated workflow the user has installed; prefer it over ad-hoc steps when the user\'s request matches a skill\'s purpose.',
    '',
  ];
  let used = lines.join('\n').length;
  let skipped = 0;
  for (const b of bundles) {
    const triggerHint = b.triggers.length > 0 ? ` _(triggers: ${b.triggers.slice(0, 3).join(', ')})_` : '';
    const line = `- **${b.name}** — ${b.description}${triggerHint}`;
    const truncated = line.length > CAP_PER_LINE ? line.slice(0, CAP_PER_LINE) + '…' : line;
    if (used + truncated.length + 1 > CAP_TOTAL) { skipped++; continue; }
    lines.push(truncated);
    used += truncated.length + 1;
  }
  if (skipped > 0) lines.push(`_(${skipped} more skills omitted to stay under the catalog budget — use \`/skills bundles\` to see all.)_`);
  return lines.join('\n');
}

/** Render a bundle list as a Markdown block for `/skills bundles`. */
export function formatBundleList(bundles: SkillBundle[]): string {
  if (bundles.length === 0) {
    return [
      '_No skill bundles installed yet._',
      '',
      'Create one with `/skills create-bundle <name>` (project) or drop a directory into `~/.codeep/skills/<name>/` (global). Each needs a `SKILL.md` with at least `name` and `description` in the frontmatter.',
    ].join('\n');
  }
  const project = bundles.filter(b => b.scope === 'project');
  const global = bundles.filter(b => b.scope === 'global');
  const lines = ['## Skill bundles', ''];
  if (project.length) {
    lines.push('**Project**');
    for (const b of project) lines.push(`- **${b.name}** ${b.version ? `\`v${b.version}\` ` : ''}— ${b.description}`);
    lines.push('');
  }
  if (global.length) {
    lines.push('**Global**');
    for (const b of global) lines.push(`- **${b.name}** ${b.version ? `\`v${b.version}\` ` : ''}— ${b.description}`);
  }
  return lines.join('\n');
}

/**
 * One-line summary for the welcome banner — same informed-consent
 * pattern as custom commands and hooks. Empty string if no bundles.
 */
export function summarizeBundles(workspaceRoot: string): string {
  const project = loadSkillBundles(workspaceRoot).filter(b => b.scope === 'project');
  if (project.length === 0) return '';
  return `${project.length} project skill${project.length === 1 ? '' : 's'}`;
}
