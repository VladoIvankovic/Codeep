import { describe, it, expect } from 'vitest';
import { parseLaunchArgs } from './cliArgs';

const chat = (yolo: boolean, prompt: string | null) => ({ kind: 'chat', yolo, prompt, promptFile: null });
const fromFile = (yolo: boolean, promptFile: string) => ({ kind: 'chat', yolo, prompt: null, promptFile });

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

  it('hands usage everything after its name, and lets it answer its own --help', () => {
    expect(parseLaunchArgs(['usage'])).toEqual({ kind: 'usage', args: [] });
    expect(parseLaunchArgs(['usage', '--json', '--days', '30'])).toEqual({ kind: 'usage', args: ['--json', '--days', '30'] });
    expect(parseLaunchArgs(['usage', '--help'])).toEqual({ kind: 'usage', args: ['--help'] });
    expect(parseLaunchArgs(['usage', '-v'])).toEqual({ kind: 'usage', args: ['-v'] });
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
    expect(parseLaunchArgs(['--yolo', 'usage'])).toEqual(chat(true, null));
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
    expect(parseLaunchArgs(['--', 'usage'])).toEqual(chat(false, 'usage'));
    expect(parseLaunchArgs(['--yolo', '--', 'usage', '--json'])).toEqual(chat(true, 'usage --json'));
    expect(parseLaunchArgs(['-p', 'usage'])).toEqual(chat(false, 'usage'));
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
    const twice = { kind: 'error', message: 'Give the prompt once: either -p <prompt>, -- <prompt> or --prompt-file <path>' };
    expect(parseLaunchArgs(['-p', 'fix it', '--', 'and test it'])).toEqual(twice);
    expect(parseLaunchArgs(['-p', 'one', '--prompt', 'two'])).toEqual(twice);
    // An empty one says nothing, so it conflicts with nothing.
    expect(parseLaunchArgs(['-p', '', '--', 'fix it'])).toEqual(chat(false, 'fix it'));
    expect(parseLaunchArgs(['-p', 'fix it', '--'])).toEqual(chat(false, 'fix it'));
  });
});

