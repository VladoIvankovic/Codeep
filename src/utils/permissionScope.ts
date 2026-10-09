/**
 * What an "Always Allow" answer covers, and how long it lasts.
 *
 * It used to cover the whole TOOL for the rest of ONE run. Answering it to a
 * `php artisan migrate` allowed every command the agent ran until the run
 * ended, which is more than anyone meant by "php" — and the next prompt asked
 * about `php` again, which read as the answer not having been kept at all.
 * Now:
 *
 *  - a command is allowed by its program. "Always Allow php" lets `php`
 *    through with any arguments (the allowlist and the inline-code flags in
 *    shell.ts still apply to it); `npm` still asks;
 *  - any other tool is allowed by its name, as before;
 *  - the answer is kept for the chat — until a new chat is started or Codeep
 *    ends — and not for one run. A chat is a Codeep session (the TUI's session
 *    id; an ACP session's current conversation), so `/new`, loading another
 *    session and `/session new` start with nothing allowed, and a chat that
 *    is renamed or deleted takes its answers with it.
 *
 * A "Deny" is kept no longer than a run. The TUI's only "no" answers
 * reject_always, and for the session it would turn a tool off after one
 * misclick (agent.ts says the same about a refused file).
 */

import type { ToolCall } from './tools';
import { showControlsInline } from './controlChars';

export interface AlwaysAllowScope {
  /** The entry the always-allowed set holds for this call. */
  key: string;
  /** What the dialog calls it: the program of a command, else the tool. */
  name: string;
}

/**
 * What allowing this call "always" would let through later. The program is
 * the `command` exactly as the model wrote it, not a guess at what it means:
 * `/usr/bin/php` is not `php`, and a command line stuffed into `command`
 * ("php -v; ls") is its own entry that nothing else matches. An empty one
 * matches nothing that can run.
 */
export function alwaysAllowScope(toolCall: Pick<ToolCall, 'tool' | 'parameters'>): AlwaysAllowScope {
  if (toolCall.tool === 'execute_command') {
    const command = toolCall.parameters?.command;
    const program = typeof command === 'string' ? command.trim() : '';
    return { key: `execute_command:${program}`, name: program || 'execute_command' };
  }
  return { key: toolCall.tool, name: toolCall.tool };
}

/** Longest name the button shows, in characters. The dialog lays its buttons
 *  out in one row — "► Allow", "  Deny", then this one from column 23 — so
 *  13 + 27 + 15 columns of ASCII end exactly at column 80 of a standard
 *  terminal. Counted in code points, not UTF-16 units; a wide character still
 *  takes two columns, and the terminal clips what does not fit. */
const MAX_NAME_CHARS = 27;

/** The button for a call's "Always Allow", saying what it covers and for how
 *  long. The name is model-written text: its control characters are spelled
 *  out, as in the rest of the dialog. */
export function alwaysAllowLabel(toolCall: Pick<ToolCall, 'tool' | 'parameters'>): string {
  const letters = [...showControlsInline(alwaysAllowScope(toolCall).name)];
  const shown = letters.length > MAX_NAME_CHARS ? `${letters.slice(0, MAX_NAME_CHARS - 1).join('')}…` : letters.join('');
  return `Always Allow ${shown} (this session)`;
}

/** What the agent remembers between answers: the shape runAgent's
 *  `permissionMemory` takes. */
export interface PermissionMemory {
  alwaysAllowed: Set<string>;
  alwaysRejected: Set<string>;
  alwaysRejectedPaths: Set<string>;
}

/** The always-allowed sets of a number of chats, by chat id. */
export type PermissionStore = Map<string, Set<string>>;

/**
 * The memory for one run of the chat `chatId` in `store`: the chat's
 * always-allowed set, shared by every run of it, and a fresh set of refusals,
 * which end with the run.
 */
export function permissionMemoryIn(store: PermissionStore, chatId: string): PermissionMemory {
  let allowed = store.get(chatId);
  if (!allowed) {
    allowed = new Set();
    store.set(chatId, allowed);
  }
  return { alwaysAllowed: allowed, alwaysRejected: new Set(), alwaysRejectedPaths: new Set() };
}

/** The TUI's: one per process, by session id. An ACP session keeps its own on
 *  the session object (`permissionStore`), which goes with it. */
const allowedBySession: PermissionStore = new Map();

export function sessionPermissionMemory(sessionId: string): PermissionMemory {
  return permissionMemoryIn(allowedBySession, sessionId);
}

/** Forget what a session allowed — one session, or all of them. */
export function forgetSessionPermissions(sessionId?: string): void {
  if (sessionId === undefined) allowedBySession.clear();
  else allowedBySession.delete(sessionId);
}

/**
 * A session was renamed: the chat goes on under its new name with what it had
 * allowed, and the old name — which another chat may take — keeps nothing.
 * Whatever the new name held before belonged to a chat that is gone.
 */
export function moveSessionPermissions(from: string, to: string): void {
  if (from === to) return;
  const allowed = allowedBySession.get(from);
  allowedBySession.delete(from);
  if (allowed) allowedBySession.set(to, allowed);
  else allowedBySession.delete(to);
}
