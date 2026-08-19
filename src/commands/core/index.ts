// commands/core/index.ts
// Shared command core — single implementation of command semantics used by
// BOTH dispatch surfaces (TUI renderer/commands.ts and ACP acp/commands.ts).
//
// Problem this solves: ~40 commands are implemented twice with different
// presentation (TUI: app.notify / interactive pickers; ACP: response
// strings). Every behavior change had to be made twice, and they drifted.
//
// Contract: a core command does validation + state mutation and returns a
// CommandResult — plain data describing the outcome. The surface adapter
// (TUI or ACP) renders that result in its own style. Side-effectful UI
// (pickers, dialogs) stays in the surface layer; pure decisions live here.
//
// Migration is incremental: each command moves over one at a time, in its
// own change, with the old inline branches deleted only once both surfaces
// call the core.

/** Result of executing a core command. Plain data — no UI. */
export interface CommandResult {
  /** Outcome for the user, in a presentation-neutral voice. */
  message: string;
  /** Severity hints the surface's rendering (banner vs error style). */
  kind?: 'ok' | 'info' | 'warn' | 'error';
  /** Optional follow-up action the surface may offer (unused for now). */
  hint?: string;
}

/** Context a core command may need. All fields optional — commands declare
 *  what they use via their signature, surfaces pass what they have. */
export interface CoreCommandContext {
  /** Raw args after the command name (e.g. ['on'] for `/telemetry on`). */
  args: string[];
}

export function ok(message: string): CommandResult {
  return { message, kind: 'ok' };
}

export function info(message: string): CommandResult {
  return { message, kind: 'info' };
}

export function warn(message: string): CommandResult {
  return { message, kind: 'warn' };
}

export function error(message: string): CommandResult {
  return { message, kind: 'error' };
}
