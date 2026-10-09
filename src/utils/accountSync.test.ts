import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { config, clearApiKey, isKeySyncEnabled, loadApiKey, loadStoredApiKey, setApiKey } from '../config/index';
import { PROVIDERS, getProviderList } from '../config/providers';
import { keysyncCommand, KEY_SYNC_DISCLOSURE, KEY_SYNC_ON } from '../commands/core/keysync';
import {
  CANCELLED,
  askOnTerminal,
  offerSyncAfterLink,
  runAccountPush,
  runAccountSync,
  syncKeysLoginHint,
  type AccountRequests,
  type Answer,
} from './accountSync';
import type { SyncResult } from './codeepCloud';

/**
 * `codeep account sync` on a new machine, and `codeep account push`. Sync
 * skipped the API keys until `/keysync on` had been typed — in the TUI, which
 * does not start without a key — and after a pull nothing chose a provider
 * the keys were for, so the TUI still opened on "pick a provider". Push sent
 * keys read from environment variables. The config and the keychain are this
 * worker's own (vitest.setup.ts), and the requests are answered here: fetch
 * refuses anything that gets past them.
 */

const OFF_SKIPPED = '  Cloud key sync is off — skipping API keys. Pull them with: codeep account sync --keys\n';
const PUSH_LINE = '  With key sync on, `codeep account push` also uploads the API keys stored on this machine.';
const KEY_QUESTION = '  Turn on cloud key sync and pull your API keys now? [y/N] ';
const OFFER_QUESTION = '  Pull your agents, commands and profile from codeep.dev now? [Y/n] ';
const NEXT_STEP = '  Next: codeep account sync\n  To pull your API keys too: codeep account sync --keys\n';
/** What is shown before the key question, and before acting on --keys. */
const BEFORE_CONSENT = `  ${KEY_SYNC_DISCLOSURE}\n${PUSH_LINE}\n`;

const nothing: SyncResult = { ok: true, count: 0, removed: 0 };

/** codeep.dev, answering with these keys and nothing new otherwise. */
function server(keys: Record<string, unknown> | null = {}) {
  return {
    pullKeys: vi.fn(async () => keys as Record<string, string> | null),
    pullPersonalities: vi.fn(async (): Promise<SyncResult> => nothing),
    pullCommands: vi.fn(async (): Promise<SyncResult> => nothing),
    pullUserProfileResult: vi.fn(async (): Promise<SyncResult> => nothing),
    getLastPersonalityPullBackupCount: vi.fn(() => 0),
    pushKeys: vi.fn(async (_keys: Record<string, string>) => true),
    pushPersonalities: vi.fn(async (): Promise<SyncResult> => nothing),
    pushCommands: vi.fn(async (): Promise<SyncResult> => nothing),
    pushUserProfileResult: vi.fn(async (): Promise<SyncResult> => nothing),
  } satisfies AccountRequests;
}

/** Every request the server above answers, for "nothing was pulled". */
const pulls = (requests: ReturnType<typeof server>) => [
  requests.pullKeys, requests.pullPersonalities, requests.pullCommands, requests.pullUserProfileResult,
];

/**
 * A terminal (or a pipe) with these answers typed in turn — null for none,
 * as Ctrl+D gives, CANCELLED for Ctrl+C — and what it shows, questions and
 * answers too.
 */
function shell(options: { tty?: boolean; answers?: Answer[] } = {}) {
  let transcript = '';
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const io = {
    log: (line: string) => { transcript += `${line}\n`; },
    write: (text: string) => { transcript += text; },
    ask: vi.fn(async (question: string): Promise<Answer> => {
      asked.push(question);
      const answer = answers.length > 0 ? answers.shift()! : null;
      transcript += `${question}${typeof answer === 'string' ? answer : ''}\n`;
      return answer;
    }),
    stdinIsTTY: options.tty ?? false,
    stdoutIsTTY: options.tty ?? false,
  };
  return { io, asked, transcript: () => transcript };
}

