/**
 * `codeep account sync` (and its alias `pull`), `codeep account push`, and
 * the offer to run the sync the moment `codeep account` has linked a machine.
 *
 * What this fixes is the new machine. API keys are opt-in — cloud key sync
 * (`syncKeysToCloud`) is off until it is turned on — and the only switch for
 * it was `/keysync on`, which is in the TUI. The TUI does not start without a
 * key for the current provider, so on a new machine the one way to the keys
 * on codeep.dev was to type a key in by hand first. Now the shell asks for the
 * same consent `/keysync on` stands for, in the same words
 * (commands/core/keysync.ts): `--keys` gives it up front, a terminal with no
 * key on it is asked, and anything else — a script, a pipe, CI, a machine
 * that has keys — is told how and pulls no keys.
 *
 * Push is here for what it uploads: the keys stored on this machine, never
 * one read from an environment variable (see runAccountPush).
 *
 * Kept out of main.ts so every branch can be tested without a terminal or a
 * network: the questions, the output, the requests and whether this is a
 * terminal at all can each be passed in, with the real ones as defaults.
 */
import { createInterface } from 'readline';
import {
  config,
  envApiKey,
  getApiKey,
  getSyncToken,
  isKeySyncEnabled,
  keychainInUse,
  keySyncForcedOffByEnv,
  loadAllApiKeys,
  loadApiKey,
  loadStoredApiKey,
  setApiKey,
  setProvider,
} from '../config/index.js';
import { PROVIDERS, getProviderList, isNoApiKeyProvider } from '../config/providers.js';
import { KEY_SYNC_DISCLOSURE, KEY_SYNC_ON } from '../commands/core/keysync.js';
import {
  describeSyncFailure,
  getLastPersonalityPullBackupCount,
  pullCommands,
  pullKeys,
  pullPersonalities,
  pullUserProfileResult,
  pushCommands,
  pushKeys,
  pushPersonalities,
  pushUserProfileResult,
  type SyncResult,
} from './codeepCloud.js';

/** The requests an account command makes to codeep.dev. */
export interface AccountRequests {
  pullKeys: () => Promise<Record<string, string> | null>;
  pullPersonalities: () => Promise<SyncResult>;
  pullCommands: () => Promise<SyncResult>;
  pullUserProfileResult: () => Promise<SyncResult>;
  /** How many local agents the last personality pull backed up. */
  getLastPersonalityPullBackupCount: () => number;
  pushKeys: (keys: Record<string, string>) => Promise<boolean>;
  pushPersonalities: () => Promise<SyncResult>;
  pushCommands: () => Promise<SyncResult>;
  pushUserProfileResult: () => Promise<SyncResult>;
}

/** Ctrl+C at a question. It stops the whole command — nothing is pulled —
 *  where Ctrl+D, or input that ended, is only a No. */
export const CANCELLED = Symbol('cancelled');

/** The line typed; null when the question closed without one; CANCELLED. */
export type Answer = string | null | typeof CANCELLED;

export interface AccountSyncOptions {
  /** `--keys`: turn cloud key sync on and pull the keys, without asking. */
  keys?: boolean;
  /** Prints a line. console.log by default. */
  log?: (line: string) => void;
  /** Prints without a line break, for "Pulling keys…" before how it went.
   *  process.stdout.write by default. */
  write?: (text: string) => void;
  /** Asks one question. askOnTerminal by default. */
  ask?: (question: string) => Promise<Answer>;
  /** Whether stdin and stdout are a terminal. process.stdin/stdout by default. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** codeepCloud's by default. */
  requests?: Partial<AccountRequests>;
}

const KEY_QUESTION = '  Turn on cloud key sync and pull your API keys now? [y/N] ';
const OFFER_QUESTION = '  Pull your agents, commands and profile from codeep.dev now? [Y/n] ';

/** The skip message, naming the shell's way to the keys: `/keysync on` is a
 *  TUI command, and on a new machine the TUI is what cannot start yet. */
const KEYS_SKIPPED = '  Cloud key sync is off — skipping API keys. Pull them with: codeep account sync --keys';

/** What a yes also turns on, said before it is given: the flag stays on, so
 *  push uploads this machine's keys from then on (see runAccountPush). */
