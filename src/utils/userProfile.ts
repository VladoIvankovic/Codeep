/**
 * User Profile — a durable, human-readable description of the user that
 * personalises how the agent works. It is injected into the system prompt so
 * every surface (CLI, ACP, VS Code, Zed) adapts the same way, because they all
 * run through agent.ts.
 *
 * Storage (both optional, both injected when present):
 *   - **Global**:  `~/.codeep/profile.md`           — who the user is across
 *     all projects: preferred reply language, response style, default stack,
 *     hard "always / never" values.
 *   - **Project**: `<workspace>/.codeep/profile.md`  — what THIS project is to
 *     the user: their role, goals, constraints, "don't touch" notes.
 *
 * Global is injected first, the project profile second, so the project context
 * sits closest to the task and can refine/extend the global one.
 *
 * This file is written by the user — via `/me` or by hand. There is NO
 * automatic extraction in this phase, so injecting it carries no surprise.
 * Injection is gated by `config.userProfile` (default true); set it false to
 * disable entirely.
 *
 * NOTE: This is distinct from the provider "profiles" feature (saved
 * provider+model combos in config.json, see config/index.ts). Different
 * concept, different storage, different command (`/me` vs `/profile`).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { config } from '../config/index.js';

/** A minimal chat message shape (avoids importing the heavier Message type). */
type ChatMsg = { role: string; content: string };

/** Max bytes read from each profile file — keeps the prompt budget bounded. */
const MAX_PROFILE_BYTES = 8 * 1024;

export function globalProfilePath(): string {
  return join(homedir(), '.codeep', 'profile.md');
}

export function projectProfilePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.codeep', 'profile.md');
}

/**
 * Auto-learned facts files. Kept SEPARATE from the user-authored profile.md so
 * the learning pass never touches what the user wrote by hand. Populated only
 * when `autoLearnProfile` is on (or via `/me learn`).
 *   - Global  (`~/.codeep/profile.learned.md`):  cross-project facts about the
 *     user (reply language, style, general stack, universal always/never).
 *   - Project (`<root>/.codeep/profile.learned.md`): facts specific to working
 *     on THIS project (role, goals, constraints, project conventions stated).
 */
export function globalLearnedProfilePath(): string {
  return join(homedir(), '.codeep', 'profile.learned.md');
}

export function projectLearnedProfilePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.codeep', 'profile.learned.md');
}

export type LearnScope = 'global' | 'project';

/** Read + trim a profile file, capped. Returns '' when missing/empty/broken. */
function readProfile(path: string): string {
  try {
    if (!existsSync(path)) return '';
    let content = readFileSync(path, 'utf-8');
    if (content.length > MAX_PROFILE_BYTES) content = content.slice(0, MAX_PROFILE_BYTES);
    return content.trim();
  } catch {
    return '';
  }
}

/**
 * Build the system-prompt addendum describing the user. Returns '' when
 * injection is disabled or when neither profile file exists. Never throws.
 */
export function loadUserProfilePrompt(workspaceRoot?: string): string {
  if (config.get('userProfile') === false) return '';
  const sections: string[] = [];
  const global = readProfile(globalProfilePath());
  if (global) sections.push(global);
  if (workspaceRoot) {
    const project = readProfile(projectProfilePath(workspaceRoot));
    if (project) sections.push(project);
  }
  // Auto-learned facts (if any) come last — they're observations, so the
  // hand-written profile takes visual precedence. Each file self-labels with
  // its own heading. Global learned first, then project learned.
  const learnedGlobal = readProfile(globalLearnedProfilePath());
  if (learnedGlobal) sections.push(learnedGlobal);
  if (workspaceRoot) {
    const learnedProject = readProfile(projectLearnedProfilePath(workspaceRoot));
    if (learnedProject) sections.push(learnedProject);
  }
  if (sections.length === 0) return '';
  return `\n\n## About the User\nThe user shared the following about themselves and how they like to work. Honor it throughout: respond in their preferred language, match their requested style, and respect their stated preferences. (Project rules in .codeep/rules.md still take precedence on any conflict.)\n\n${sections.join('\n\n---\n\n')}`;
}