beforeEach(async () => {
  vi.stubGlobal('fetch', async (url: unknown) => { throw new Error(`test tried to reach ${String(url)}`); });
  // Not the developer's shell: a provider key exported there is a key this
  // machine has, CODEEP_NO_KEY_SYNC forces key sync off, and CI (set on a CI
  // runner) means no question is ever asked.
  vi.stubEnv('CODEEP_NO_KEY_SYNC', '');
  vi.stubEnv('CI', '');
  vi.stubEnv('ZAI_API_KEY', '');
  vi.stubEnv('ZHIPUAI_API_KEY', '');
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.envKey) vi.stubEnv(provider.envKey, '');
  }
  config.set('syncToken', 'sync-token');
  config.set('syncKeysToCloud', false);
  config.set('provider', 'z.ai');
  config.set('model', PROVIDERS['z.ai'].defaultModel);
  for (const id of [...Object.keys(PROVIDERS), 'retired-provider']) await clearApiKey(id);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('codeep account sync, with cloud key sync off', () => {
  it('pulls no keys from a pipe, and names the shell command that does', async () => {
    const { io, transcript } = shell();
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests })).toBe(0);
    expect(transcript()).toContain(OFF_SKIPPED);
    expect(io.ask).not.toHaveBeenCalled();
    expect(requests.pullKeys).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
    // The rest is pulled as ever.
    expect(requests.pullPersonalities).toHaveBeenCalled();
  });

  it('turns key sync on with --keys, after the disclosure and what push will upload, and pulls the keys', async () => {
    const { io, transcript } = shell();
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests, keys: true })).toBe(0);
    expect(transcript()).toBe([
      `  ${KEY_SYNC_DISCLOSURE}`,
      PUSH_LINE,
      `  ${KEY_SYNC_ON}`,
      '  Pulling keys from codeep.dev... synced 1 key.',
      `  Using ${PROVIDERS.openai.name} — change it with /provider`,
      '  Agents already up to date.',
      '',
      '',
    ].join('\n'));
    expect(io.ask).not.toHaveBeenCalled();
    // On, and staying on, as after /keysync on.
    expect(config.get('syncKeysToCloud')).toBe(true);
    expect(isKeySyncEnabled()).toBe(true);
    expect(await loadApiKey('openai')).toBe('sk-openai-0123456789');
  });

  it('asks on a terminal with no key on it, after the disclosure, and takes Enter as no', async () => {
    const { io, asked, transcript } = shell({ tty: true, answers: [''] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests })).toBe(0);
    expect(asked).toEqual([KEY_QUESTION]);
    expect(transcript().startsWith(`${BEFORE_CONSENT}${KEY_QUESTION}\n${OFF_SKIPPED}`)).toBe(true);
    expect(requests.pullKeys).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
  });

  for (const answer of ['y', 'Y', 'yes', ' YES ']) {
    it(`turns key sync on and pulls the keys on "${answer}"`, async () => {
      const { io, transcript } = shell({ tty: true, answers: [answer] });
      const requests = server({ openai: 'sk-openai-0123456789' });

      expect(await runAccountSync({ ...io, requests })).toBe(0);
      expect(transcript()).toContain(`${KEY_QUESTION}${answer}\n  ${KEY_SYNC_ON}\n  Pulling keys from codeep.dev... synced 1 key.\n`);
      expect(config.get('syncKeysToCloud')).toBe(true);
      expect(await loadApiKey('openai')).toBe('sk-openai-0123456789');
    });
  }

  for (const answer of ['n', 'no', 'N', 'nope', 'ja', null]) {
    it(`pulls no keys on ${answer === null ? 'no answer at all (Ctrl+D)' : `"${answer}"`}, and pulls the rest`, async () => {
      const { io, transcript } = shell({ tty: true, answers: [answer] });
      const requests = server({ openai: 'sk-openai-0123456789' });

      expect(await runAccountSync({ ...io, requests })).toBe(0);
      expect(transcript()).toContain(OFF_SKIPPED);
      expect(requests.pullKeys).not.toHaveBeenCalled();
      expect(config.get('syncKeysToCloud')).toBe(false);
      expect(requests.pullPersonalities).toHaveBeenCalled();
    });
  }

  it('asks only where both ends are a terminal', async () => {
    for (const [stdinIsTTY, stdoutIsTTY] of [[true, false], [false, true]]) {
      const { io, transcript } = shell({ answers: ['y'] });
      const requests = server({ openai: 'sk-openai-0123456789' });
      await runAccountSync({ ...io, stdinIsTTY, stdoutIsTTY, requests });
      expect(io.ask).not.toHaveBeenCalled();
      expect(transcript()).toContain(OFF_SKIPPED);
      expect(config.get('syncKeysToCloud')).toBe(false);
    }
  });
});

// Someone who keeps key sync off on purpose has keys already; asking them at
// every sync would make a nag of a consent question.
describe('the key question, on a machine that has keys already', () => {
  it('is not asked when a key is stored, and the command is named instead', async () => {
    await setApiKey('sk-ant-stored-0123456789', 'anthropic');
    const { io, transcript } = shell({ tty: true, answers: ['y'] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests })).toBe(0);
    expect(io.ask).not.toHaveBeenCalled();
    expect(transcript().startsWith(OFF_SKIPPED)).toBe(true);
    expect(requests.pullKeys).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
  });

  it('is not asked when a key comes from the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-0123456789');
    const { io, transcript } = shell({ tty: true, answers: ['y'] });

    await runAccountSync({ ...io, requests: server() });
    expect(io.ask).not.toHaveBeenCalled();
    expect(transcript()).toContain(OFF_SKIPPED);
  });

  it('is asked when the only key is for a provider that needs none', async () => {
    await setApiKey('custom-endpoint-key-0123', 'custom');
    const { io } = shell({ tty: true, answers: [''] });

    await runAccountSync({ ...io, requests: server() });
    expect(io.ask).toHaveBeenCalledWith(KEY_QUESTION);
  });

  it('does not stop --keys', async () => {
    await setApiKey('sk-ant-stored-0123456789', 'anthropic');
    const { io, transcript } = shell({ tty: true });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests, keys: true })).toBe(0);
    expect(transcript().startsWith(`${BEFORE_CONSENT}  ${KEY_SYNC_ON}\n`)).toBe(true);
    expect(requests.pullKeys).toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(true);
  });
});