const PUSH_UPLOADS_KEYS = '  With key sync on, `codeep account push` also uploads the API keys stored on this machine.';

/** A provider id as the catalogue spells them. What the server sends under
 *  any other name, or with no key in it, is not an API key to store. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A name every object answers to — `constructor`, `toString`, `__proto__` —
 *  is no provider's: looked up by name, it finds Object's own members (it was
 *  listed as "Object" once stored), and as a key it can reach the prototype. */
const isPrototypeName = (name: string) => name in Object.prototype;

/** How long a question first throws away what is already queued on stdin. */
const TYPE_AHEAD_MS = 50;

type SyncIO = ReturnType<typeof resolveIO>;

function resolveIO(options: AccountSyncOptions) {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  return {
    log: options.log ?? ((line: string) => console.log(line)),
    write: options.write ?? ((text: string) => { process.stdout.write(text); }),
    ask: options.ask ?? ((question: string) => askOnTerminal(question)),
    // Both ends, and not CI: a question nobody can see, or an answer nobody
    // can type, is not consent — and a CI job on a pty (docker -it, ssh -t)
    // would sit at it until the job timed out.
    interactive: stdinIsTTY && stdoutIsTTY && !runningInCI(),
    stdoutIsTTY,
    requests: {
      pullKeys,
      pullPersonalities,
      pullCommands,
      pullUserProfileResult,
      getLastPersonalityPullBackupCount,
      pushKeys,
      pushPersonalities,
      pushCommands,
      pushUserProfileResult,
      ...options.requests,
    } satisfies AccountRequests,
  };
}

/** CI set to anything but "", "0" or "false". */
function runningInCI(): boolean {
  const ci = process.env.CI?.trim();
  return !!ci && !/^(0|false)$/i.test(ci);
}

/** Thrown by confirm() on Ctrl+C; caught by cancellable(). */
class Cancelled extends Error {}

/** An account command that Ctrl+C at one of its questions ends at once,
 *  with nothing pulled and 130 — the shell's code for an interrupt. */
async function cancellable(io: SyncIO, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.log('  Cancelled.');
    return 130;
  }
}

/**
 * `codeep account sync`: the account's API keys, when cloud key sync is on
 * or is turned on now (see keysAllowed), then its agents, custom commands and
 * profile. Resolves with the exit code — 1 when the machine is not linked or
 * the keys could not be pulled, 130 for Ctrl+C at the question. A failed
 * agents, commands or profile pull is reported and does not fail the
 * command, as before.
 */
export async function runAccountSync(options: AccountSyncOptions = {}): Promise<number> {
  const io = resolveIO(options);
  return cancellable(io, () => sync(options.keys === true, io));
}

async function sync(keysFlag: boolean, io: SyncIO): Promise<number> {
  if (!getSyncToken()) {
    io.log('\n  Not linked to codeep.dev. Run: codeep account\n');
    return 1;
  }
  // Run the one-time plaintext->keychain migration BEFORE storing any pulled
  // key. Otherwise the first setApiKey flips keysSecured=true and any local
  // legacy plaintext keys would never migrate (orphaned, invisible).
  await loadAllApiKeys();

  if (await keysAllowed(keysFlag, io)) {
    if (!await pullAndStoreKeys(keysFlag, io)) return 1;
  }

  await pullPersonalConfig(io);
  io.log('');
  return 0;
}

/**
 * Whether this sync may pull API keys — asking, when cloud key sync is off.
 *
 * Keys stay opt-in: with key sync off nothing is pulled until it is turned
 * on, and only `--keys` or a y turns it on, after the disclosure `/keysync on`
 * gives and the line on what push uploads from then on. Turned on, it stays
 * on, as after `/keysync on`. Asked only where the answer matters: on a
 * machine with no API key at all, which is the one the TUI cannot start on.
 * A machine with keys — someone keeping key sync off on purpose — is told the
 * command instead of being asked at every sync. CODEEP_NO_KEY_SYNC is an org
 * policy and wins over all of it: no question, no flag, and `--keys` is told
 * why it did nothing.
 */
