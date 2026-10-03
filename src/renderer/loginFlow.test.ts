import { describe, it, expect, vi, afterEach } from 'vitest';
import { runLoginFlow } from './loginFlow';
import { Screen } from './Screen';
import { Input } from './Input';
import { resetPalette, setPalette } from './palette';

/**
 * The first-run setup screens and what redraws them. On the Omarchy box the
 * "Welcome to Codeep — Pick an AI provider" screen kept the old theme's
 * colours after a theme switch, and went blank after the terminal was
 * resized, until a key was pressed.
 */

const TEAL = '38;2;0;128;128';

function startFlow(save: (key: string) => Promise<void> = async () => {}) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
  const screen = new Screen();
  const input = new Input();
  vi.spyOn(input, 'start').mockImplementation(() => {});
  vi.spyOn(input, 'stop').mockImplementation(() => {});
  const setApiKey = vi.fn(save);
  const result = runLoginFlow({
    providers: [
      { id: 'alpha', name: 'Alpha', description: 'The first provider' },
      { id: 'beta', name: 'Beta', description: 'The second provider' },
    ],
    setProvider: vi.fn(),
    setApiKey,
    screen,
    input,
  });
  const frame = () => writes.join('');
  const fresh = () => { writes.length = 0; };
  return { result, input, frame, fresh, setApiKey };
}

afterEach(() => {
  resetPalette();
  vi.restoreAllMocks();
});

describe('Ctrl+C and Ctrl+D in setup', () => {
  // The terminal is in raw mode during setup, so without this Esc on the
  // provider list was the only way out, and nothing left the key screen.
  for (const [name, byte] of [['Ctrl+C', '\x03'], ['Ctrl+D', '\x04']] as const) {
    it(`${name} ends setup from the provider list`, async () => {
      const { result, input } = startFlow();
      input.feed(byte);
      await expect(result).resolves.toBeNull();
    });

    it(`${name} ends setup from the API-key screen`, async () => {
      const { result, input, frame } = startFlow();
      input.feed('\r');
      expect(frame()).toContain('API');
      input.feed(byte);
      await expect(result).resolves.toBeNull();
    });
  }
});

describe('the provider picker', () => {
  it('redraws itself after a resize, which clears the terminal', async () => {
    const { result, input, frame, fresh } = startFlow();
    expect(frame()).toContain('Welcome to Codeep');
    fresh();

    process.stdout.emit('resize');
    expect(frame()).toContain('\x1b[2J');
    expect(frame()).toContain('Welcome to Codeep');
    expect(frame()).toContain('Alpha');

    input.feed('\x1b');
    await expect(result).resolves.toBeNull();
  });

  it('repaints in the new colours when the palette changes', async () => {
    const { result, input, frame, fresh } = startFlow();
    expect(frame()).not.toContain(TEAL);
    fresh();

    setPalette({ primary: [0, 128, 128] });
    expect(frame()).toContain(TEAL);
    expect(frame()).toContain('Welcome to Codeep');

    input.feed('\x1b');
    await expect(result).resolves.toBeNull();
  });

  it('stops listening once setup is over', async () => {
    const { result, input, frame, fresh } = startFlow();
    input.feed('\x1b');
    await expect(result).resolves.toBeNull();
    fresh();

    setPalette({ primary: [0, 128, 128] });
    process.stdout.emit('resize');
    expect(frame()).not.toContain('Welcome to Codeep');
  });
});

describe('the API key screen', () => {
  it('redraws itself after a resize and on a palette change', async () => {
    const { result, input, frame, fresh, setApiKey } = startFlow();
    input.feed('\r');
    expect(frame()).toContain('Alpha API Key');
    fresh();

    process.stdout.emit('resize');
    expect(frame()).toContain('Alpha API Key');
    fresh();

    setPalette({ primary: [0, 128, 128] });
    expect(frame()).toContain(TEAL);
    expect(frame()).toContain('Alpha API Key');

    // A key pasted together with its Enter is saved at once.
    input.feed('test-key-1234567890\r');
    await expect(result).resolves.toBe('test-key-1234567890');
    expect(setApiKey).toHaveBeenCalledWith('test-key-1234567890');
  });
});

// After "API key too short" the screen was rebuilt with an Enter that did
// nothing and an Esc that ended setup, so the only way on was to quit and
// start Codeep again.
describe('after a key is refused', () => {
  /** Settles a promise check without waiting for it: 'pending' if it has not. */
  async function state(p: Promise<unknown>): Promise<string> {
    return Promise.race([p.then(v => `resolved:${String(v)}`), new Promise<string>(r => setTimeout(() => r('pending'), 20))]);
  }

  it('takes a valid key on Enter after "API key too short"', async () => {
    const { result, input, frame, setApiKey } = startFlow();
    input.feed('\r');
    input.feed('short\r');
    expect(frame()).toContain('API key too short');
    expect(setApiKey).not.toHaveBeenCalled();

    input.feed('test-key-1234567890\r');
    await expect(result).resolves.toBe('test-key-1234567890');
    expect(setApiKey).toHaveBeenCalledWith('test-key-1234567890');
  });

  it('can refuse a short key more than once and still take the next one', async () => {
    const { result, input, setApiKey } = startFlow();
    input.feed('\r');
    input.feed('short\r');
    input.feed('still-short\x7f\x7f\x7f\x7f\x7f\x7f\r');
    input.feed('test-key-1234567890\r');
    await expect(result).resolves.toBe('test-key-1234567890');
    expect(setApiKey).toHaveBeenCalledTimes(1);
  });

  it('goes back to the provider list on Esc, as on the first attempt, and setup goes on', async () => {
    const { result, input, frame, fresh } = startFlow();
    input.feed('\r');
    input.feed('short\r');
    fresh();

    input.feed('\x1b');
    expect(await state(result)).toBe('pending');
    expect(frame()).toContain('Welcome to Codeep');
    expect(frame()).not.toContain('API key too short');

    // Pick the second provider this time and finish setup.
    input.feed('\x1b[B');
    input.feed('\r');
    expect(frame()).toContain('Beta API Key');
    expect(frame()).not.toContain('API key too short');
    input.feed('beta-key-1234567890\r');
    await expect(result).resolves.toBe('beta-key-1234567890');
  });

  it('shows why a key could not be saved, and Enter tries again', async () => {
    let fail = true;
    const { result, input, frame } = startFlow(async () => {
      if (fail) { fail = false; throw new Error('no keyring'); }
    });
    input.feed('\r');
    input.feed('test-key-1234567890\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(frame()).toContain('Could not save the API key');
    expect(await state(result)).toBe('pending');

    input.feed('test-key-1234567890\r');
    await expect(result).resolves.toBe('test-key-1234567890');
  });
});
