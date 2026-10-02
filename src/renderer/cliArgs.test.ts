import { describe, it, expect } from 'vitest';
import { parseLaunchArgs } from './cliArgs';

const chat = (yolo: boolean, prompt: string | null) => ({ kind: 'chat', yolo, prompt });

describe('parseLaunchArgs — the subcommands that were there before', () => {
  it('starts the chat with nothing on the command line', () => {
    expect(parseLaunchArgs([])).toEqual(chat(false, null));
  });

  it('hands review and hook everything after their name', () => {
    expect(parseLaunchArgs(['review', '--json', 'src/a.ts'])).toEqual({ kind: 'review', args: ['--json', 'src/a.ts'] });
    expect(parseLaunchArgs(['hook', 'install', '--pre-push'])).toEqual({ kind: 'hook', args: ['install', '--pre-push'] });
  });

  it('lets review and hook answer their own --help and --version', () => {
    // `codeep review --help` shows the review usage, not the top-level help.
    expect(parseLaunchArgs(['review', '--help'])).toEqual({ kind: 'review', args: ['--help'] });
    expect(parseLaunchArgs(['hook', '-h'])).toEqual({ kind: 'hook', args: ['-h'] });
    expect(parseLaunchArgs(['review', '-v'])).toEqual({ kind: 'review', args: ['-v'] });
  });

  it('finds --version and --help anywhere before --, in both spellings', () => {
    expect(parseLaunchArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseLaunchArgs(['-v'])).toEqual({ kind: 'version' });
    expect(parseLaunchArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseLaunchArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseLaunchArgs(['--yolo', '-h'])).toEqual({ kind: 'help' });
    // As before, --version wins over --help, and both over account and acp.
    expect(parseLaunchArgs(['-h', '-v'])).toEqual({ kind: 'version' });
    expect(parseLaunchArgs(['account', '--help'])).toEqual({ kind: 'help' });
    expect(parseLaunchArgs(['acp', '-v'])).toEqual({ kind: 'version' });
  });

  it('hands account its subcommand', () => {
    expect(parseLaunchArgs(['account'])).toEqual({ kind: 'account', args: [] });
    expect(parseLaunchArgs(['account', 'sync'])).toEqual({ kind: 'account', args: ['sync'] });
    expect(parseLaunchArgs(['account', 'purge-keys'])).toEqual({ kind: 'account', args: ['purge-keys'] });
  });

  it('leaves acp alone whatever follows it', () => {
    // The editors start it; a flag they add later must not stop it starting.
    expect(parseLaunchArgs(['acp'])).toEqual({ kind: 'acp' });
    expect(parseLaunchArgs(['acp', '--yolo', '-p'])).toEqual({ kind: 'acp' });
  });

  it('only takes a subcommand from the first word', () => {
    expect(parseLaunchArgs(['--yolo', 'review'])).toEqual(chat(true, null));
    expect(parseLaunchArgs(['--yolo', 'account', 'sync'])).toEqual(chat(true, null));
  });

  it('ignores unknown flags and stray words, as it always has', () => {
    expect(parseLaunchArgs(['--made-up'])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['fix', 'the', 'bug'])).toEqual(chat(false, null));
  });
});

describe('parseLaunchArgs — --yolo', () => {
  it('is off unless asked for — a prompt alone still asks', () => {
    expect(parseLaunchArgs(['-p', 'fix it'])).toEqual(chat(false, 'fix it'));
    // Spelled exactly: a near miss falls back to asking, never the other way.
    expect(parseLaunchArgs(['--YOLO'])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['-y'])).toEqual(chat(false, null));
  });

  it('is read before or after the prompt', () => {
    expect(parseLaunchArgs(['--yolo'])).toEqual(chat(true, null));
    expect(parseLaunchArgs(['--yolo', '-p', 'fix it'])).toEqual(chat(true, 'fix it'));
    expect(parseLaunchArgs(['-p', 'fix it', '--yolo'])).toEqual(chat(true, 'fix it'));
    expect(parseLaunchArgs(['--yolo', '--', 'fix', 'it'])).toEqual(chat(true, 'fix it'));
  });

  it('is a prompt word, not a flag, after --', () => {
    // Fails safe: the run asks before acting, as a plain launch does.
    expect(parseLaunchArgs(['--', '--yolo'])).toEqual(chat(false, '--yolo'));
  });
});