async function keysAllowed(keysFlag: boolean, io: SyncIO): Promise<boolean> {
  if (isKeySyncEnabled()) return true;
  if (keySyncForcedOffByEnv()) {
    io.log(keysFlag
      ? '  Cloud key sync is forced off by CODEEP_NO_KEY_SYNC — skipping API keys. --keys can\'t override an env var: unset CODEEP_NO_KEY_SYNC to pull them.'
      : '  Cloud key sync is forced off by CODEEP_NO_KEY_SYNC — skipping API keys.');
    return false;
  }
  if (!keysFlag && (!io.interactive || machineHasApiKey())) {
    io.log(KEYS_SKIPPED);
    return false;
  }
  io.log(`  ${KEY_SYNC_DISCLOSURE}`);
  io.log(PUSH_UPLOADS_KEYS);
  if (!keysFlag && !await confirm(io, KEY_QUESTION, false)) {
    io.log(KEYS_SKIPPED);
    return false;
  }
  // All `/keysync on` does once CODEEP_NO_KEY_SYNC is ruled out.
  config.set('syncKeysToCloud', true);
  io.log(`  ${KEY_SYNC_ON}`);
  return true;
}

/** Whether a provider that needs a key has one here, stored or from the
 *  environment — loadAllApiKeys() has put both in the cache by now. */
function machineHasApiKey(): boolean {
  return Object.entries(PROVIDERS).some(([id, provider]) => !provider.noApiKey && getApiKey(id) !== '');
}

/**
 * Pull the keys into the keychain. False when the pull failed, which fails
 * the command before anything else is pulled.
 *
 * Only what can be an API key is stored, counted or chosen: a string with
 * something in it, under a name a provider could have. The rest is skipped
 * and counted, and nothing the server sent is printed — a name is printed
 * only once it has passed PROVIDER_ID, which leaves no room for a terminal
 * escape. Where the keys went to plain text because there is no keychain, the
 * line says so and where.
 */
async function pullAndStoreKeys(keysFlag: boolean, io: SyncIO): Promise<boolean> {
  io.write('  Pulling keys from codeep.dev...');
  const keys: unknown = await io.requests.pullKeys();
  if (!keys) {
    io.log(' failed.\n  Check your connection or re-link with: codeep account\n');
    return false;
  }
  // An answer, but not a key list: the connection and the link are fine.
  if (typeof keys !== 'object' || Array.isArray(keys)) {
    io.log(` failed — ${describeSyncFailure('malformed')}.\n`);
    return false;
  }
  const entries = Object.entries(keys);
  if (entries.length === 0) {
    io.log(' no keys found.\n  Add keys at codeep.dev/dashboard');
    return true;
  }
  const usable = entries.filter((entry): entry is [string, string] =>
    PROVIDER_ID.test(entry[0]) && !isPrototypeName(entry[0])
    && typeof entry[1] === 'string' && entry[1].trim() !== '');
  const stored: string[] = [];
  for (const [provider, key] of usable) {
    try {
      await setApiKey(key, provider);
      stored.push(provider);
    } catch {
      io.log(`\n  Warning: could not securely store the key for ${provider}.`);
    }
  }
  const plainText = stored.length > 0 && !await keychainInUse();
  io.log(` synced ${stored.length} key${stored.length !== 1 ? 's' : ''}`
    + `${plainText ? ` — stored in plain text in ${config.path}: no system keychain is available` : ''}.`);
  const skipped = entries.length - usable.length;
  if (skipped > 0) {
    io.log(`  Skipped ${skipped} ${skipped === 1 ? 'entry that is not an API key' : 'entries that are not API keys'}.`);
  }
  await chooseProvider(stored, keysFlag, io);
  return true;
}

/**
 * Point the next `codeep` at a provider the pulled keys cover, when the one
 * it would start on has none.
 *
 * Nothing else picks one: a new machine starts on z.ai, and with keys for
 * other providers pulled, the TUI still opened on "pick a provider" as if
 * nothing had come down. Only then, though. A current provider with a key —
 * one from the environment counts — or one that needs none is a choice
 * already made, and is left alone. So is the provider of a sync nobody is
 * watching (no terminal, no --keys): the VS Code extension's sync runs with
 * the editor's environment, which can lack a key the user's shell sets.
 *
 * The first in the order /provider and the first-run screen list them, so
 * the same keys always give the same provider, and only a key that was
 * stored: one the keychain refused would start a provider with no key. A
 * key under an id this version does not know is stored, as it always was,
 * but there is no provider to start for it.
 */
