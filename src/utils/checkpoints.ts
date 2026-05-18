/**
 * Session checkpoints — `/checkpoint` and `/rewind`.
 *
 * A checkpoint is a snapshot of the agent conversation at a point in time:
 * session history, provider/model state, and the list of files the agent has
 * touched in this session. It does NOT snapshot file content — that's git's
 * job, and trying to do it ourselves means either a 100KB-per-file ceiling
 * with surprise truncation, or a real-time disk hog. We surface a hint at
 * rewind time telling the user how to restore files via git.
 *
 * Use cases this is for:
 *   - User suspects the agent is going off the rails after N steps and
 *     wants to roll the conversation back to before that turn.
 *   - User is about to start a risky multi-step refactor and wants a
 *     named bookmark to return to if it gets messy.
 *
 * Use cases this is NOT for:
 *   - Replacing git. If you only need file rollback, `git restore` /
 *     `git stash` is faster and reliable.
 *   - Cross-session persistence beyond the workspace's `.codeep/checkpoints/`
 *     folder — checkpoints are per-project, not global.
 *
 * On-disk shape (`.codeep/checkpoints/<id>.json`):
 * {
 *   "id": "ck-2026-05-18-abc123",
 *   "name": "before big refactor",
 *   "createdAt": "...",
 *   "sessionId": "session-2026-05-18-...",
 *   "provider": "z.ai",
 *   "model": "glm-5.1",
 *   "messages": [ ... ],
 *   "filesTouched": ["src/a.ts", "src/b.ts"],
 *   "gitHead": "abcdef0"        // optional, recorded only if cwd is a git repo
 * }
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

import type { Message } from '../config/index.js';

export interface Checkpoint {
  id: string;
  name?: string;
  createdAt: string;
  sessionId: string;
  provider: string;
  model: string;
  messages: Message[];
  filesTouched: string[];
  gitHead?: string;
}

/** Lightweight metadata for `/checkpoints` list — avoids loading full message arrays. */
export interface CheckpointMeta {
  id: string;
  name?: string;
  createdAt: string;
  sessionId: string;
  messageCount: number;
  filesTouchedCount: number;
  gitHead?: string;
}

function getCheckpointsDir(workspaceRoot: string): string {
  const dir = join(workspaceRoot, '.codeep', 'checkpoints');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readGitHead(workspaceRoot: string): string | undefined {
  try {
    // Short SHA is enough for human display; full SHA available via git if needed.
    const out = execSync('git rev-parse --short HEAD', {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generate a unique, human-recognizable checkpoint id.
 * Format: `ck-YYYY-MM-DD-<8-char-uuid>`
 */
function generateCheckpointId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `ck-${date}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a new checkpoint snapshot of the current session state.
 * Returns the persisted checkpoint object.
 */
export function createCheckpoint(opts: {
  workspaceRoot: string;
  sessionId: string;
  provider: string;
  model: string;
  messages: Message[];
  filesTouched: string[];
  name?: string;
}): Checkpoint {
  const checkpoint: Checkpoint = {
    id: generateCheckpointId(),
    name: opts.name,
    createdAt: new Date().toISOString(),
    sessionId: opts.sessionId,
    provider: opts.provider,
    model: opts.model,
    messages: opts.messages,
    filesTouched: opts.filesTouched,
    gitHead: readGitHead(opts.workspaceRoot),
  };

  const dir = getCheckpointsDir(opts.workspaceRoot);
  writeFileSync(join(dir, `${checkpoint.id}.json`), JSON.stringify(checkpoint, null, 2));
  return checkpoint;
}

/**
 * Load a single checkpoint by id. Returns null if not found or unreadable.
 */
export function loadCheckpoint(workspaceRoot: string, id: string): Checkpoint | null {
  // Defensive: reject ids that look like path traversal attempts. Real ids are
  // `ck-YYYY-MM-DD-<hex>` so the regex is tight enough to catch typos too.
  if (!/^ck-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/.test(id)) return null;
  const file = join(getCheckpointsDir(workspaceRoot), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * List checkpoints in the workspace, newest first. Returns metadata only —
 * the full `messages` array is not loaded so this is cheap for `/checkpoints`.
 */
export function listCheckpoints(workspaceRoot: string): CheckpointMeta[] {
  const dir = getCheckpointsDir(workspaceRoot);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const metas: CheckpointMeta[] = [];
  for (const file of files) {
    try {
      const full = join(dir, file);
      const stat = statSync(full);
      const cp = JSON.parse(readFileSync(full, 'utf-8')) as Checkpoint;
      metas.push({
        id: cp.id,
        name: cp.name,
        createdAt: cp.createdAt || stat.mtime.toISOString(),
        sessionId: cp.sessionId,
        messageCount: cp.messages?.length ?? 0,
        filesTouchedCount: cp.filesTouched?.length ?? 0,
        gitHead: cp.gitHead,
      });
    } catch {
      // Skip corrupt entries — don't let one bad checkpoint block the list.
    }
  }
  // Newest first by createdAt.
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return metas;
}

/**
 * Delete a checkpoint by id. Returns true if a file was removed.
 */
export function deleteCheckpoint(workspaceRoot: string, id: string): boolean {
  if (!/^ck-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/.test(id)) return false;
  const file = join(getCheckpointsDir(workspaceRoot), `${id}.json`);
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a checkpoint list as a Markdown block for `/checkpoints` output.
 */
export function formatCheckpointList(metas: CheckpointMeta[]): string {
  if (metas.length === 0) {
    return [
      '_No checkpoints yet._',
      '',
      'Create one with `/checkpoint [name]` before risky refactors so you can `/rewind` if things go sideways.',
    ].join('\n');
  }
  const lines: string[] = ['## Checkpoints', ''];
  for (const m of metas) {
    const label = m.name ? `**${m.name}** (\`${m.id}\`)` : `\`${m.id}\``;
    const gitFragment = m.gitHead ? ` · git \`${m.gitHead}\`` : '';
    const date = m.createdAt.slice(0, 19).replace('T', ' ');
    lines.push(
      `- ${label}`,
      `  ${date} · ${m.messageCount} message${m.messageCount === 1 ? '' : 's'} · ${m.filesTouchedCount} file${m.filesTouchedCount === 1 ? '' : 's'} touched${gitFragment}`,
    );
  }
  lines.push('', 'Use `/rewind <id>` to restore a checkpoint, or `/checkpoint delete <id>` to drop one.');
  return lines.join('\n');
}

/**
 * Build the user-facing hint shown after a successful /rewind. Tells the
 * user how to bring their files back to checkpoint state — checkpoints
 * don't snapshot file content, so this is the only restore path.
 */
export function buildRewindGitHint(cp: Checkpoint): string {
  if (cp.gitHead) {
    return [
      `**Files were NOT restored** — only the conversation. To bring files back to the state at checkpoint time:`,
      '',
      '```bash',
      `git stash  # save current uncommitted changes if you want to keep them`,
      `git checkout ${cp.gitHead} -- ${cp.filesTouched.length > 0 ? cp.filesTouched.map(f => `'${f}'`).join(' ') : '.'}`,
      '```',
    ].join('\n');
  }
  return [
    '**Files were NOT restored** — only the conversation.',
    cp.filesTouched.length > 0
      ? `Files the agent touched between checkpoint and now: ${cp.filesTouched.map(f => `\`${f}\``).join(', ')}.`
      : '',
    'Use `git` (or your editor\'s undo) to revert any file changes you don\'t want.',
  ].filter(Boolean).join('\n');
}