describe('parseLaunchArgs — the launch prompt', () => {
  it('joins everything after -- with spaces', () => {
    expect(parseLaunchArgs(['--', 'add', 'a', 'dark', 'mode', 'toggle'])).toEqual(chat(false, 'add a dark mode toggle'));
    // A launcher quotes it into one argument; that is the same prompt.
    expect(parseLaunchArgs(['--', 'add a dark mode toggle'])).toEqual(chat(false, 'add a dark mode toggle'));
  });

  it('takes -p, --prompt and --prompt= alike', () => {
    expect(parseLaunchArgs(['-p', 'explain src/a.ts'])).toEqual(chat(false, 'explain src/a.ts'));
    expect(parseLaunchArgs(['--prompt', 'explain src/a.ts'])).toEqual(chat(false, 'explain src/a.ts'));
    expect(parseLaunchArgs(['--prompt=explain src/a.ts'])).toEqual(chat(false, 'explain src/a.ts'));
  });

  it('keeps a subcommand name in the prompt a prompt', () => {
    // Omarchy passes whatever the user typed; a one-word prompt naming a
    // subcommand is how another agent's `-- "$prompt"` ended up running it.
    expect(parseLaunchArgs(['--', 'review'])).toEqual(chat(false, 'review'));
    expect(parseLaunchArgs(['--yolo', '--', 'review'])).toEqual(chat(true, 'review'));
    expect(parseLaunchArgs(['--', 'hook', 'install'])).toEqual(chat(false, 'hook install'));
    expect(parseLaunchArgs(['--', 'account', 'purge-keys'])).toEqual(chat(false, 'account purge-keys'));
    expect(parseLaunchArgs(['--', 'acp'])).toEqual(chat(false, 'acp'));
    expect(parseLaunchArgs(['-p', 'review'])).toEqual(chat(false, 'review'));
  });

  it('keeps a prompt that starts with a dash a prompt', () => {
    expect(parseLaunchArgs(['--', '-v', 'is', 'verbose?'])).toEqual(chat(false, '-v is verbose?'));
    expect(parseLaunchArgs(['--', '--help'])).toEqual(chat(false, '--help'));
    expect(parseLaunchArgs(['-p', '-v explain'])).toEqual(chat(false, '-v explain'));
    // The value is taken before it is looked at as a flag.
    expect(parseLaunchArgs(['-p', '--help'])).toEqual(chat(false, '--help'));
  });

  it('treats an empty prompt as no prompt', () => {
    expect(parseLaunchArgs(['--'])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['--yolo', '--'])).toEqual(chat(true, null));
    expect(parseLaunchArgs(['--', ''])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['--', '  ', ''])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['-p', ''])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['--prompt='])).toEqual(chat(false, null));
  });

  it('trims the prompt, as the input box does', () => {
    expect(parseLaunchArgs(['-p', '  fix it \n'])).toEqual(chat(false, 'fix it'));
  });

  it('refuses -p with nothing after it rather than starting without the prompt', () => {
    expect(parseLaunchArgs(['-p'])).toEqual({ kind: 'error', message: '-p needs a value: codeep -p "<prompt>"' });
    expect(parseLaunchArgs(['--yolo', '--prompt'])).toEqual({ kind: 'error', message: '--prompt needs a value: codeep --prompt "<prompt>"' });
    // `--` is the separator, not a value anyone meant.
    expect(parseLaunchArgs(['-p', '--', 'fix it'])).toMatchObject({ kind: 'error' });
  });

  it('still answers --help and --version when the prompt is malformed', () => {
    expect(parseLaunchArgs(['--help', '-p'])).toEqual({ kind: 'help' });
    expect(parseLaunchArgs(['-v', '-p'])).toEqual({ kind: 'version' });
  });

  it('refuses two prompts rather than guess which was meant', () => {
    const twice = { kind: 'error', message: 'Give the prompt once: either -p <prompt> or -- <prompt>' };
    expect(parseLaunchArgs(['-p', 'fix it', '--', 'and test it'])).toEqual(twice);
    expect(parseLaunchArgs(['-p', 'one', '--prompt', 'two'])).toEqual(twice);
    // An empty one says nothing, so it conflicts with nothing.
    expect(parseLaunchArgs(['-p', '', '--', 'fix it'])).toEqual(chat(false, 'fix it'));
    expect(parseLaunchArgs(['-p', 'fix it', '--'])).toEqual(chat(false, 'fix it'));
  });
});