async function chooseProvider(stored: string[], keysFlag: boolean, io: SyncIO): Promise<void> {
  if (!keysFlag && !io.stdoutIsTTY) return;
  const current = config.get('provider');
  if (isNoApiKeyProvider(current)) return;
  if (await loadApiKey(current).catch(() => '')) return;
  const next = getProviderList().find(provider => stored.includes(provider.id));
  if (!next) return;
  setProvider(next.id);
  io.log(`  Using ${next.name} — change it with /provider`);
}

/** Personalities, custom commands and the profile. Web-edited personalities
 *  replace their local copy after a safety backup; commands and the profile
 *  keep their additive merge rules (utils/codeepCloud.ts). */
async function pullPersonalConfig(io: SyncIO): Promise<void> {
  // Report all three outcomes, not just the interesting one. Printing only
  // on count > 0 made a failed sync look identical to a sync with nothing
  // new — silence meant either, and the user could not tell which.
  const personalities = await io.requests.pullPersonalities();
  if (!personalities.ok) {
    io.log(`  Could not pull agents — ${describeSyncFailure(personalities.reason)}.`);
  } else if (personalities.count > 0) {
    io.log(`  Pulled ${personalities.count} personalit${personalities.count === 1 ? 'y' : 'ies'}.`);
    const backups = io.requests.getLastPersonalityPullBackupCount();
    if (backups > 0) io.log(`  Backed up ${backups} replaced local cop${backups === 1 ? 'y' : 'ies'} in ~/.codeep/backups/personalities/.`);
  } else if (personalities.removed === 0) {
    io.log('  Agents already up to date.');
  }
  if (personalities.ok && personalities.removed > 0) {
    io.log(`  Removed ${personalities.removed} agent${personalities.removed === 1 ? '' : 's'} deleted on codeep.dev (backed up first).`);
  }
  const commands = await io.requests.pullCommands();
  if (!commands.ok) {
    io.log(`  Could not pull custom commands — ${describeSyncFailure(commands.reason)}.`);
  } else if (commands.count > 0) {
    io.log(`  Pulled ${commands.count} custom command${commands.count === 1 ? '' : 's'}.`);
  }
  const profile = await io.requests.pullUserProfileResult();
  if (!profile.ok) {
    io.log(`  Could not pull your profile (about you) — ${describeSyncFailure(profile.reason)}.`);
  } else if (profile.count > 0) {
    io.log('  Pulled your profile (about you).');
  }
}

/**
 * `codeep account push`: the API keys stored on this machine, when cloud key
 * sync is on, then the agents, custom commands and profile. Resolves with the
 * exit code — 1 when the machine is not linked, or when anything it reported
 * as failed did, so a script running it can tell.
 *
 * Stored keys only — the keychain, or the plain-text fallback. Push used to
 * send what the key cache held, and the cache holds a key from an environment
 * variable ahead of a stored one: a key the shell exports went to codeep.dev,
 * and where one was stored too, the exported one went instead. A provider
 * whose only key is in the environment is now left out and named, by name
 * and never by value.
 *
 * Each stored key is read once. Push no longer fills the cache first
 * (loadAllApiKeys): that read every stored key a second time, and on macOS a
 * keychain item whose access list lacks this binary asks for each read. The
 * environment comes from process.env (envApiKey), which reads nothing.
 */
