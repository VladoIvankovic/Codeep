/**
 * Recording a finished turn in an ACP thread's conversation.
 */

import { config, saveSession, type Message } from '../config/index.js';

/** The part of a session a turn needs. */
export interface TurnSession {
  workspaceRoot: string;
  history: Message[];
  codeepSessionId: string;
  /** Bumped whenever the thread moves to another conversation. */
  conversation?: number;
}

/**
 * Start a turn: returns the function that records its messages once it ran.
 * If the thread moved to another conversation meanwhile, the turn belongs to
 * the one it started in — it is saved there, not appended to the new one —
 * and after a /rewind of that same conversation it is dropped, since saving
 * it would undo the rewind.
 */
export function beginTurn(session: TurnSession): (entries: Message[]) => void {
  const conversation = session.conversation ?? 0;
  const id = session.codeepSessionId;
  const history = session.history;
  return (entries) => {
    const autoSave = config.get('autoSave');
    if ((session.conversation ?? 0) === conversation) {
      session.history.push(...entries);
      if (autoSave && session.history.length > 0) saveSession(session.codeepSessionId, session.history, session.workspaceRoot);
      return;
    }
    if (id === session.codeepSessionId) return;
    history.push(...entries);
    if (autoSave) saveSession(id, history, session.workspaceRoot);
  };
}