describe('parseLaunchArgs — --prompt-file', () => {
  it('takes the path after --prompt-file, or after --prompt-file=', () => {
    expect(parseLaunchArgs(['--prompt-file', '/run/user/1000/codeep-prompt-AbC123xyz0']))
      .toEqual(fromFile(false, '/run/user/1000/codeep-prompt-AbC123xyz0'));
    expect(parseLaunchArgs(['--prompt-file=/run/user/1000/codeep-prompt-AbC123xyz0']))
      .toEqual(fromFile(false, '/run/user/1000/codeep-prompt-AbC123xyz0'));
    // Only the first `=` separates; the rest is the path.
    expect(parseLaunchArgs(['--prompt-file=/tmp/a=b'])).toEqual(fromFile(false, '/tmp/a=b'));
  });

  it('is read before or after --yolo, as the other prompts are', () => {
    expect(parseLaunchArgs(['--yolo', '--prompt-file', '/p'])).toEqual(fromFile(true, '/p'));
    expect(parseLaunchArgs(['--prompt-file', '/p', '--yolo'])).toEqual(fromFile(true, '/p'));
    expect(parseLaunchArgs(['--yolo', '--prompt-file=/p'])).toEqual(fromFile(true, '/p'));
    expect(parseLaunchArgs(['--prompt-file=/p', '--yolo'])).toEqual(fromFile(true, '/p'));
    // Spelled exactly: a near miss is an unknown flag, which is ignored.
    expect(parseLaunchArgs(['--prompt-files', '/p'])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['--promptfile', '/p'])).toEqual(chat(false, null));
    expect(parseLaunchArgs(['--prompt-file-x=/p'])).toEqual(chat(false, null));
  });

  it('is not a prompt word, and not a flag, after --', () => {
    // Everything after `--` is the prompt, flags included.
    expect(parseLaunchArgs(['--', '--prompt-file', '/p'])).toEqual(chat(false, '--prompt-file /p'));
    expect(parseLaunchArgs(['--yolo', '--', '--prompt-file=/p'])).toEqual(chat(true, '--prompt-file=/p'));
  });

  it('takes the value whatever it looks like, so it is never a flag', () => {
    // The path `-v` is refused later (it is not absolute); it does not print the version.
    expect(parseLaunchArgs(['--prompt-file', '-v'])).toEqual(fromFile(false, '-v'));
    expect(parseLaunchArgs(['--prompt-file', '--help'])).toEqual(fromFile(false, '--help'));
    expect(parseLaunchArgs(['--prompt-file', '--yolo'])).toEqual(fromFile(false, '--yolo'));
    // And it is not trimmed: a path is not text.
    expect(parseLaunchArgs(['--prompt-file', ' /p '])).toEqual(fromFile(false, ' /p '));
  });

  it('keeps a prompt that starts with a dash a prompt, as before', () => {
    expect(parseLaunchArgs(['--', '-v', 'is', 'verbose?'])).toEqual(chat(false, '-v is verbose?'));
    expect(parseLaunchArgs(['-p', '-v explain'])).toEqual(chat(false, '-v explain'));
    // ...and a prompt that starts with -v beside a file is still two prompts.
    expect(parseLaunchArgs(['-p', '-v explain', '--prompt-file', '/p'])).toMatchObject({ kind: 'error' });
  });

  it('ignores unknown flags beside it, as it always has', () => {
    expect(parseLaunchArgs(['--yolo', '--prompt-file', '/p', '--made-up', 'word'])).toEqual(fromFile(true, '/p'));
  });

  it('refuses a path that is missing, `--`, or empty rather than start without the prompt', () => {
    const missing = { kind: 'error', message: '--prompt-file needs a value: codeep --prompt-file <path>' };
    expect(parseLaunchArgs(['--prompt-file'])).toEqual(missing);
    expect(parseLaunchArgs(['--yolo', '--prompt-file'])).toEqual(missing);
    expect(parseLaunchArgs(['--prompt-file', '--', 'fix it'])).toEqual(missing);
    expect(parseLaunchArgs(['--prompt-file', ''])).toEqual(missing);
    expect(parseLaunchArgs(['--prompt-file='])).toEqual(missing);
    expect(parseLaunchArgs(['--yolo', '--prompt-file='])).toEqual(missing);
  });

  it('keeps the other flags missing-value messages as they were', () => {
    expect(parseLaunchArgs(['-p'])).toEqual({ kind: 'error', message: '-p needs a value: codeep -p "<prompt>"' });
    expect(parseLaunchArgs(['--prompt'])).toEqual({ kind: 'error', message: '--prompt needs a value: codeep --prompt "<prompt>"' });
  });

  it('is one prompt: any two of -p, --prompt, --prompt=, -- and --prompt-file are refused', () => {
    const twice = { kind: 'error', message: 'Give the prompt once: either -p <prompt>, -- <prompt> or --prompt-file <path>' };
    const flagged: string[][] = [['-p', 'fix it'], ['--prompt', 'fix it'], ['--prompt=fix it'], ['--', 'fix', 'it']];
    for (const given of flagged) {
      expect(parseLaunchArgs(['--prompt-file', '/p', ...given])).toEqual(twice);
      // `--` ends the flags, so after it nothing is a flag: the file goes first there.
      if (given[0] !== '--') expect(parseLaunchArgs([...given, '--prompt-file', '/p'])).toEqual(twice);
      if (given[0] !== '--') expect(parseLaunchArgs([...given, '--prompt-file=/p'])).toEqual(twice);
      expect(parseLaunchArgs(['--prompt-file=/p', ...given])).toEqual(twice);
      expect(parseLaunchArgs(['--yolo', '--prompt-file', '/p', ...given])).toEqual(twice);
    }
    // Two files are two prompts as well.
    expect(parseLaunchArgs(['--prompt-file', '/a', '--prompt-file', '/b'])).toEqual(twice);
    expect(parseLaunchArgs(['--prompt-file', '/a', '--prompt-file=/b'])).toEqual(twice);
    expect(parseLaunchArgs(['--prompt-file=/a', '--prompt-file=/a'])).toEqual(twice);
  });

  it('lets an empty prompt beside a file say nothing, as it does beside another prompt', () => {
    expect(parseLaunchArgs(['-p', '', '--prompt-file', '/p'])).toEqual(fromFile(false, '/p'));
    expect(parseLaunchArgs(['--prompt=', '--prompt-file=/p'])).toEqual(fromFile(false, '/p'));
    expect(parseLaunchArgs(['--prompt-file', '/p', '--'])).toEqual(fromFile(false, '/p'));
    expect(parseLaunchArgs(['--prompt-file', '/p', '--', '  '])).toEqual(fromFile(false, '/p'));
  });

  it('refuses a malformed -p beside a file rather than guess', () => {
    expect(parseLaunchArgs(['--prompt-file', '/p', '-p'])).toMatchObject({ kind: 'error', message: expect.stringContaining('-p needs a value') });
  });

  it('still answers --help and --version, and leaves the subcommands alone', () => {
    expect(parseLaunchArgs(['--prompt-file', '/p', '--help'])).toEqual({ kind: 'help' });
    expect(parseLaunchArgs(['--prompt-file', '/p', '-v'])).toEqual({ kind: 'version' });
    expect(parseLaunchArgs(['--prompt-file'])).toMatchObject({ kind: 'error' });
    expect(parseLaunchArgs(['--help', '--prompt-file'])).toEqual({ kind: 'help' });
    expect(parseLaunchArgs(['review', '--prompt-file', '/p'])).toEqual({ kind: 'review', args: ['--prompt-file', '/p'] });
    expect(parseLaunchArgs(['usage', '--prompt-file', '/p'])).toEqual({ kind: 'usage', args: ['--prompt-file', '/p'] });
    expect(parseLaunchArgs(['acp', '--prompt-file'])).toEqual({ kind: 'acp' });
  });
});
