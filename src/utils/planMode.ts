/**
 * Plan mode — explicit pre-execution preview.
 *
 * Flow:
 *   1. User runs `/plan <task>` — we ask the LLM for a numbered plan
 *      (no tool calls, no file changes) and surface it to the user.
 *   2. We hold the (task, plan) pair as the *pending* plan, scoped to
 *      the current process.
 *   3. User runs `/go` to execute, or `/plan <revised task>` to refine.
 *      `/go` hands the original task + approved plan to the regular
 *      agent loop as a single prompt, so the existing tool execution,
 *      verification, and permission paths apply unchanged.
 *
 * Why this design (MVP):
 *   - Zero changes to the agent loop, MCP wiring, or ACP server.
 *   - Plan rendering reuses the chat markdown renderer (no new TUI
 *     panel to maintain).
 *   - Edit flow is just "/plan <revised task>" — generates a new plan
 *     that replaces the pending one; user pays one extra LLM call but
 *     gets human-readable revision history in the chat above.
 *   - When we ship a proper plan-mode UI later (TUI panel with
 *     Accept/Edit/Reject buttons + per-step progress), it can keep
 *     using this module as the backend.
 */

import type { Message } from '../config/index.js';
import { chat } from '../api/index.js';

const PLAN_SYSTEM_PROMPT = `You are in PLAN MODE.

The user has given you a task. **Do not execute anything.** Do not call
tools. Do not modify files. Do not run shell commands. Instead, produce
a numbered plan of the steps you would take, so the user can review and
approve before any changes happen.

Format your response as Markdown:

## Plan: <one-line summary of the task>

1. **<short step name>** — what you'd do (e.g. read file, edit lines, run command).
   _Why:_ rationale (1 sentence).
   _Expected outcome:_ what the user should see after this step.

2. **<step name>** — …

(continue numbering)

End with these three lines (verbatim labels, fill in values):

**Risk:** <low | medium | high> — <one-sentence reason; e.g. "schema change, requires migration">
**Files affected:** <comma-separated list of paths you'd touch, or "none">
**Commands run:** <comma-separated shell commands, or "none">

Rules:
- Be concrete. Reference real file paths from the project if you know them.
- Keep steps small enough that each maps to one or two tool calls when
  later executed.
- If the task is ambiguous, list the assumption(s) you're making at the
  top of the plan ("Assumes: ...") so the user can correct before /go.
- Do NOT produce code — describe what you'd change, not the change
  itself. Code generation belongs in execution, not planning.
- If the task is trivial (single-file rename, single-line edit), say so
  in one sentence and skip the formal plan — don't bloat tiny work.`;

export interface PendingPlan {
  task: string;
  plan: string;
  createdAt: number;
}

let pending: PendingPlan | null = null;

/**
 * Ask the model for a plan for the given task. Stores the (task, plan)
 * pair as the pending plan so a subsequent `/go` can execute it.
 * Throws on chat failure — caller renders the error.
 */
export async function generatePlan(
  task: string,
  onChunk?: (text: string) => void,
): Promise<string> {
  const history: Message[] = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
  ];
  const plan = await chat(task, history, onChunk);
  pending = { task, plan, createdAt: Date.now() };
  return plan;
}

export function getPendingPlan(): PendingPlan | null {
  return pending;
}

export function clearPendingPlan(): void {
  pending = null;
}

/**
 * Compose the prompt the agent loop receives when the user runs `/go`.
 * The agent treats this as a normal task, so tool calls / verification /
 * permissions / hooks all flow through the existing paths — we just
 * front-load the plan as context so the model doesn't re-plan
 * implicitly.
 */
export function composeExecutionPrompt(plan: PendingPlan): string {
  return `${plan.task}

I've reviewed the following plan and approved it. Execute it step by step. If any step turns out to be wrong or impossible mid-execution, stop and report — don't silently improvise.

${plan.plan}`;
}