describe('CI', () => {
  for (const value of ['true', '1', 'yes', 'TRUE']) {
    it(`asks nothing with CI=${value}, even on a terminal`, async () => {
      vi.stubEnv('CI', value);
      const sync = shell({ tty: true, answers: ['y'] });
      await runAccountSync({ ...sync.io, requests: server({ openai: 'sk-openai-0123456789' }) });
      expect(sync.io.ask).not.toHaveBeenCalled();
      expect(sync.transcript()).toContain(OFF_SKIPPED);

      const offer = shell({ tty: true, answers: ['y'] });
      const requests = server();
      await offerSyncAfterLink({ ...offer.io, requests });
      expect(offer.io.ask).not.toHaveBeenCalled();
      expect(offer.transcript()).toContain(NEXT_STEP);
      expect(requests.pullPersonalities).not.toHaveBeenCalled();
    });
  }

  for (const value of ['', '0', 'false', 'FALSE']) {
    it(`still asks with CI=${JSON.stringify(value)}`, async () => {
      vi.stubEnv('CI', value);
      const { io } = shell({ tty: true, answers: [''] });
      await runAccountSync({ ...io, requests: server() });
      expect(io.ask).toHaveBeenCalledWith(KEY_QUESTION);
    });
  }
});

describe('Ctrl+C at a question', () => {
  it('at the key question ends the sync with 130 and pulls nothing', async () => {
    const { io, transcript } = shell({ tty: true, answers: [CANCELLED] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests })).toBe(130);
    expect(transcript()).toBe(`${BEFORE_CONSENT}${KEY_QUESTION}\n  Cancelled.\n`);
    for (const request of pulls(requests)) expect(request).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
  });

  it('at the offer ends `codeep account` with 130 and pulls nothing', async () => {
    const { io, transcript } = shell({ tty: true, answers: [CANCELLED] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await offerSyncAfterLink({ ...io, requests })).toBe(130);
    expect(transcript()).toBe(`${OFFER_QUESTION}\n  Cancelled.\n`);
    for (const request of pulls(requests)) expect(request).not.toHaveBeenCalled();
  });

  it('at the key question after a yes to the offer pulls nothing either', async () => {
    const { io, asked } = shell({ tty: true, answers: ['', CANCELLED] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await offerSyncAfterLink({ ...io, requests })).toBe(130);
    expect(asked).toEqual([OFFER_QUESTION, KEY_QUESTION]);
    for (const request of pulls(requests)) expect(request).not.toHaveBeenCalled();
  });
});

describe('codeep account sync under CODEEP_NO_KEY_SYNC', () => {
  beforeEach(() => { vi.stubEnv('CODEEP_NO_KEY_SYNC', '1'); });

  it('never asks or turns key sync on, and says why', async () => {
    const { io, transcript } = shell({ tty: true, answers: ['y'] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests })).toBe(0);
    expect(transcript()).toContain('  Cloud key sync is forced off by CODEEP_NO_KEY_SYNC — skipping API keys.\n');
    expect(transcript()).not.toContain(KEY_SYNC_DISCLOSURE);
    expect(io.ask).not.toHaveBeenCalled();
    expect(requests.pullKeys).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
  });

  it('tells --keys why it did nothing, rather than override it', async () => {
    const { io, transcript } = shell();
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests, keys: true })).toBe(0);
    expect(transcript()).toContain(
      "  Cloud key sync is forced off by CODEEP_NO_KEY_SYNC — skipping API keys. --keys can't override an env var: unset CODEEP_NO_KEY_SYNC to pull them.\n",
    );
    expect(requests.pullKeys).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
  });

  it('wins over a flag that is already on', async () => {
    config.set('syncKeysToCloud', true);
    const { io } = shell();
    const requests = server({ openai: 'sk-openai-0123456789' });

    await runAccountSync({ ...io, requests });
    expect(requests.pullKeys).not.toHaveBeenCalled();
  });
});

describe('the disclosure', () => {
  it('is what /keysync on says, word for word', async () => {
    const turnedOn = keysyncCommand(['on']).message;
    config.set('syncKeysToCloud', false);
    const { io, transcript } = shell();

    await runAccountSync({ ...io, requests: server(), keys: true });
    const [disclosure, , on] = transcript().split('\n');
    expect(`${on.trim()} ${disclosure.trim()}`).toBe(turnedOn);
  });
});

