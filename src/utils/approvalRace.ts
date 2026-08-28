/**
 * One question, two places it can be answered, and exactly one answer.
 *
 * The terminal and the phone are both live at once. Whichever comes back first
 * decides, and the other has to be taken down — a dialog left on screen after
 * the phone answered would ask again, and a Telegram message left with three
 * live buttons invites a tap that can no longer do anything.
 *
 * Kept apart from the agent loop and from the Telegram client because the part
 * that goes wrong is the ordering, and the ordering can be tested with two
 * promises and no network.
 */

export interface RaceParticipant<T> {
  /** Resolves when this side is answered. Must never reject: a rejection here
   *  would take down a run over a failure to *ask*, which is not the same thing
   *  as a denial and must not be treated as one. */
  answer: Promise<T | null>;
  /** Take this side down because the other one won. Must be safe to call when
   *  this side never started, and must not itself answer anything. */
  withdraw: (winner: string) => void | Promise<void>;
}

/**
 * Settle a question from whichever side answers first.
 *
 * A side that resolves `null` has declined to decide — it failed to send, or it
 * was cancelled — and is not treated as a winner. When both come back null,
 * nobody answered, and the caller decides what that means. It must not mean
 * approval.
 */
export async function raceApproval<T>(
  terminal: RaceParticipant<T>,
  remote: RaceParticipant<T> | null,
  describe: (answer: T) => string,
): Promise<{ answer: T | null; from: 'terminal' | 'remote' | 'nobody' }> {
  // With no remote side there is nothing to race and nothing to withdraw.
  if (!remote) {
    return { answer: await terminal.answer, from: 'terminal' };
  }

  // Not Promise.race. Race settles on the first promise to *finish*, including
  // one that finished by declining — and the branch for the side that answers
  // later still runs, consuming the answer into a result nobody reads. Each
  // side instead gets one shot at a shared resolver, and only a real answer
  // takes it.
  return new Promise(resolve => {
    let settled = false;

    const claim = async (
      from: 'terminal' | 'remote',
      answer: T | null,
      loser: RaceParticipant<T>,
    ): Promise<void> => {
      // A null is a side stepping aside, not an answer. Let the other run on.
      if (answer === null || settled) return;
      settled = true;
      // Withdrawal is best-effort: the decision is already made, and a network
      // failure closing the other side must not undo it or throw in its place.
      try { await loser.withdraw(describe(answer)); } catch { /* already decided */ }
      resolve({ answer, from });
    };

    void terminal.answer.then(a => claim('terminal', a, remote));
    void remote.answer.then(a => claim('remote', a, terminal));

    // Both declined. Nobody answered — which the caller must not read as
    // approval, and which is why this returns a name for it rather than a null
    // that looks like every other null.
    void Promise.all([terminal.answer, remote.answer]).then(() => {
      if (settled) return;
      settled = true;
      resolve({ answer: null, from: 'nobody' });
    });
  });
}
