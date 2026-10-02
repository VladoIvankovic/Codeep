/**
 * Whether the agent stops to ask in this process — the one place the
 * terminal asks for it: the confirmation mode, and whether a vague task gets
 * clarifying questions before it runs.
 *
 * Usually those are the `agentConfirmation` and `agentInteractive` config.
 * `codeep --yolo` pins them to 'never' and off for this process, and the pins
 * are never written back: the config file is shared by every Codeep on the
 * machine — the next plain `codeep`, the ACP server an editor starts — and a
 * launch that saved its 'never' there would quietly switch the confirmations
 * off in all of them, the leak acp/serverHandlers.ts's handleSetMode refuses
 * to cause for the same reason. A reader that went to the config itself
 * would ask when --yolo said nothing would, which is a run sitting at a
 * prompt nobody is there to answer.
 *
 * /settings and saved profiles read the config directly, on purpose: they
 * show and copy what is stored, not what this launch happens to run with.
 * Choosing a value in /settings is a decision about this run as well, so it
 * ends that setting's pin (Settings.ts writeSetting): someone who launched
 * with --yolo and then picks Always is asked from then on, as the row says.
 */

import { config, type ConfigSchema } from '../config/index';

export type AgentConfirmation = ConfigSchema['agentConfirmation'];

let pinned: AgentConfirmation | null = null;
let pinnedInteractive: boolean | null = null;

/** Run with `mode` for the rest of this process, whatever the config says,
 *  or go back to the config with null. Never persisted. */
export function pinAgentConfirmation(mode: AgentConfirmation | null): void {
  pinned = mode;
}

/** The mode to act on now: the pin when there is one, else the config. */
export function agentConfirmationMode(): AgentConfirmation {
  return pinned ?? (config.get('agentConfirmation') || 'dangerous');
}

/** Whether a pin, not the config, decides the confirmation mode — what the
 *  status bar's YOLO badge shows. */
export function isAgentConfirmationPinned(): boolean {
  return pinned !== null;
}

/** Ask clarifying questions before a run (true) or not (false) for the rest
 *  of this process, or go back to the config with null. Never persisted. */
export function pinAgentInteractive(on: boolean | null): void {
  pinnedInteractive = on;
}

/** Whether a vague task gets clarifying questions first: the pin when there
 *  is one, else the config, which is on unless set off. */
export function agentInteractiveMode(): boolean {
  return pinnedInteractive ?? config.get('agentInteractive') !== false;
}