describe('what the server sends as keys', () => {
  beforeEach(() => { config.set('syncKeysToCloud', true); });

  it('stores only API keys under provider names, counts the rest, and prints none of it', async () => {
    const { io, transcript } = shell({ tty: true });
    const requests = server({
      openai: 'sk-openai-0123456789',
      '\u001b[2J\u001b[31mowned': 'sk-escape-0123456789',
      'has space': 'sk-space-0123456789',
      '-leading-dash': 'sk-dash-0123456789',
      ['p'.repeat(65)]: 'sk-long-0123456789',
      blank: '   ',
      numeric: 42,
      nested: { key: 'sk-nested-0123456789' },
    });

    expect(await runAccountSync({ ...io, requests })).toBe(0);
    expect(transcript()).toContain('  Pulling keys from codeep.dev... synced 1 key.\n  Skipped 7 entries that are not API keys.\n');
    for (const leaked of ['\u001b', 'owned', 'has space', 'leading-dash', 'ppp', 'sk-escape', 'sk-space', 'sk-dash', 'sk-long', 'sk-nested', 'blank', 'numeric', 'nested']) {
      expect(transcript(), leaked).not.toContain(leaked);
    }
    expect(await loadApiKey('openai')).toBe('sk-openai-0123456789');
    for (const id of ['has space', '-leading-dash', 'blank', 'numeric', 'nested']) {
      expect(await loadStoredApiKey(id), id).toBe('');
    }
  });

  it('says "entry" for one', async () => {
    const { io, transcript } = shell();
    await runAccountSync({ ...io, requests: server({ openai: 'sk-openai-0123456789', blank: '' }) });
    expect(transcript()).toContain('  Skipped 1 entry that is not an API key.\n');
  });

  it('chooses no provider from an entry it skipped', async () => {
    const { io, transcript } = shell({ tty: true });
    await runAccountSync({ ...io, requests: server({ anthropic: '  ', openai: 'sk-openai-0123456789' }) });
    expect(config.get('provider')).toBe('openai');
    expect(transcript()).toContain(`  Using ${PROVIDERS.openai.name} — change it with /provider\n`);
  });

  it('fails on a key list that is not one, saying it could not be read', async () => {
    // Not "check your connection": the server answered, with something else.
    for (const keys of [['sk-a-0123456789', 'sk-b-0123456789'], 'sk-a-0123456789', 42]) {
      const { io, transcript } = shell();
      const requests = server(keys as unknown as Record<string, unknown>);
      expect(await runAccountSync({ ...io, requests })).toBe(1);
      expect(transcript()).toBe('  Pulling keys from codeep.dev... failed — codeep.dev sent a response this version cannot read.\n\n');
      expect(await loadStoredApiKey('0')).toBe('');
      expect(requests.pullPersonalities).not.toHaveBeenCalled();
    }
  });

  it('skips names every object has, as keys and as providers', async () => {
    // They passed the name check: stored, then listed as "Object", or
    // written over a prototype.
    const { io, transcript } = shell({ tty: true });
    const keys = JSON.parse('{"openai": "sk-openai-0123456789", "constructor": "sk-c-0123456789", "toString": "sk-t-0123456789", "hasOwnProperty": "sk-h-0123456789", "__proto__": "sk-p-0123456789"}');
    expect(Object.keys(keys)).toContain('__proto__');

    expect(await runAccountSync({ ...io, requests: server(keys) })).toBe(0);
    expect(transcript()).toContain('  Pulling keys from codeep.dev... synced 1 key.\n  Skipped 4 entries that are not API keys.\n');
    expect(config.get('configuredProviderIds')).toEqual(['openai']);
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(await loadStoredApiKey(name), name).toBe('');
    }
    expect(config.get('provider')).toBe('openai');
  });
});

describe('the provider the next codeep starts on', () => {
  beforeEach(() => { config.set('syncKeysToCloud', true); });

  it('is the first pulled provider in the order /provider lists them, when the current one has no key', async () => {
    const { io, transcript } = shell({ tty: true });
    // Neither the server's order nor the catalogue's.
    const requests = server({ openai: 'sk-openai-0123456789', 'z.ai-cn': 'zai-cn-0123456789', anthropic: 'sk-ant-0123456789', 'retired-provider': 'rp-0123456789' });
    const listed = getProviderList().map(p => p.id);
    const catalogue = Object.keys(PROVIDERS);
    expect(listed.indexOf('anthropic')).toBeLessThan(listed.indexOf('openai'));
    expect(catalogue.indexOf('z.ai-cn')).toBeLessThan(catalogue.indexOf('anthropic'));

    await runAccountSync({ ...io, requests });
    expect(config.get('provider')).toBe('anthropic');
    expect(config.get('model')).toBe(PROVIDERS.anthropic.defaultModel);
    expect(transcript()).toContain(`  Pulling keys from codeep.dev... synced 4 keys.\n  Using ${PROVIDERS.anthropic.name} — change it with /provider\n`);
  });

  it('stays when the current provider has a key in the environment', async () => {
    vi.stubEnv('ZAI_API_KEY', 'env-zai-0123456789');
    const { io, transcript } = shell({ tty: true });

    await runAccountSync({ ...io, requests: server({ openai: 'sk-openai-0123456789' }) });
    expect(config.get('provider')).toBe('z.ai');
    expect(transcript()).not.toContain('Using ');
  });

  it('stays when one of the pulled keys is the current provider’s', async () => {
    const { io, transcript } = shell({ tty: true });

    await runAccountSync({ ...io, requests: server({ openai: 'sk-openai-0123456789', 'z.ai': 'zai-0123456789' }) });
    expect(config.get('provider')).toBe('z.ai');
    expect(transcript()).not.toContain('Using ');
  });

  it('stays when the current provider needs no key', async () => {
    config.set('provider', 'ollama');
    const { io, transcript } = shell({ tty: true });

    await runAccountSync({ ...io, requests: server({ openai: 'sk-openai-0123456789' }) });
    expect(config.get('provider')).toBe('ollama');
    expect(transcript()).not.toContain('Using ');
  });

  it('is never one the catalogue does not know, though its key is stored', async () => {
    const { io, transcript } = shell({ tty: true });

    await runAccountSync({ ...io, requests: server({ 'retired-provider': 'rp-0123456789' }) });
    expect(await loadApiKey('retired-provider')).toBe('rp-0123456789');
    expect(config.get('provider')).toBe('z.ai');
    expect(transcript()).not.toContain('Using ');
  });

  it('stays in a sync nobody is watching — no terminal and no --keys — as the VS Code extension runs it', async () => {
    const { io, transcript } = shell();

    await runAccountSync({ ...io, requests: server({ openai: 'sk-openai-0123456789' }) });
    expect(await loadApiKey('openai')).toBe('sk-openai-0123456789');
    expect(config.get('provider')).toBe('z.ai');
    expect(transcript()).not.toContain('Using ');
  });

  it('is chosen off a terminal when --keys asked for the keys', async () => {
    const { io } = shell();

    await runAccountSync({ ...io, requests: server({ openai: 'sk-openai-0123456789' }), keys: true });
    expect(config.get('provider')).toBe('openai');
  });
});