// ─── /me command helpers ────────────────────────────────────────────────────

export interface ProfileStatus {
  enabled: boolean;
  autoLearn: boolean;
  globalPath: string;
  globalExists: boolean;
  projectPath: string | null;
  projectExists: boolean;
  learnedGlobalPath: string;
  learnedGlobalExists: boolean;
  learnedProjectPath: string | null;
  learnedProjectExists: boolean;
}

export function getProfileStatus(workspaceRoot?: string): ProfileStatus {
  const globalPath = globalProfilePath();
  const projectPath = workspaceRoot ? projectProfilePath(workspaceRoot) : null;
  const learnedGlobalPath = globalLearnedProfilePath();
  const learnedProjectPath = workspaceRoot ? projectLearnedProfilePath(workspaceRoot) : null;
  return {
    enabled: config.get('userProfile') !== false,
    autoLearn: config.get('autoLearnProfile') === true,
    globalPath,
    globalExists: existsSync(globalPath),
    projectPath,
    projectExists: projectPath ? existsSync(projectPath) : false,
    learnedGlobalPath,
    learnedGlobalExists: existsSync(learnedGlobalPath),
    learnedProjectPath,
    learnedProjectExists: learnedProjectPath ? existsSync(learnedProjectPath) : false,
  };
}

const GLOBAL_TEMPLATE = `# About Me

<!-- Codeep reads this file and adapts to you on every project. Write in any
     language. Keep it short — it is added to the agent's context on each
     request. Delete the hints you don't use. -->

## Preferences
- Reply language:
- Response style: (concise / detailed)
- Explain before making changes: (yes / no)

## My stack
- Languages:
- Frameworks / tools:

## Always / Never
- Always:
- Never:
`;

const PROJECT_TEMPLATE = `# About This Project (for me)

<!-- Project-specific context Codeep should know when working here. This sits
     alongside .codeep/rules.md, which is for hard project rules. -->

## My role on this project


## Goals


## Constraints / don't touch


## Deploy target
`;

/**
 * Create a starter profile file if it doesn't exist. Never clobbers existing
 * content. Returns the path + whether it was created, or null on failure.
 */
export function scaffoldProfile(
  scope: 'global' | 'project',
  workspaceRoot?: string,
): { path: string; created: boolean } | null {
  let path: string;
  if (scope === 'global') {
    path = globalProfilePath();
  } else {
    if (!workspaceRoot) return null;
    path = projectProfilePath(workspaceRoot);
  }
  if (existsSync(path)) return { path, created: false };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, scope === 'global' ? GLOBAL_TEMPLATE : PROJECT_TEMPLATE, 'utf-8');
    return { path, created: true };
  } catch {
    return null;
  }
}

