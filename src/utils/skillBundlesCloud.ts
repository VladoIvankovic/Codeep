/**
 * Codeep skill marketplace — CLI ↔ codeep.dev/api/skills bridge.
 *
 * Talks to the REST endpoints in `Codeep-web/src/app/api/skills/`:
 *   GET  /api/skills?q=&mine=1         → browse
 *   POST /api/skills                   → publish (auth required)
 *   GET  /api/skills/:owner/:slug      → fetch one (auth req for private)
 *   DELETE /api/skills/:owner/:slug    → unpublish (owner only)
 *
 * Auth uses the same `x-sync-token` header `codeepCloud.ts` already sends
 * for /api/tasks and friends.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getSyncToken } from '../config/index.js';
import { findSkillBundle, type SkillBundle } from './skillBundles.js';

const API_BASE = 'https://codeep.dev';

export interface RemoteSkill {
  id: number;
  github_id: string;
  owner_username: string | null;
  slug: string;
  name: string;
  description: string;
  body: string;
  version: string | null;
  visibility: 'public' | 'private';
  install_count: number;
  updated_at: string;
}

/**
 * Publish a project-scoped skill bundle to codeep.dev.
 * The bundle MUST exist under `<workspaceRoot>/.codeep/skills/<slug>/SKILL.md`
 * — global skills aren't publishable from this helper (intentional: users
 * publish work from a project they're owning, not from their global hoard).
 */
export async function publishBundle(
  workspaceRoot: string,
  slug: string,
  opts: { isPublic?: boolean } = {},
): Promise<{ ok: boolean; skill?: RemoteSkill; error?: string }> {
  const token = getSyncToken();
  if (!token) return { ok: false, error: 'Not linked to codeep.dev — run `codeep account` first.' };

  const bundle = findSkillBundle(slug, workspaceRoot);
  if (!bundle || bundle.scope !== 'project') {
    return { ok: false, error: `Skill bundle "${slug}" not found in this project. Run \`/skills create-bundle ${slug}\` first.` };
  }

  // Build the SKILL.md text we'll publish. We re-serialise from the loaded
  // bundle rather than reading the file again — that way frontmatter
  // normalisation (e.g. defaulted name from dir) is reflected on the
  // server and the next install round-trips correctly.
  const skillMd = serialiseSkillMd(bundle);

  try {
    const res = await fetch(`${API_BASE}/api/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': token },
      body: JSON.stringify({
        slug: bundle.name,
        name: bundle.name,
        description: bundle.description,
        body: skillMd,
        version: bundle.version ?? null,
        visibility: opts.isPublic ? 'public' : 'private',
      }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; skill?: RemoteSkill; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, skill: data.skill };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Install a skill from the marketplace into the project's
 * `.codeep/skills/<slug>/SKILL.md`. `idOrPath` may be either
 * `<owner>/<slug>` (preferred) or a numeric id.
 */
export async function installBundle(
  workspaceRoot: string,
  idOrPath: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const token = getSyncToken(); // optional — public skills are readable without auth
  const headers: Record<string, string> = {};
  if (token) headers['x-sync-token'] = token;

  try {
    // ?install=1 so the server bumps install_count
    const url = `${API_BASE}/api/skills/${encodeURIComponent(idOrPath)}?install=1`;
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; skill?: RemoteSkill; error?: string };
    if (!res.ok || !data.ok || !data.skill) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    const skill = data.skill;
    const dir = join(workspaceRoot, '.codeep', 'skills', skill.slug);
    if (existsSync(dir)) {
      return { ok: false, error: `A bundle already exists at .codeep/skills/${skill.slug}/ — remove it before re-installing.` };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skill.body);
    return { ok: true, name: skill.slug };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** List public skills (or own when `mine=true`). Returns up to 100. */
export async function browseSkills(
  opts: { query?: string; mine?: boolean } = {},
): Promise<{ ok: boolean; skills?: RemoteSkill[]; error?: string }> {
  const token = getSyncToken();
  const headers: Record<string, string> = {};
  if (token) headers['x-sync-token'] = token;
  if (opts.mine && !token) return { ok: false, error: '`mine=1` requires `codeep account` login.' };

  try {
    const u = new URL(`${API_BASE}/api/skills`);
    if (opts.query) u.searchParams.set('q', opts.query);
    if (opts.mine) u.searchParams.set('mine', '1');
    const res = await fetch(u.toString(), { headers });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; skills?: RemoteSkill[]; error?: string };
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, skills: data.skills ?? [] };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Unpublish a skill (owner only). */
export async function unpublishBundle(idOrPath: string): Promise<{ ok: boolean; error?: string }> {
  const token = getSyncToken();
  if (!token) return { ok: false, error: 'Not linked to codeep.dev — run `codeep account` first.' };
  try {
    const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(idOrPath)}`, {
      method: 'DELETE',
      headers: { 'x-sync-token': token },
    });
    if (res.status === 404) return { ok: false, error: 'Skill not found (or not yours).' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Re-serialise a loaded SkillBundle back into the SKILL.md text format.
 * Used by publish so the round-trip is lossless (sort of — we drop
 * unknown frontmatter keys for now to keep the published format stable).
 */
function serialiseSkillMd(bundle: SkillBundle): string {
  const meta: string[] = ['---'];
  meta.push(`name: ${bundle.name}`);
  meta.push(`description: ${bundle.description}`);
  if (bundle.version) meta.push(`version: ${bundle.version}`);
  if (bundle.author) meta.push(`author: ${bundle.author}`);
  if (bundle.codeepMinVersion) meta.push(`codeep-min-version: ${bundle.codeepMinVersion}`);
  if (bundle.requiresMcp.length) {
    meta.push(`codeep-requires-mcp:`);
    for (const s of bundle.requiresMcp) meta.push(`  - ${s}`);
  }
  if (bundle.allowedTools.length) {
    meta.push(`allowed-tools:`);
    for (const s of bundle.allowedTools) meta.push(`  - ${s}`);
  }
  if (bundle.triggers.length) {
    meta.push(`triggers:`);
    for (const s of bundle.triggers) meta.push(`  - ${s}`);
  }
  meta.push('---', '');
  return meta.join('\n') + bundle.body;
}

/** Read raw SKILL.md from disk — used when we want the unmodified bytes. */
export function readRawSkillMd(workspaceRoot: string, slug: string): string | null {
  const file = join(workspaceRoot, '.codeep', 'skills', slug, 'SKILL.md');
  if (!existsSync(file)) return null;
  try { return readFileSync(file, 'utf-8'); } catch { return null; }
}

/** Delete the local copy of an installed skill bundle (for /skills uninstall). */
export function uninstallLocalBundle(workspaceRoot: string, slug: string): boolean {
  const dir = join(workspaceRoot, '.codeep', 'skills', slug);
  if (!existsSync(dir)) return false;
  try { rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

// Silence unused-import warning when builds strip unused — homedir is here
// for future global-install support (planned 2.1).
void homedir;