describe('the rest of codeep account sync', () => {
  const pipe = (results: Partial<Record<'personalities' | 'commands' | 'profile', SyncResult>>, backups = 0) => {
    const { io, transcript } = shell();
    const requests = server();
    if (results.personalities) requests.pullPersonalities.mockResolvedValue(results.personalities);
    if (results.commands) requests.pullCommands.mockResolvedValue(results.commands);
    if (results.profile) requests.pullUserProfileResult.mockResolvedValue(results.profile);
    requests.getLastPersonalityPullBackupCount.mockReturnValue(backups);
    return { io, transcript, requests };
  };

  // Each line as main.ts printed it before the sync moved to this module.
  for (const [label, results, backups, lines] of [
    ['several of each', {
      personalities: { ok: true, count: 2, removed: 3 },
      commands: { ok: true, count: 4, removed: 0 },
      profile: { ok: true, count: 1, removed: 0 },
    }, 2, [
      '  Pulled 2 personalities.',
      '  Backed up 2 replaced local copies in ~/.codeep/backups/personalities/.',
      '  Removed 3 agents deleted on codeep.dev (backed up first).',
      '  Pulled 4 custom commands.',
      '  Pulled your profile (about you).',
    ]],
    ['one of each', {
      personalities: { ok: true, count: 1, removed: 1 },
      commands: { ok: true, count: 1, removed: 0 },
    }, 1, [
      '  Pulled 1 personality.',
      '  Backed up 1 replaced local copy in ~/.codeep/backups/personalities/.',
      '  Removed 1 agent deleted on codeep.dev (backed up first).',
      '  Pulled 1 custom command.',
    ]],
    ['only removals', { personalities: { ok: true, count: 0, removed: 2 } }, 0, [
      '  Removed 2 agents deleted on codeep.dev (backed up first).',
    ]],
    ['failures', {
      personalities: { ok: false, reason: 'rejected' },
      commands: { ok: false, reason: 'unreachable' },
      profile: { ok: false, reason: 'malformed' },
    }, 0, [
      '  Could not pull agents — codeep.dev refused the request — sign in again with: codeep account.',
      "  Could not pull custom commands — couldn't reach codeep.dev.",
      '  Could not pull your profile (about you) — codeep.dev sent a response this version cannot read.',
    ]],
  ] as const) {
    it(`says the same as before: ${label}`, async () => {
      const { io, transcript, requests } = pipe(results as Parameters<typeof pipe>[0], backups);
      // Failures included: they are reported, and the command still exits 0.
      expect(await runAccountSync({ ...io, requests })).toBe(0);
      expect(transcript()).toBe([OFF_SKIPPED.trimEnd(), ...lines, '', ''].join('\n'));
    });
  }

  it('exits 1 on a key pull that failed, before pulling anything else', async () => {
    config.set('syncKeysToCloud', true);
    const { io, transcript } = shell();
    const requests = server(null);

    expect(await runAccountSync({ ...io, requests })).toBe(1);
    expect(transcript()).toBe('  Pulling keys from codeep.dev... failed.\n  Check your connection or re-link with: codeep account\n\n');
    expect(requests.pullPersonalities).not.toHaveBeenCalled();
  });

  it('says so when the account holds no keys, and goes on', async () => {
    config.set('syncKeysToCloud', true);
    const { io, transcript } = shell();

    expect(await runAccountSync({ ...io, requests: server({}) })).toBe(0);
    expect(transcript()).toBe('  Pulling keys from codeep.dev... no keys found.\n  Add keys at codeep.dev/dashboard\n  Agents already up to date.\n\n');
  });

  it('exits 1 on a machine that is not linked, asking nothing', async () => {
    config.set('syncToken', '');
    const { io, transcript } = shell({ tty: true, answers: ['y'] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await runAccountSync({ ...io, requests, keys: true })).toBe(1);
    expect(transcript()).toBe('\n  Not linked to codeep.dev. Run: codeep account\n\n');
    expect(io.ask).not.toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(false);
    expect(requests.pullPersonalities).not.toHaveBeenCalled();
  });

  it('goes to codeep.dev through codeepCloud when nothing is passed in', async () => {
    const calls: Array<{ url: string; token: unknown }> = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), token: (init?.headers as Record<string, string> | undefined)?.['x-sync-token'] });
      const path = new URL(String(url)).pathname;
      const body = path === '/api/keys' ? { ok: true, keys: { openai: 'sk-openai-from-the-dashboard' } }
        : path === '/api/sync/user-profile' ? { ok: true, content: null }
        : { ok: true, items: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { io, transcript } = shell();

    expect(await runAccountSync({ log: io.log, write: io.write, stdinIsTTY: false, stdoutIsTTY: false, keys: true })).toBe(0);
    expect(calls).toEqual([
      { url: 'https://codeep.dev/api/keys', token: 'sync-token' },
      { url: 'https://codeep.dev/api/personalities', token: 'sync-token' },
      { url: 'https://codeep.dev/api/commands', token: 'sync-token' },
      { url: 'https://codeep.dev/api/sync/user-profile', token: 'sync-token' },
    ]);
    expect(await loadApiKey('openai')).toBe('sk-openai-from-the-dashboard');
    expect(transcript()).toContain('  Pulling keys from codeep.dev... synced 1 key.\n');
  });
});

