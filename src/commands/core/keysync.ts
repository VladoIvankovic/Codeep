// commands/core/keysync.ts
// Core semantics of `/keysync` — shared by TUI and ACP dispatch.
//
// Single source of truth for: env-forced-off check, config toggle, and the
// status report facts (including the server-readable-keys disclosure that
// must always accompany enabling sync).

import { config, keySyncForcedOffByEnv, isKeySyncEnabled } from '../../config/index';
import { ok, warn, info, type CommandResult } from './index';

export function keysyncCommand(args: string[]): CommandResult {
  const sub = args[0]?.toLowerCase();
  const envOff = keySyncForcedOffByEnv();

  if (sub === 'on' || sub === 'off') {
    if (envOff) {
      return warn(
        'Cloud key sync is forced off by CODEEP_NO_KEY_SYNC — unset that env var to change it. The config flag can\'t override an env var.',
      );
    }
    config.set('syncKeysToCloud', sub === 'on');
    return ok(
      sub === 'on'
        ? 'Cloud key sync on — `codeep account push`/`sync` will now upload/download API keys. Note: synced keys are stored server-readable on codeep.dev.'
        : 'Cloud key sync off — API keys stay in your OS keychain only. (`codeep account purge-keys` wipes any keys already on the server.)',
    );
  }

  if (sub && sub !== 'status') {
    return info('Usage: /keysync · /keysync on · /keysync off');
  }

  const flag = config.get('syncKeysToCloud') === true;
  const lines = [
    `Cloud key sync: ${isKeySyncEnabled() ? 'on' : 'off'}`,
    `- Config flag \`syncKeysToCloud\`: ${flag}`,
  ];
  if (envOff) {
    lines.push('- Forced off by `CODEEP_NO_KEY_SYNC` (env overrides the flag).');
  }
  lines.push(
    '',
    'OFF by default — API keys live only in your OS keychain unless enabled. When on, `codeep account push`/`sync` move keys, stored server-readable on codeep.dev.',
  );
  return info(lines.join('\n'));
}
