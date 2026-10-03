import { describe, it, expect, vi, afterEach } from 'vitest';
import { Input, PASTE_END_WAIT_MS, ORPHANED_PASTE_WAIT_MS, type KeyEvent } from './Input';

/**
 * What one read from the terminal turns into. A terminal delivers whatever
 * arrived since the last read as one chunk: a single key, a paste, or —
 * from `tmux send-keys "text" Enter`, a fast typist, or a paste that ends in
 * a newline — text and keys together. Fed through process.stdin, the way the
 * running TUI receives them.
 */

let started: Input | null = null;

function startInput() {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
  const input = new Input();
  const events: KeyEvent[] = [];
  input.onKey(event => events.push(event));
  input.start();
  started = input;
  const send = (chunk: string) => { process.stdin.emit('data', chunk); };
  const keys = () => events.map(e => (e.isPaste ? `paste:${e.key}` : (e.ctrl ? 'ctrl+' : '') + (e.alt ? 'alt+' : '') + e.key));
  return { events, send, keys };
}

afterEach(() => {
  started?.stop();
  started = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('text and Enter in one chunk', () => {
  it('is the text, then Enter — never a carriage return inside the text', () => {
    const { send, keys } = startInput();
    send('/skills bundles\r');
    expect(keys()).toEqual(['paste:/skills bundles', 'enter']);
  });

  it('treats a one-character line the same way', () => {
    const { send, keys } = startInput();
    send('y\r');
    expect(keys()).toEqual(['y', 'enter']);
  });

  it('accepts \\n and \\r\\n as the Enter', () => {
    const { send, keys } = startInput();
    send('hello\n');
    send('hello\r\n');
    expect(keys()).toEqual(['paste:hello', 'enter', 'paste:hello', 'enter']);
  });

  it('keeps a multi-line paste as text with its line breaks, and does not send it', () => {
    const { send, keys } = startInput();
    send('first line\rsecond line\r');
    send('a\r\nb\nc');
    expect(keys()).toEqual(['paste:first line\nsecond line', 'paste:a\nb\nc']);
  });

  it('counts each Enter in a burst of them', () => {
    const { send, keys } = startInput();
    send('\r\r');
    send('\r\n');
    expect(keys()).toEqual(['enter', 'enter', 'enter']);
  });
});

describe('bracketed paste', () => {
  it('is one paste, with \\r line breaks as \\n', () => {
    const { send, keys } = startInput();
    send('\x1b[200~line one\rline two\x1b[201~');
    expect(keys()).toEqual(['paste:line one\nline two']);
  });

  it('inserts a pasted line that ends in a newline without sending it', () => {
    const { send, keys } = startInput();
    send('\x1b[200~npm test\r\x1b[201~');
    expect(keys()).toEqual(['paste:npm test']);
  });

  it('separates a paste from the Enter typed right after it', () => {
    const { send, keys } = startInput();
    send('\x1b[200~fix the build\x1b[201~\r');
    expect(keys()).toEqual(['paste:fix the build', 'enter']);
  });

  it('collects a paste the terminal delivers in several chunks', () => {
    const { send, keys } = startInput();
    send('\x1b[200~' + 'a'.repeat(10));
    send('b'.repeat(10));
    expect(keys()).toEqual([]);
    send('c'.repeat(10) + '\x1b[201~');
    expect(keys()).toEqual(['paste:' + 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(10)]);
  });

  it('finds an end marker split between two reads', () => {
    const { send, keys } = startInput();
    send('\x1b[200~split\x1b[20');
    send('1~\r');
    expect(keys()).toEqual(['paste:split', 'enter']);
  });

  // Changed on purpose in 3.9.1: once the first part is handed over, input
  // is still the paste until the terminal has been quiet for
  // ORPHANED_PASTE_WAIT_MS. Keys right after the first hand-over used to be
  // keys again, so a paste that paused part-way sent part of itself.
  it('gives up waiting for an end marker that never comes, and keeps what arrived', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~half a paste');
    expect(keys()).toEqual([]);
    vi.advanceTimersByTime(PASTE_END_WAIT_MS);
    expect(keys()).toEqual(['paste:half a paste']);
    vi.advanceTimersByTime(ORPHANED_PASTE_WAIT_MS);
    send('x');
    send('\r');
    expect(keys()).toEqual(['paste:half a paste', 'x', 'enter']);
  });
});

// A paste that pauses longer than PASTE_END_WAIT_MS part-way — a large paste
// over a slow ssh or mosh link, or a read delayed by a blocked event loop —
// has its first part handed over before the rest arrives. The rest is still
// the paste: its line breaks are text, never an Enter.
describe('a paste whose end marker is late', () => {
  it('keeps the rest a paste, line breaks and all, with the line break between the parts', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~line1\rline2\r');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    expect(keys()).toEqual(['paste:line1\nline2']);
    send('line3\rline4\r\x1b[201~');
    expect(keys()).toEqual(['paste:line1\nline2', 'paste:\nline3\nline4']);
  });

  it('collects a rest that comes in several reads, each with its own line break', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~line1\rline2\r');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('line3\r');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('line4\r');
    send('line5\x1b[201~');
    expect(keys()).toEqual(['paste:line1\nline2', 'paste:\nline3\nline4\nline5']);
    expect(keys()).not.toContain('enter');
  });

  it('drops the trailing line break when nothing follows it but the end marker', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~npm test\r');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('\x1b[201~');
    send('\r');
    expect(keys()).toEqual(['paste:npm test', 'enter']);
  });

  it('takes keys as keys again after the end marker', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~first');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send(' part\x1b[201~x\r');
    expect(keys()).toEqual(['paste:first', 'paste: part', 'x', 'enter']);
  });

  it('takes keys as keys again once the terminal has been quiet for the wait', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~first');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('\rmore');
    // Still waiting for the rest of the paste a moment before the wait ends.
    vi.advanceTimersByTime(ORPHANED_PASTE_WAIT_MS - 100);
    expect(keys()).toEqual(['paste:first']);
    vi.advanceTimersByTime(100);
    expect(keys()).toEqual(['paste:first', 'paste:\nmore']);
    send('\r');
    expect(keys()).toEqual(['paste:first', 'paste:\nmore', 'enter']);
  });

  it('keeps the wait going while more of the paste arrives', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~a');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(ORPHANED_PASTE_WAIT_MS - 1000);
      send('\rb');
    }
    expect(keys()).toEqual(['paste:a']);
    send('\x1b[201~');
    expect(keys()).toEqual(['paste:a', 'paste:\nb\nb\nb\nb']);
  });
});