/** Render the `/me` view: injection state, file paths, and current content. */
export function formatProfileView(workspaceRoot?: string): string {
  const st = getProfileStatus(workspaceRoot);
  const lines: string[] = ['## Your Codeep Profile', ''];
  lines.push(
    st.enabled
      ? "**Injection:** on — your profile is added to the agent's context each request. Disable with `/me off`."
      : '**Injection:** off — profile is saved but not used. Enable with `/me on`.',
  );
  lines.push(
    st.autoLearn
      ? '**Auto-learn:** on — Codeep updates a learned profile from your sessions. Turn off with `/me learn off`; clear with `/me forget`.'
      : "**Auto-learn:** off — Codeep won't observe sessions. Turn on with `/me learn on`, or run `/me learn` once.",
  );
  lines.push('');
  lines.push('| Scope | File | Status |');
  lines.push('|---|---|---|');
  lines.push(`| Global | \`${st.globalPath}\` | ${st.globalExists ? 'present' : 'not created'} |`);
  if (st.projectPath) {
    lines.push(`| Project | \`${st.projectPath}\` | ${st.projectExists ? 'present' : 'not created'} |`);
  }
  lines.push(`| Learned · global (auto) | \`${st.learnedGlobalPath}\` | ${st.learnedGlobalExists ? 'present' : 'not created'} |`);
  if (st.learnedProjectPath) {
    lines.push(`| Learned · project (auto) | \`${st.learnedProjectPath}\` | ${st.learnedProjectExists ? 'present' : 'not created'} |`);
  }
  lines.push('');

  const globalRaw = readProfile(globalProfilePath());
  const projectRaw = workspaceRoot ? readProfile(projectProfilePath(workspaceRoot)) : '';
  const learnedGlobalRaw = readProfile(globalLearnedProfilePath());
  const learnedProjectRaw = workspaceRoot ? readProfile(projectLearnedProfilePath(workspaceRoot)) : '';
  if (!globalRaw && !projectRaw && !learnedGlobalRaw && !learnedProjectRaw) {
    lines.push('No profile yet. Run `/me init` to scaffold a global template (or `/me init project` for this project), then edit the file. Or let Codeep build one for you with `/me learn on`.');
  } else {
    if (globalRaw) {
      lines.push('### Global', '```md', globalRaw, '```', '');
    }
    if (projectRaw) {
      lines.push('### Project', '```md', projectRaw, '```', '');
    }
    if (learnedGlobalRaw) {
      lines.push('### Learned · global (auto)', '```md', learnedGlobalRaw, '```', '');
    }
    if (learnedProjectRaw) {
      lines.push('### Learned · project (auto)', '```md', learnedProjectRaw, '```', '');
    }
    lines.push('Edit the hand-written file(s) above to update. `/me init [project]` scaffolds a starter; `/me forget` clears the learned sections.');
  }
  return lines.join('\n');
}

// ─── Auto-learn (Phase 2) ────────────────────────────────────────────────────

/** Pull clean "- " bullet lines out of an LLM response (capped at 15). */
function parseFactBullets(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && l.length > 2)
    .slice(0, 15);
}

const GLOBAL_LEARN_SYSTEM = `You maintain a durable, cross-project profile of a software developer so an AI coding agent can adapt to them.
Given the EXISTING facts and a RECENT conversation, output an UPDATED bullet list of stable, GENERAL facts about the USER: preferred reply language, communication style, tech stack they use broadly, and universal instructions ("always/never…").
Rules:
- Keep existing facts unless the conversation clearly contradicts them (newer wins).
- Merge duplicates. One fact per line, each starting with "- ". Max 15 lines.
- ONLY durable, cross-project preferences about the person. NEVER one-off task details, file names, bug specifics, or anything tied to a single project.
- If the conversation reveals nothing durable, return the existing list unchanged.
- Output ONLY the bullet list. No preamble, no headings, no commentary.`;

const PROJECT_LEARN_SYSTEM = `You maintain notes about how a specific developer works on ONE particular software project, so an AI coding agent can adapt while working in this repo.
Given the EXISTING notes and a RECENT conversation, output an UPDATED bullet list of facts specific to THIS PROJECT: the user's role/goals here, constraints, conventions or instructions they established for this codebase, and "don't touch" areas.
Rules:
- Keep existing notes unless the conversation clearly contradicts them (newer wins).
- Merge duplicates. One fact per line, each starting with "- ". Max 15 lines.
- ONLY project-specific facts. Do NOT record generic personal preferences (reply language, code style) — those belong in the global profile.
- Skip transient task details (specific bugs, one-off file edits).
- If the conversation reveals nothing durable about the project, return the existing list unchanged.
- Output ONLY the bullet list. No preamble, no headings, no commentary.`;