export async function runAccountPush(options: Omit<AccountSyncOptions, 'keys' | 'ask'> = {}): Promise<number> {
  const io = resolveIO(options);
  if (!getSyncToken()) {
    io.log('\n  Not linked to codeep.dev. Run: codeep account\n');
    return 1;
  }

  // API keys are opt-in (default OFF). Push them only when cloud key sync is
  // enabled; the personal config below always pushes (no secrets).
  let keyPushFailed = false;
  if (isKeySyncEnabled()) {
    const keys: Record<string, string> = {};
    const fromEnvironment: string[] = [];
    for (const [providerId, provider] of Object.entries(PROVIDERS)) {
      const key = await loadStoredApiKey(providerId);
      if (key) keys[providerId] = key;
      else if (envApiKey(providerId)) fromEnvironment.push(provider.name);
    }
    const count = Object.keys(keys).length;
    if (count === 0) {
      io.log('  No local API keys to push.');
    } else {
      io.write(`  Pushing ${count} key${count !== 1 ? 's' : ''} to codeep.dev...`);
      const ok = await io.requests.pushKeys(keys);
      io.log(ok ? ' done.' : ' failed.');
      keyPushFailed = !ok;
    }
    if (fromEnvironment.length > 0) {
      const n = fromEnvironment.length;
      io.log(`  Skipped ${n} key${n === 1 ? '' : 's'} read from ${n === 1 ? 'an environment variable' : 'environment variables'} (not uploaded): ${fromEnvironment.join(', ')}`);
    }
  } else {
    io.log('  Cloud key sync is off — skipping API keys. Enable with: /keysync on');
  }

  // Also push portable personal config — personalities + commands + profile.
  const personalities = await io.requests.pushPersonalities();
  if (!personalities.ok) {
    io.log(`  Could not push agents — ${describeSyncFailure(personalities.reason)}.`);
  } else if (personalities.count > 0) {
    io.log(`  Pushed ${personalities.count} personalit${personalities.count === 1 ? 'y' : 'ies'}.`);
  }
  const commands = await io.requests.pushCommands();
  if (!commands.ok) {
    io.log(`  Could not push custom commands — ${describeSyncFailure(commands.reason)}.`);
  } else if (commands.count > 0) {
    io.log(`  Pushed ${commands.count} custom command${commands.count === 1 ? '' : 's'}.`);
  }
  // No local profile is nothing to push, not a failure.
  const profile = await io.requests.pushUserProfileResult();
  const profilePushFailed = !profile.ok;
  if (!profile.ok) {
    io.log(`  Could not push your profile (about you) — ${describeSyncFailure(profile.reason)}.`);
  } else if (profile.count > 0) {
    io.log('  Pushed your profile (about you).');
  }
  io.log('');
  const anyFailed = keyPushFailed || !personalities.ok || !commands.ok || profilePushFailed;
  return anyFailed ? 1 : 0;
}

/**
 * Right after `codeep account` has linked this machine: on a terminal, ask,
 * and on yes run the sync — which asks about keys itself while key sync is
 * off. Asked rather than done, because a sync replaces local copies of agents
 * edited on the web (after a backup), and linking alone should not. Anywhere
 * else, and after a no, print the commands to run. Resolves with the exit
 * code for `codeep account`.
 */
export async function offerSyncAfterLink(options: Omit<AccountSyncOptions, 'keys'> = {}): Promise<number> {
  const io = resolveIO(options);
  return cancellable(io, async () => {
    if (io.interactive && await confirm(io, OFFER_QUESTION, true)) return sync(false, io);
    io.log('  Next: codeep account sync');
    // Only where --keys would do something: with key sync on, the plain sync
    // pulls keys anyway, and CODEEP_NO_KEY_SYNC refuses it.
    if (!isKeySyncEnabled() && !keySyncForcedOffByEnv()) {
      io.log('  To pull your API keys too: codeep account sync --keys');
    }
    io.log('');
    return 0;
  });
}

/**
 * The line the first-run provider screen adds on a linked machine. The keys
 * may already be on codeep.dev, and pulling them is a shell command, so it
 * names the command — first, so that it is whole at 50 columns; the screen's
 * footer says how to leave setup. Nothing when the machine is not linked, or
 * when CODEEP_NO_KEY_SYNC would refuse the command.
 */
export function syncKeysLoginHint(): string | undefined {
  if (!getSyncToken() || keySyncForcedOffByEnv()) return undefined;
  return 'Keys on codeep.dev: codeep account sync --keys';
}

/**
 * A yes/no question. Enter alone takes the default; an answer that never
 * came is no, whatever the default — walking away from "[Y/n]" is not a
 * yes — and Ctrl+C stops the command (see cancellable).
 */
async function confirm(io: SyncIO, question: string, defaultYes: boolean): Promise<boolean> {
  const answer = await io.ask(question);
  if (answer === CANCELLED) throw new Cancelled();
  if (answer === null) return false;
  const word = answer.trim().toLowerCase();
  if (word === '') return defaultYes;
  return word === 'y' || word === 'yes';
}