// Ctrl+C and Ctrl+D pressed while an orphaned paste is being collected were
// taken as more of the paste, and each press restarted the wait, so pressing
// them every few seconds never got out (and left \x03 in the input).
describe('Ctrl+C or Ctrl+D during a paste', () => {
  for (const [name, byte] of [['ctrl+c', '\x03'], ['ctrl+d', '\x04']] as const) {
    it(`ends an orphaned paste and is ${name}`, () => {
      vi.useFakeTimers();
      const { send, keys } = startInput();
      send('\x1b[200~first\r');
      vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
      send('more');
      send(byte);
      expect(keys()).toEqual(['paste:first', 'paste:\nmore', name]);
      // Keys are keys again at once, without the quiet wait.
      send('x\r');
      expect(keys()).toEqual(['paste:first', 'paste:\nmore', name, 'x', 'enter']);
    });
  }

  it('is the key even when nothing more of the paste came', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~first');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('\x03');
    expect(keys()).toEqual(['paste:first', 'ctrl+c']);
  });

  it('stays text inside a paste whose end marker is still coming', () => {
    vi.useFakeTimers();
    const { send, keys, events } = startInput();
    send('\x1b[200~a');
    send('\x03');
    send('b\x1b[201~');
    expect(keys()).toEqual(['paste:a\x03b']);
    expect(events.some(e => e.ctrl)).toBe(false);
  });

  it('ends an orphaned paste when two presses arrive in one read', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~first');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('\x03\x03');
    expect(keys()).toEqual(['paste:first', 'ctrl+c', 'ctrl+c']);
  });

  it('stays text when it comes with more of an orphaned paste in one read', () => {
    vi.useFakeTimers();
    const { send, keys } = startInput();
    send('\x1b[200~first');
    vi.advanceTimersByTime(PASTE_END_WAIT_MS + 100);
    send('x\x03y\x1b[201~');
    expect(keys()).toEqual(['paste:first', 'paste:x\x03y']);
  });
});

// Terminals that send Alt/Option + arrow as ESC + CSI (iTerm2 with Option as
// Esc+, urxvt, older tmux): split into a bare Escape and an arrow, the word
// jump stopped the agent, cancelled a stream, or denied an open
// "Allow this action?" for the rest of the run.
describe('Alt/Option + arrow sent as ESC + CSI', () => {
  it.each([
    ['ESC + CSI left', '\x1b\x1b[D'],
    ['ESC + CSI right with modifiers', '\x1b\x1b[1;3C'],
    ['ESC + SS3 left', '\x1b\x1bOD'],
  ])('%s is one key, never Escape', (_label, bytes) => {
    const { send, events, keys } = startInput();
    send(bytes);
    expect(events).toHaveLength(1);
    expect(keys()).not.toContain('escape');
  });

  it('leaves a real Escape followed by an arrow alone', () => {
    const { send, keys } = startInput();
    send('\x1b');
    send('\x1b[D');
    expect(keys()).toEqual(['escape', 'left']);
  });
});

describe('single keys, as before', () => {
  it.each([
    ['\r', 'enter'],
    ['\n', 'enter'],
    ['\r\n', 'enter'],
    ['\x1b', 'escape'],
    ['\x7f', 'backspace'],
    ['\t', 'tab'],
    ['\x1b[A', 'up'],
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
    ['\x1b[3~', 'delete'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[6~', 'pagedown'],
    ['\x1b[1;5C', 'ctrl+ctrl-right'],
    ['\x1b[1;5D', 'ctrl+ctrl-left'],
    ['\x1bb', 'alt+b'],
    ['\x03', 'ctrl+c'],
    ['\x16', 'ctrl+v'],
    ['\x0f', 'ctrl+o'],
    ['\x1b[<64;10;5M', 'scrollup'],
    ['\x1b[<65;10;5M', 'scrolldown'],
    ['\x1b[<0;10;5M', 'mouse'],
    ['x', 'x'],
    ['中', '中'],
    ['😀', 'paste:😀'],
  ])('%j → %s', (chunk, expected) => {
    const { send, keys } = startInput();
    send(chunk);
    expect(keys()).toEqual([expected]);
  });

  it('keeps several keys that arrive together apart', () => {
    const { send, keys } = startInput();
    send('\x1b[B\x1b[B\r');
    send('abc\x1b[D');
    send('\x1b[<64;1;1M\x1b[<64;1;1M');
    expect(keys()).toEqual(['down', 'down', 'enter', 'paste:abc', 'left', 'scrollup', 'scrollup']);
  });

  it('takes a legacy mouse report as one mouse event, not as typed text', () => {
    const { send, keys } = startInput();
    send('\x1b[M !!');
    expect(keys()).toEqual(['mouse']);
  });

  it('types an emoji followed by Enter', () => {
    const { send, keys } = startInput();
    send('😀\r');
    expect(keys()).toEqual(['paste:😀', 'enter']);
  });
});