// Push sent what the key cache held, and the cache holds a key from an
// environment variable ahead of a stored one.
describe('codeep account push and the API keys', () => {
  const ANTHROPIC_STORED = 'sk-ant-STORED-1111111111';
  const ANTHROPIC_ENV = 'sk-ant-ENV-2222222222';
  const OPENAI_STORED = 'sk-openai-STORED-3333333333';
  const OPENAI_ENV = 'sk-openai-ENV-4444444444';
  const ZAI_LEGACY_ENV = 'zai-LEGACY-ENV-5555555555';
  const ALL_VALUES = [ANTHROPIC_STORED, ANTHROPIC_ENV, OPENAI_STORED, OPENAI_ENV, ZAI_LEGACY_ENV];

  beforeEach(() => { config.set('syncKeysToCloud', true); });

  async function push() {
    const { io, transcript } = shell();
    const requests = server();
    const code = await runAccountPush({ ...io, requests });
    for (const value of ALL_VALUES) expect(transcript(), 'a key in the output').not.toContain(value);
    return { code, transcript: transcript(), requests };
  }

  it('uploads a key stored on this machine, as before', async () => {
    await setApiKey(OPENAI_STORED, 'openai');
    const { code, transcript, requests } = await push();

    expect(code).toBe(0);
    expect(requests.pushKeys).toHaveBeenCalledTimes(1);
    expect(requests.pushKeys).toHaveBeenCalledWith({ openai: OPENAI_STORED });
    expect(transcript).toBe('  Pushing 1 key to codeep.dev... done.\n\n');
  });

  it('uploads the stored key, not the environment’s, where there are both', async () => {
    await setApiKey(ANTHROPIC_STORED, 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', ANTHROPIC_ENV);
    const { requests, transcript } = await push();

    expect(requests.pushKeys).toHaveBeenCalledWith({ anthropic: ANTHROPIC_STORED });
    expect(transcript).not.toContain('Skipped');
  });

  it('leaves out a key read only from the environment, and names its provider', async () => {
    await setApiKey(OPENAI_STORED, 'openai');
    vi.stubEnv('ANTHROPIC_API_KEY', ANTHROPIC_ENV);
    const { requests, transcript } = await push();

    expect(requests.pushKeys).toHaveBeenCalledWith({ openai: OPENAI_STORED });
    expect(transcript).toBe(
      '  Pushing 1 key to codeep.dev... done.\n'
      + `  Skipped 1 key read from an environment variable (not uploaded): ${PROVIDERS.anthropic.name}\n\n`,
    );
  });

  it('has nothing to push when every key is from the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ANTHROPIC_ENV);
    vi.stubEnv('OPENAI_API_KEY', OPENAI_ENV);
    const { code, requests, transcript } = await push();

    expect(code).toBe(0);
    expect(requests.pushKeys).not.toHaveBeenCalled();
    expect(transcript).toBe(
      '  No local API keys to push.\n'
      + `  Skipped 2 keys read from environment variables (not uploaded): ${[PROVIDERS.openai.name, PROVIDERS.anthropic.name].join(', ')}\n\n`,
    );
  });

  for (const variable of ['ZAI_API_KEY', 'ZHIPUAI_API_KEY']) {
    it(`leaves out Z.AI's key from ${variable} too`, async () => {
      vi.stubEnv(variable, ZAI_LEGACY_ENV);
      const { requests, transcript } = await push();

      expect(requests.pushKeys).not.toHaveBeenCalled();
      expect(transcript).toMatch(/\(not uploaded\): .*/);
      expect(transcript.split('(not uploaded): ')[1].split('\n')[0].split(', ')).toContain(PROVIDERS['z.ai'].name);
    });
  }

  it('uploads Z.AI\'s stored key, not ZAI_API_KEY', async () => {
    await setApiKey(OPENAI_STORED.replace('openai', 'zai'), 'z.ai');
    vi.stubEnv('ZAI_API_KEY', ZAI_LEGACY_ENV);
    const { requests } = await push();

    expect(requests.pushKeys).toHaveBeenCalledWith({ 'z.ai': OPENAI_STORED.replace('openai', 'zai') });
  });

  it('says nothing of a provider with no key at all', async () => {
    const { requests, transcript } = await push();

    expect(requests.pushKeys).not.toHaveBeenCalled();
    expect(transcript).toBe('  No local API keys to push.\n\n');
  });

  it('exits 1 when the keys could not be pushed, as before', async () => {
    await setApiKey(OPENAI_STORED, 'openai');
    const { io, transcript } = shell();
    const requests = server();
    requests.pushKeys.mockResolvedValue(false);

    expect(await runAccountPush({ ...io, requests })).toBe(1);
    expect(transcript()).toBe('  Pushing 1 key to codeep.dev... failed.\n\n');
  });

  it('pushes no keys with key sync off, as before', async () => {
    config.set('syncKeysToCloud', false);
    await setApiKey(OPENAI_STORED, 'openai');
    const { io, transcript } = shell();
    const requests = server();

    expect(await runAccountPush({ ...io, requests })).toBe(0);
    expect(requests.pushKeys).not.toHaveBeenCalled();
    expect(transcript()).toBe('  Cloud key sync is off — skipping API keys. Enable with: /keysync on\n\n');
  });
});