type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  readableEnded?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Ask on the terminal. Resolves with the line typed after the question was
 * shown; null when the question closed without one — Ctrl+D, or the input
 * ended — and CANCELLED for Ctrl+C. Only with a SIGINT listener does readline
 * report Ctrl+C at all: without one it closes the question exactly as Ctrl+D
 * does (seen on Node 24).
 *
 * Nothing typed before the question counts (discardTypeAhead), the second of
 * two questions included: consent counts only once its disclosure was shown.
 * A Ctrl+C typed while that runs is the exception — it cancels. And while it
 * all runs, a signal that ends the process puts the terminal back first
 * (restoreTerminalOnSignal).
 */
export async function askOnTerminal(
  question: string,
  input: TerminalInput = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<Answer> {
  const release = restoreTerminalOnSignal(input);
  try {
    const drained = await discardTypeAhead(input);
    if (drained === 'ended') return null;
    if (drained === 'cancelled') return CANCELLED;
    return await new Promise<Answer>((resolve) => {
      const rl = createInterface({ input, output });
      let answered = false;
      let cancelled = false;
      rl.on('SIGINT', () => {
        cancelled = true;
        rl.close();
      });
      rl.on('close', () => {
        if (answered) return;
        // The cursor is still on the question's line.
        output.write('\n');
        resolve(cancelled ? CANCELLED : null);
      });
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    });
  } finally {
    release();
  }
}

/** How a signal ends a process, as a shell reports it: 128 plus its number. */
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Put the terminal back if a signal ends the process while a question is up,
 * and stop listening once it is not.
 *
 * A question puts the terminal in raw mode, and only the question's own end
 * puts it back. A SIGTERM or SIGHUP — the window closed, a `kill` — ended the
 * process with neither having run: conf's exit hook (when-exit) catches both,
 * runs its cleanup and raises the signal again, and the shell was left
 * without echo or line editing (-icanon -isig -echo). A SIGINT sent from
 * outside did the same; Ctrl+C at the question is a key, not a signal. So,
 * for as long as a question runs, each of them restores cooked mode and ends
 * the process as the signal would have.
 */
function restoreTerminalOnSignal(input: TerminalInput): () => void {
  const listeners = (Object.keys(SIGNAL_EXIT_CODES) as Array<keyof typeof SIGNAL_EXIT_CODES>).map((signal) => {
    const listener = () => {
      // On a real hangup the terminal is gone and setRawMode throws; the
      // exit must happen all the same.
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') input.setRawMode(false);
      } catch { /* no terminal left to restore */ }
      process.exit(SIGNAL_EXIT_CODES[signal]);
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  return () => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  };
}

/** What the drain found: input to ask on, input that has ended, or Ctrl+C. */
type Drained = 'open' | 'ended' | 'cancelled';

/**
 * Throw away what is queued on the input, and say what is left of it.
 *
 * `codeep account` waits for the browser with nothing reading the terminal,
 * so an Enter pressed meanwhile waited in the input queue — and the readline
 * started for "[Y/n]" read it as the answer: the default, yes. So the queue
 * is read for a moment and dropped before every question. In raw mode for
 * that moment, so a line typed without Enter goes too: the terminal holds
 * one back in cooked mode, and would hand it to readline as if typed at the
 * question. Raw mode also makes Ctrl+C a key here rather than a signal, and
 * it is not dropped with the rest: it cancels, as it does at the question.
 */
function discardTypeAhead(input: TerminalInput): Promise<Drained> {
  if (input.readableEnded) return Promise.resolve('ended');
  const raw = input.isTTY === true && typeof input.setRawMode === 'function';
  const wasRaw = input.isRaw === true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (drained: Drained) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', drop);
      input.removeListener('end', onEnd);
      input.pause();
      if (raw) input.setRawMode!(wasRaw);
      resolve(drained);
    };
    const drop = (chunk: unknown) => {
      if (String(chunk).includes('\x03')) done('cancelled');
    };
    const onEnd = () => done('ended');
    if (raw) input.setRawMode!(true);
    input.on('data', drop);
    input.once('end', onEnd);
    const timer = setTimeout(() => done('open'), TYPE_AHEAD_MS);
    input.resume();
  });
}