/**
 * Observe a conversation and update an auto-learned profile via one cheap LLM
 * pass that MERGES new durable facts with the existing ones (dedup, newer-wins,
 * capped). `scope` selects the global profile (cross-project, about the person)
 * or the project profile (this repo only; needs `workspaceRoot`). Returns the
 * resulting facts (`updated` = whether the file changed), or null when there's
 * nothing to learn / the call fails. Never throws.
 *
 * Gating (`autoLearnProfile`) is the caller's job for the automatic path;
 * `/me learn` calls this directly on demand.
 */
export async function updateLearnedProfile(
  history?: ChatMsg[],
  scope: LearnScope = 'global',
  workspaceRoot?: string,
): Promise<{ updated: boolean; facts: string } | null> {
  try {
    const targetPath = scope === 'global'
      ? globalLearnedProfilePath()
      : (workspaceRoot ? projectLearnedProfilePath(workspaceRoot) : null);
    if (!targetPath) return null;

    const convo = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (convo.length === 0) return null;

    const transcript = convo
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 600)}`)
      .join('\n')
      .slice(0, 24000);

    const existingFacts = parseFactBullets(readProfile(targetPath)).join('\n');
    const system = scope === 'global' ? GLOBAL_LEARN_SYSTEM : PROJECT_LEARN_SYSTEM;
    const user = `EXISTING FACTS:\n${existingFacts || '(none yet)'}\n\nRECENT CONVERSATION:\n${transcript}`;

    const { chat } = await import('../api/index.js');
    const raw = (await chat(user, [{ role: 'system', content: system }])).trim();
    const bullets = parseFactBullets(raw);
    if (bullets.length === 0) return null;

    const facts = bullets.join('\n');
    if (facts === existingFacts) return { updated: false, facts };

    const heading = scope === 'global'
      ? 'What Codeep has learned about me'
      : 'What Codeep has learned about this project';
    const content = `# ${heading}\n\n<!-- Auto-observed from your Codeep sessions. Edit freely, clear with \`/me forget\`, or turn off with \`/me learn off\`. -->\n\n${facts}\n`;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
    return { updated: true, facts };
  } catch {
    return null;
  }
}

// Throttle so the 5s autosave cadence doesn't spawn an LLM call every tick:
// only learn once the session grew by a few messages, one in-flight per session.
const learnedAtMsgCount = new Map<string, number>();
const learnInFlight = new Set<string>();
const LEARN_MIN_NEW_MESSAGES = 6;

/**
 * Auto-learn entry point for the session-save hook. No-ops unless the user
 * opted in (`autoLearnProfile`) and enough new messages have accrued. Safe to
 * call on every save — fire-and-forget.
 */
export async function maybeLearnUserProfile(
  sessionName: string,
  history: ChatMsg[],
  workspaceRoot?: string,
): Promise<void> {
  if (config.get('autoLearnProfile') !== true) return;
  if (config.get('userProfile') === false) return;
  if (learnInFlight.has(sessionName)) return;
  const count = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant').length;
  if (count - (learnedAtMsgCount.get(sessionName) ?? 0) < LEARN_MIN_NEW_MESSAGES) return;

  learnInFlight.add(sessionName);
  try {
    await updateLearnedProfile(history, 'global');
    if (workspaceRoot) await updateLearnedProfile(history, 'project', workspaceRoot);
    learnedAtMsgCount.set(sessionName, count);
  } catch {
    /* never block a session save */
  } finally {
    learnInFlight.delete(sessionName);
  }
}

/**
 * Delete the auto-learned profile(s): always the global one, plus the project
 * one when a workspace root is given. Returns true if any file was removed.
 */
export function clearLearnedProfile(workspaceRoot?: string): boolean {
  let removed = false;
  const paths = [
    globalLearnedProfilePath(),
    workspaceRoot ? projectLearnedProfilePath(workspaceRoot) : null,
  ];
  for (const p of paths) {
    if (p && existsSync(p)) {
      try { rmSync(p); removed = true; } catch { /* ignore */ }
    }
  }
  learnedAtMsgCount.clear();
  return removed;
}