describe('the offer once codeep account has linked the machine', () => {
  it('asks on a terminal and, on Enter, syncs — asking about keys in turn', async () => {
    const { io, asked, transcript } = shell({ tty: true, answers: ['', 'y'] });
    const requests = server({ openai: 'sk-openai-0123456789' });

    expect(await offerSyncAfterLink({ ...io, requests })).toBe(0);
    expect(asked).toEqual([OFFER_QUESTION, KEY_QUESTION]);
    expect(transcript().startsWith(`${OFFER_QUESTION}\n${BEFORE_CONSENT}${KEY_QUESTION}y\n`)).toBe(true);
    expect(requests.pullKeys).toHaveBeenCalled();
    expect(requests.pullPersonalities).toHaveBeenCalled();
    expect(config.get('syncKeysToCloud')).toBe(true);
  });

  for (const answer of ['n', 'no', null]) {
    it(`pulls nothing on ${answer === null ? 'no answer (Ctrl+D)' : `"${answer}"`}, and says what to run`, async () => {
      const { io, asked, transcript } = shell({ tty: true, answers: [answer] });
      const requests = server({ openai: 'sk-openai-0123456789' });

      expect(await offerSyncAfterLink({ ...io, requests })).toBe(0);
      expect(asked).toEqual([OFFER_QUESTION]);
      expect(transcript()).toContain(NEXT_STEP);
      for (const request of pulls(requests)) expect(request).not.toHaveBeenCalled();
    });
  }

  it('asks nothing off a terminal, and says what to run', async () => {
    const { io, transcript } = shell();
    const requests = server();

    expect(await offerSyncAfterLink({ ...io, requests })).toBe(0);
    expect(io.ask).not.toHaveBeenCalled();
    expect(transcript()).toBe(`${NEXT_STEP}\n`);
    expect(requests.pullPersonalities).not.toHaveBeenCalled();
  });

  it('leaves --keys out where it would do nothing', async () => {
    config.set('syncKeysToCloud', true);
    const on = shell();
    await offerSyncAfterLink({ ...on.io, requests: server() });
    expect(on.transcript()).toBe('  Next: codeep account sync\n\n');

    config.set('syncKeysToCloud', false);
    vi.stubEnv('CODEEP_NO_KEY_SYNC', '1');
    const forcedOff = shell();
    await offerSyncAfterLink({ ...forcedOff.io, requests: server() });
    expect(forcedOff.transcript()).toBe('  Next: codeep account sync\n\n');
  });

  it('exits as the sync it ran did', async () => {
    config.set('syncKeysToCloud', true);
    const { io } = shell({ tty: true, answers: ['y'] });

    expect(await offerSyncAfterLink({ ...io, requests: server(null) })).toBe(1);
  });
});

describe('the line for the first-run provider screen', () => {
  it('points a linked machine at account sync --keys, command whole at 50 columns', () => {
    const hint = syncKeysLoginHint();
    expect(hint).toBe('Keys on codeep.dev: codeep account sync --keys');
    // The screen leaves 4 columns of its width unused.
    expect(hint!.length).toBeLessThanOrEqual(50 - 4);
  });

  it('is not there on a machine that is not linked, or where key sync is forced off', () => {
    config.set('syncToken', '');
    expect(syncKeysLoginHint()).toBeUndefined();

    config.set('syncToken', 'sync-token');
    vi.stubEnv('CODEEP_NO_KEY_SYNC', '1');
    expect(syncKeysLoginHint()).toBeUndefined();
  });
});

