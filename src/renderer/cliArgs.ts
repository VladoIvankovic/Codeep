/**
 * What `codeep` was started to do, read off its command line.
 *
 * Pure, and separate from main() so every form is pinned by a test — above
 * all the ones a launcher produces. A launcher that starts Codeep unattended
 * (Omarchy's `omarchy agent`, a script, a keybinding) writes
 * `codeep --yolo -- "$prompt"` and has no say over what the prompt contains:
 * a prompt that is the single word `review`, or that starts with `-v`, must
 * reach the model as a prompt and not run a subcommand or print the version.
 *
 * Grammar:
 *
 *   codeep review [args…]       args[0] only — the rest is review's own
 *   codeep hook [args…]         args[0] only
 *   codeep … --version | -v     anywhere before `--`
 *   codeep … --help | -h        anywhere before `--`
 *   codeep account [sub]        args[0] only
 *   codeep acp                  args[0] only
 *   codeep [--yolo] [-p <text> | --prompt <text> | --prompt=<text>] [-- <words…>]
 *
 * Everything after `--` is the prompt, joined with spaces. Unknown flags and
 * stray words are ignored, as they always were — so a launcher that passes a
 * flag a newer Codeep knows about still starts an older one.
 */

export type LaunchArgs =
  | { kind: 'review'; args: string[] }
  | { kind: 'hook'; args: string[] }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'account'; args: string[] }
  | { kind: 'acp' }
  /** A command line that cannot mean what it was written to mean. */
  | { kind: 'error'; message: string }
  | {
      kind: 'chat';
      /** Run without stopping to ask, for this process only. */
      yolo: boolean;
      /** Sent as the first message of a new session; null for none. */
      prompt: string | null;
    };

/** Parse `process.argv.slice(2)`. Pure. */
export function parseLaunchArgs(args: string[]): LaunchArgs {
  // Checked before --help/--version, so `codeep review --help` shows the
  // review usage rather than the top-level help.
  if (args[0] === 'review') return { kind: 'review', args: args.slice(1) };
  if (args[0] === 'hook') return { kind: 'hook', args: args.slice(1) };

  let version = false;
  let help = false;
  let yolo = false;
  let missingValue: string | null = null;
  const prompts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      // Joined even when empty: `codeep --` alone is a launcher with no
      // prompt to pass, and is filtered out with the other empty prompts.
      prompts.push(args.slice(i + 1).join(' '));
      break;
    }
    if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--yolo') {
      yolo = true;
    } else if (arg === '--prompt' || arg === '-p') {
      const value = args[i + 1];
      // The value is taken whatever it looks like, so `-p "-v explain"` is a
      // prompt. Only a missing one is an error — and `--`, which is the
      // separator here and never a prompt anyone meant.
      if (value === undefined || value === '--') {
        missingValue = arg;
      } else {
        prompts.push(value);
        i++;
      }
    } else if (arg.startsWith('--prompt=')) {
      prompts.push(arg.slice('--prompt='.length));
    }
  }

  if (version) return { kind: 'version' };
  if (help) return { kind: 'help' };
  if (args[0] === 'account') return { kind: 'account', args: args.slice(1) };
  if (args[0] === 'acp') return { kind: 'acp' };

  // An error rather than starting without the prompt: the window would open
  // looking like it was asked nothing, and whoever wrote the launcher would
  // have no way to tell why.
  if (missingValue) {
    return { kind: 'error', message: `${missingValue} needs a value: codeep ${missingValue} "<prompt>"` };
  }
  // An empty prompt is no prompt, as an empty input box sends nothing.
  const given = prompts.map(p => p.trim()).filter(p => p.length > 0);
  if (given.length > 1) {
    // Which one was meant, or whether they were meant joined, is a guess —
    // and a wrong guess sends half an instruction to an agent that does not
    // stop to ask.
    return { kind: 'error', message: 'Give the prompt once: either -p <prompt> or -- <prompt>' };
  }
  return { kind: 'chat', yolo, prompt: given[0] ?? null };
}
