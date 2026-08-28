import { describe, it, expect, vi } from 'vitest';
import { raceApproval, type RaceParticipant } from './approvalRace';

/** A side that answers after `ms`, recording whether it was withdrawn. */
function side(value: string | null, ms: number) {
  const withdraw = vi.fn();
  const participant: RaceParticipant<string> = {
    answer: new Promise(resolve => setTimeout(() => resolve(value), ms)),
    withdraw,
  };
  return { participant, withdraw };
}

const describeAnswer = (a: string) => a;

describe('raceApproval', () => {
  it('takes the terminal answer and withdraws the phone', async () => {
    const terminal = side('run', 1);
    const remote = side('cancel', 50);

    const result = await raceApproval(terminal.participant, remote.participant, describeAnswer);

    expect(result).toEqual({ answer: 'run', from: 'terminal' });
    expect(remote.withdraw).toHaveBeenCalledWith('run');
    expect(terminal.withdraw).not.toHaveBeenCalled();
  });

  it('takes the phone answer and dismisses the terminal', async () => {
    const terminal = side('run', 50);
    const remote = side('cancel', 1);

    const result = await raceApproval(terminal.participant, remote.participant, describeAnswer);

    expect(result).toEqual({ answer: 'cancel', from: 'remote' });
    expect(terminal.withdraw).toHaveBeenCalledWith('cancel');
    expect(remote.withdraw).not.toHaveBeenCalled();
  });

  /**
   * The loser answering a moment later must change nothing. Without the settled
   * flag the second answer would run its own withdrawal against the side that
   * already won, and the run would be told two different things.
   */
  it('ignores the loser answering just afterwards', async () => {
    const terminal = side('run', 1);
    const remote = side('cancel', 5);

    const result = await raceApproval(terminal.participant, remote.participant, describeAnswer);
    await new Promise(r => setTimeout(r, 20));

    expect(result.answer).toBe('run');
    expect(remote.withdraw).toHaveBeenCalledTimes(1);
    expect(terminal.withdraw).not.toHaveBeenCalled();
  });

  /**
   * A null is a side stepping aside — Telegram could not send, or the send was
   * cancelled. The desk may legitimately be empty for another twenty minutes,
   * so the race must keep waiting rather than reporting "nobody answered".
   */
  it('keeps waiting when the first side declines to decide', async () => {
    const remote = side(null, 1);
    const terminal = side('run', 20);

    const result = await raceApproval(terminal.participant, remote.participant, describeAnswer);

    expect(result).toEqual({ answer: 'run', from: 'terminal' });
  });

  it('reports nobody when neither side answers', async () => {
    const terminal = side(null, 1);
    const remote = side(null, 2);

    const result = await raceApproval(terminal.participant, remote.participant, describeAnswer);

    expect(result).toEqual({ answer: null, from: 'nobody' });
    expect(terminal.withdraw).not.toHaveBeenCalled();
    expect(remote.withdraw).not.toHaveBeenCalled();
  });

  it('runs the terminal alone when Telegram is not configured', async () => {
    const terminal = side('run', 1);

    const result = await raceApproval(terminal.participant, null, describeAnswer);

    expect(result).toEqual({ answer: 'run', from: 'terminal' });
    expect(terminal.withdraw).not.toHaveBeenCalled();
  });

  /**
   * Withdrawal talks to Telegram, so it can fail. The decision is already made
   * by then — a failure to tidy up must not throw in place of the answer, and
   * must certainly not lose it.
   */
  it('keeps the answer when withdrawing the loser fails', async () => {
    const terminal = side('run', 1);
    const remote = side('cancel', 50);
    remote.withdraw.mockRejectedValue(new Error('telegram unreachable'));

    const result = await raceApproval(terminal.participant, remote.participant, describeAnswer);

    expect(result).toEqual({ answer: 'run', from: 'terminal' });
  });

  it('tells the loser what the winner decided', async () => {
    const terminal = side('skip', 1);
    const remote = side('run', 50);

    await raceApproval(terminal.participant, remote.participant, a => `answered ${a}`);

    expect(remote.withdraw).toHaveBeenCalledWith('answered skip');
  });
});