describe('askOnTerminal', () => {
  /** A pipe pair; `terminal` makes both ends say they are a TTY, so
   *  readline reads keys (Ctrl+C, Ctrl+D) the way it does on a terminal. */
  function streams(terminal = false) {
    const input = Object.assign(new PassThrough(), terminal
      ? { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this; } }
      : {});
    const output = Object.assign(new PassThrough(), terminal ? { isTTY: true, columns: 100, rows: 30 } : {});
    let shown = '';
    output.on('data', (chunk) => { shown += String(chunk); });
    /** Type `keys` once `text` has been shown this many times. */
    const typeAfter = async (text: string, keys: string, times = 1) => {
      await vi.waitFor(() => expect(shown.split(text).length - 1).toBeGreaterThanOrEqual(times));
      input.write(keys);
    };
    return { input, output, shown: () => shown, typeAfter };
  }

  it('resolves with the line typed at the question', async () => {
    const { input, output, typeAfter } = streams();
    const answer = askOnTerminal('Go? [y/N] ', input, output);
    await typeAfter('Go? [y/N] ', 'y\n');
    expect(await answer).toBe('y');
  });

  it('takes nothing typed before the question as its answer', async () => {
    // An Enter pressed while `codeep account` waited for the browser, with
    // nothing reading the terminal: readline read it as "[Y/n]"'s yes.
    const { input, output, typeAfter } = streams();
    input.write('\n');
    input.write('y\n');
    const answer = askOnTerminal('Go? [Y/n] ', input, output);
    await typeAfter('Go? [Y/n] ', 'n\n');
    expect(await answer).toBe('n');
  });

  it('drops an answer typed ahead for the second of two questions', async () => {
    // Consent counts only once its disclosure has been shown.
    const { input, output, typeAfter } = streams();
    const first = askOnTerminal('First? [Y/n] ', input, output);
    await typeAfter('First? [Y/n] ', '\n');
    expect(await first).toBe('');
    input.write('y\n');
    const second = askOnTerminal('Second? [y/N] ', input, output);
    await typeAfter('Second? [y/N] ', 'n\n');
    expect(await second).toBe('n');
  });

  it('resolves null, not an empty answer, when the input ends first', async () => {
    // An empty answer would be "[Y/n]"'s yes.
    const { input, output } = streams();
    const answer = askOnTerminal('Go? [Y/n] ', input, output);
    input.end();
    expect(await answer).toBeNull();
  });

  it('resolves CANCELLED for Ctrl+C and null for Ctrl+D on a terminal', async () => {
    const c = streams(true);
    const cancelled = askOnTerminal('Go? [Y/n] ', c.input, c.output);
    await c.typeAfter('Go? [Y/n] ', '\x03');
    expect(await cancelled).toBe(CANCELLED);

    const d = streams(true);
    const closed = askOnTerminal('Go? [Y/n] ', d.input, d.output);
    await d.typeAfter('Go? [Y/n] ', '\x04');
    expect(await closed).toBeNull();
  });

  it('takes Ctrl+C typed while it drains the input as a cancel, without showing the question', async () => {
    const t = streams(true);
    const answer = askOnTerminal('Go? [Y/n] ', t.input, t.output);
    t.input.write('\x03');
    expect(await answer).toBe(CANCELLED);
    expect(t.shown()).not.toContain('Go? [Y/n] ');
    expect(t.input.isRaw).toBe(false);
  });

  it('puts the terminal back itself when the input ends while it drains', async () => {
    // No question is asked then, so nothing else would.
    const t = streams(true);
    const answer = askOnTerminal('Go? [Y/n] ', t.input, t.output);
    await vi.waitFor(() => expect(t.input.isRaw).toBe(true));
    t.input.end();
    expect(await answer).toBeNull();
    expect(t.input.isRaw).toBe(false);
  });

  it('restores the terminal and ends as the signal would, for as long as a question is up', async () => {
    // SIGTERM and SIGHUP left the shell without echo: conf's exit hook
    // raises them again, and nothing put the terminal back.
    const signals = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;
    const before = new Map(signals.map(signal => [signal, process.listeners(signal)]));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const t = streams(true);
      const answer = askOnTerminal('Go? [Y/n] ', t.input, t.output);
      for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]] as const) {
        const added = process.listeners(signal).filter(listener => !before.get(signal)!.includes(listener));
        expect(added, signal).toHaveLength(1);
        t.input.setRawMode!(true);
        (added[0] as () => void)();
        expect(t.input.isRaw, signal).toBe(false);
        expect(exit).toHaveBeenLastCalledWith(code);
      }
      await t.typeAfter('Go? [Y/n] ', 'y\r');
      expect(await answer).toBe('y');
      // Nothing left listening once it is answered.
      for (const signal of signals) expect(process.listeners(signal), signal).toEqual(before.get(signal));
    } finally {
      exit.mockRestore();
    }
  });

  it('still ends with the signal\'s code when the terminal is already gone', async () => {
    // A real hangup: the tty is closed, and setRawMode throws.
    const before = process.listeners('SIGHUP');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const t = streams(true);
      const answer = askOnTerminal('Go? [Y/n] ', t.input, t.output);
      const added = process.listeners('SIGHUP').filter(listener => !before.includes(listener));
      const working = t.input.setRawMode!;
      t.input.setRawMode = () => { throw new Error('EIO: the terminal is gone'); };
      expect(() => (added[0] as () => void)()).not.toThrow();
      expect(exit).toHaveBeenLastCalledWith(129);
      // (The process would be gone; let the question end for the next test.)
      t.input.setRawMode = working;
      t.input.end();
      await answer;
    } finally {
      exit.mockRestore();
    }
  });

  it('stops listening for signals however the question ends', async () => {
    const before = process.listenerCount('SIGTERM');
    const ended = streams(true);
    const a = askOnTerminal('Go? [Y/n] ', ended.input, ended.output);
    ended.input.end();
    await a;
    const cancelled = streams(true);
    const b = askOnTerminal('Go? [Y/n] ', cancelled.input, cancelled.output);
    await cancelled.typeAfter('Go? [Y/n] ', '\x03');
    await b;
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('leaves a terminal in the mode it found it', async () => {
    const t = streams(true);
    const answer = askOnTerminal('Go? [Y/n] ', t.input, t.output);
    await t.typeAfter('Go? [Y/n] ', 'y\r');
    expect(await answer).toBe('y');
    expect(t.input.isRaw).toBe(false);
  });
});
