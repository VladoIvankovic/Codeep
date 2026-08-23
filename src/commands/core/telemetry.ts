// commands/core/telemetry.ts
// Core semantics of `/telemetry` — shared by TUI and ACP dispatch.
//
// Single source of truth for: env-forced-off check, config toggle,
// and the status report facts. Presentation (markdown vs banner) is the
// surface's job; this returns plain-data CommandResults.

import { config, isTelemetryEnabled, telemetryForcedOffByEnv } from '../../config/index';
import { ok, warn, info, type CommandResult } from './index';

export function telemetryCommand(args: string[]): CommandResult {
  const sub = args[0]?.toLowerCase();
  const envOff = telemetryForcedOffByEnv();

  if (sub === 'on' || sub === 'off') {
    if (envOff) {
      return warn(
        'Telemetry is forced off by CODEEP_NO_TELEMETRY / DO_NOT_TRACK — unset that env var to change it. The config flag can\'t override an env var.',
      );
    }
    config.set('telemetry', sub === 'on');
    return ok(
      sub === 'on'
        ? 'Telemetry on — usage stats, session transcripts, progress and memory notes sync to codeep.dev.'
        : 'Telemetry off — no automatic cloud uploads. Explicit /account push still works.',
    );
  }

  if (sub && sub !== 'status') {
    return info('Usage: /telemetry · /telemetry on · /telemetry off');
  }

  const flag = config.get('telemetry') !== false;
  const lines = [
    `Telemetry: ${isTelemetryEnabled() ? 'on' : 'off'}`,
    `- Config flag \`telemetry\`: ${flag}`,
  ];
  if (envOff) {
    lines.push('- Forced off by `CODEEP_NO_TELEMETRY` / `DO_NOT_TRACK` (env overrides the flag).');
  }
  lines.push(
    '',
    'Toggle with `/telemetry on` | `/telemetry off`. Controls automatic uploads of usage stats, session transcripts, progress, and memory notes.',
  );
  return info(lines.join('\n'));
}
