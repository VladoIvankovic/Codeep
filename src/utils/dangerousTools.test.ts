import { describe, it, expect, beforeEach } from 'vitest';
// No fs mock here on purpose: buildDangerousTools reads the real `config`
// (isolated per worker via CODEEP_CONFIG_DIR in vitest.setup.ts).
import { buildDangerousTools } from './agent';
import { config } from '../config/index';

describe('buildDangerousTools (per-run gating, no global mutation)', () => {
  beforeEach(() => {
    config.set('agentConfirmDeleteFile', true);
    config.set('agentConfirmExecuteCommand', true);
    config.set('agentConfirmWriteFile', false);
  });

  it('derives the built-in dangerous set from config', () => {
    const t = buildDangerousTools();
    expect(t.has('delete_file')).toBe(true);
    expect(t.has('execute_command')).toBe(true);
    expect(t.has('write_file')).toBe(false);
    expect(t.has('edit_file')).toBe(false);
  });

  it('respects config flags set to false', () => {
    config.set('agentConfirmDeleteFile', false);
    const t = buildDangerousTools();
    expect(t.has('delete_file')).toBe(false);
    expect(t.has('execute_command')).toBe(true);
  });

  it('forces extra tools in for this run WITHOUT enabling them globally', () => {
    const t = buildDangerousTools(['write_file', 'edit_file']);
    expect(t.has('write_file')).toBe(true);
    expect(t.has('edit_file')).toBe(true);
    // The global flag must NOT have been flipped — this is the whole point:
    // ACP manual mode no longer leaks its mode into the shared config.
    expect(config.get('agentConfirmWriteFile')).toBe(false);
  });
});
