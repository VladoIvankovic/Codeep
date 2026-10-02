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
 *   ~/.agents/skills/<name>/SKILL.md             (global, shared by agents)
 *
 * Project bundles shadow global ones with the same name, and
 * `~/.codeep/skills` shadows `~/.agents/skills`. The bundle dir
 * may also contain auxiliary files (`assets/`, `scripts/`, …) that the
 * SKILL.md body refers to — we don't enforce any sub-structure, and the
 * agent reads them through invoke_skill (readSkillFile).
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

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { homedir } from 'os';
import { leadsOutsideProject } from './projectPaths';

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
 * `key:` followed by `- item` block-list lines, and `key: >` / `key: |`
 * block scalars. Quoted strings are unquoted. Not js-yaml, although it is
 * a dependency (reviewConfig.ts): it throws on frontmatter that skills are
 * written with and other agents read, like an unquoted
 * `description: Deploy: build, then ship`, and one such line would drop
 * the whole skill. The keys we care about are scalars or simple arrays.
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
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

    // Block scalar: the value is the indented lines below. Long
    // descriptions are written this way (Omarchy's skills all use
    // `description: >`); read as a plain value they'd be just `>`.
    const header = value.match(BLOCK_SCALAR_HEADER);
    if (header) {
      const block = readBlockScalar(lines, i + 1, header[1], header[2]);
      meta[key] = block.value;
      currentList = null;
      i = block.end - 1;
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

/** `>` or `|`, then a chomping (`-`, `+`) and/or indentation (`2`) indicator. */
const BLOCK_SCALAR_HEADER = /^([>|])([1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/;

/**
 * Read a block scalar's lines, starting at `start` (the line after the
 * header), the way YAML does. The block runs while lines are blank or
 * indented: the first non-blank line sets the depth, unless the header
 * gives it, and the first line less indented than that ends it. `|` keeps
 * the line breaks; `>` folds each into a space, except that blank lines
 * stay line breaks and so do the breaks around a more-indented line.
 * Chomping decides the trailing breaks: `-` drops them, `+` keeps them all,
 * and with neither the value ends in exactly one. Returns the value and the
 * index of the first line after the block.
 */
function readBlockScalar(
  lines: string[],
  start: number,
  style: string,
  indicators = '',
): { value: string; end: number } {
  const folded = style === '>';
  const chomping = indicators.includes('-') ? 'strip' : indicators.includes('+') ? 'keep' : 'clip';
  let indent = Number(indicators.replace(/[+-]/, '')) || 0;

  let value = '';
  let blankLines = 0;
  let hasContent = false;
  let afterMoreIndented = false;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line) { blankLines++; continue; }
    const depth = line.match(/^[ \t]*/)![0].length;
    // Keys sit at column 0, so a line there is the next key, never content.
    if (depth === 0 || depth < indent) break;
    if (!indent) indent = depth;

    const text = line.slice(indent);
    const moreIndented = /^[ \t]/.test(text);
    if (!folded || moreIndented || afterMoreIndented) {
      value += '\n'.repeat(hasContent ? blankLines + 1 : blankLines);
    } else if (blankLines > 0) {
      value += '\n'.repeat(blankLines);
    } else if (hasContent) {
      value += ' ';
    }
    value += text;
    hasContent = true;
    blankLines = 0;
    afterMoreIndented = folded && moreIndented;
  }

  if (chomping === 'keep') value += '\n'.repeat(hasContent ? blankLines + 1 : blankLines);
  else if (chomping === 'clip' && hasContent) value += '\n';
  return { value, end: i };
}

/** Largest SKILL.md we'll read (256 KB). */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

function loadFromDir(dir: string, scope: 'project' | 'global', projectRoot?: string): SkillBundle[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  // Sorted, so which of two directories claiming the same `name:` wins does
  // not depend on the order the filesystem lists them in. Node sorts on
  // Linux and macOS already; on Windows the listing is the filesystem's own.
  try { entries = readdirSync(dir).sort(); } catch { return []; }

  const bundles: SkillBundle[] = [];
  for (const entry of entries) {
    const bundleDir = join(dir, entry);
    let stat;
    try { stat = statSync(bundleDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const skillFile = join(bundleDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    // A project's bundles come with the repo: a link out of it (the bundle
    // directory or its SKILL.md) would put a user file into the prompt.
    if (projectRoot && leadsOutsideProject(skillFile, projectRoot)) continue;

    // Cap at 256 KB — any bigger and the user is shipping something
    // that doesn't belong in a SKILL.md. Skip silently to avoid OOM
    // surprises when an agent run loads dozens of bundles. Check before
    // reading: statSync follows symlinks, and a committed `SKILL.md ->
    // /dev/zero` (or a FIFO) never comes back from readFileSync.
    let raw: string;
    try {
      const fileStat = statSync(skillFile);
      if (!fileStat.isFile() || fileStat.size > MAX_SKILL_FILE_BYTES) continue;
      raw = readFileSync(skillFile, 'utf-8');
    } catch { continue; }

    const { meta, body } = parseFrontmatter(raw);
    const name = oneLine(meta.name) || entry;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue; // sanitise

    const description = oneLine(meta.description);
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

/**
 * A scalar as the single line the catalog, `/skills bundles` and the
 * invoke_skill header print it on. A block scalar (`description: >`) ends
 * in a line break, and a literal one (`|`) has more inside.
 */
function oneLine(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s*\n\s*/g, ' ').trim() : '';
}

export function asStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string') as string[];
  if (typeof v === 'string') return [v];
  return null;
}

/**
 * The user's own skill directories, the one that wins a name first.
 * `~/.agents/skills` is shared by every agent harness on the machine —
 * Omarchy links its skills in there — so a bundle written for Codeep
 * alone in `~/.codeep/skills` overrides one of the same name from it.
 * Both are the user's: a link in either may lead anywhere.
 */
function globalSkillDirs(): string[] {
  return [join(homedir(), '.codeep', 'skills'), join(homedir(), '.agents', 'skills')];
}

/**
 * Load all skill bundles available in this workspace. When two share a
 * name, the project's `.codeep/skills` wins, then `~/.codeep/skills`,
 * then `~/.agents/skills`; the others are dropped.
 */
export function loadSkillBundles(workspaceRoot?: string): SkillBundle[] {
  const project = workspaceRoot
    ? loadFromDir(join(workspaceRoot, '.codeep', 'skills'), 'project', workspaceRoot)
    : [];
  const global = globalSkillDirs().flatMap(dir => loadFromDir(dir, 'global'));

  const byName = new Map<string, SkillBundle>();
  for (const b of [...project, ...global]) {
    if (!byName.has(b.name)) byName.set(b.name, b);  // the first to claim a name keeps it
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A file from a bundle's directory: a guide its SKILL.md sends the agent to
 * ("read reporting.md before filing"). Omarchy's skills keep most of their
 * instructions in files like that, and read_file cannot reach them — a global
 * bundle is outside the project.
 *
 * Only inside the bundle: the name is relative and has no `..`, and where it
 * resolves through links is checked as well, so a link in the bundle cannot
 * hand out a file from somewhere else. The size cap and the regular-file
 * check are SKILL.md's own, for the same reasons (see loadFromDir).
 */
export function readSkillFile(bundle: SkillBundle, file: string): { content: string } | { error: string } {
  const segments = file.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || isAbsolute(file) || segments.includes('..')) {
    return { error: `"${file}" is not a path inside the skill's directory. Give it relative to that directory, e.g. "guide.md".` };
  }
  let target: string;
  try {
    target = realpathSync(join(bundle.source, ...segments));
    const inside = relative(realpathSync(bundle.source), target);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return { error: `"${file}" leads outside the skill's directory.` };
    }
  } catch {
    return { error: `"${file}" was not found in the skill's directory (${bundle.source}).` };
  }
  try {
    const stat = statSync(target);
    if (!stat.isFile()) return { error: `"${file}" is not a file.` };
    if (stat.size > MAX_SKILL_FILE_BYTES) return { error: `"${file}" is larger than ${MAX_SKILL_FILE_BYTES / 1024} KB.` };
    return { content: readFileSync(target, 'utf-8') };
  } catch (err) {
    return { error: `"${file}" could not be read: ${(err as Error).message}` };
  }
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
  // Room for a description at the Agent Skills limit of 1024 characters. The
  // end of one is often what picks the skill: Omarchy's run 470–590 and close
  // on when to use them and what they exclude. CAP_TOTAL is what keeps a
  // hundred skills out of the prompt.
  const CAP_PER_LINE = 1200;
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
    // At a word boundary, so the model is not handed half a word as a hint
    // — unless the "word" is so long that the line would lose it whole.
    const truncated = line.length > CAP_PER_LINE ? line.slice(0, CAP_PER_LINE).replace(/\s+\S{0,40}$/, '') + '…' : line;
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
      'Create one with `/skills create-bundle <name>` (project) or drop a directory into `~/.codeep/skills/<name>/` or `~/.agents/skills/<name>/` (global). Each needs a `SKILL.md` with at least `name` and `description` in the frontmatter.',
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
  // Global bundles come from more than one directory. Each gets a heading
  // naming its own, in precedence order, so the user can tell which file
  // to edit — and that a skill they didn't write came from ~/.agents/skills.
  const globalDirs = [...new Set([...globalSkillDirs(), ...global.map(b => dirname(b.source))])];
  for (const dir of globalDirs) {
    const here = global.filter(b => dirname(b.source) === dir);
    if (!here.length) continue;
    lines.push(`**Global** — \`${displayDir(dir)}\``);
    for (const b of here) lines.push(`- **${b.name}** ${b.version ? `\`v${b.version}\` ` : ''}— ${b.description}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** `dir` with the home directory written as `~`, the way the user types it. */
function displayDir(dir: string): string {
  const home = homedir();
  return dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
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
