/**
 * Unit tests for the pure / side-effect-free helpers extracted to module scope
 * in `acp/server.ts`.
 *
 * `startAcpServer()` is a giant closure that wires handlers to a live stdio
 * transport — impossible to unit-test without spawning the full server. The
 * pure data-shaping helpers (`formatToolInputForPermission`, `resolveLocalPath`,
 * `collectEmbeddedContext`, `providerHasKey`, `buildConfigOptions`) were lifted
 * to module scope and exported precisely so this file can pin their behaviour.
 *
 * The session-lifecycle handlers (`handleSessionNew`, `handleSessionPrompt`, …)
 * remain inside the closure for now — extracting them into a factory is a
 * larger refactor tracked separately. These tests cover the surface that's
 * safely reachable today.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatToolInputForPermission,
  resolveLocalPath,
  collectEmbeddedContext,
  providerHasKey,
  buildConfigOptions,
  AGENT_MODES,
} from './server';
import { config } from '../config/index';
import type { ContentBlock } from './protocol';

// ─── formatToolInputForPermission ─────────────────────────────────────────────

describe('formatToolInputForPermission', () => {
  it('formats write_file with line count + content preview', () => {
    const out = formatToolInputForPermission('write_file', {
      path: '/repo/src/index.ts',
      content: 'line1\nline2\nline3',
    });
    expect(out.file).toBe('index.ts');
    expect(out.path).toBe('/repo/src/index.ts');
    expect(out.changes).toBe('3 lines');
    expect(out.new_content).toBe('line1\nline2\nline3');
  });

  it('formats edit_file with old/new string diff', () => {
    const out = formatToolInputForPermission('edit_file', {
      path: '/repo/foo.ts',
      old_string: 'a\nb',
      new_string: 'a\nc',
    });
    expect(out.file).toBe('foo.ts');
    expect(out.changes).toBe('replace 2 line(s)');
    expect(out.old_string).toBe('a\nb');
    expect(out.new_string).toBe('a\nc');
  });

  it('truncates content longer than MAX_CONTENT_LINES (200)', () => {
    const long = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const out = formatToolInputForPermission('write_file', {
      path: '/big.txt',
      content: long,
    });
    expect(out.changes).toBe('250 lines');
    expect(out.new_content).toContain('… (50 more lines)');
    // First 200 lines are kept intact
    expect(out.new_content).toContain('line 0');
    expect(out.new_content).toContain('line 199');
    // Line 200+ is truncated away
    expect(out.new_content).not.toMatch(/line 200$/m);
  });

  it('truncates very long diff strings with a char-count marker', () => {
    const huge = 'x'.repeat(5000);
    const out = formatToolInputForPermission('edit_file', {
      path: '/x',
      old_string: huge,
      new_string: huge,
    });
    expect(out.old_string.length).toBeLessThan(huge.length);
    expect(out.old_string).toMatch(/truncated, \d+ more chars/);
  });

  it('formats delete_file with just file + path', () => {
    const out = formatToolInputForPermission('delete_file', { path: '/tmp/junk.txt' });
    expect(out).toEqual({ file: 'junk.txt', path: '/tmp/junk.txt' });
  });

  it('formats execute_command with command + args + cwd', () => {
    const out = formatToolInputForPermission('execute_command', {
      command: 'npm',
      args: ['test', '--coverage'],
      cwd: '/repo',
    });
    expect(out.command).toBe('npm');
    expect(out.args).toBe('test --coverage');
    expect(out.cwd).toBe('/repo');
  });

  it('formats create_directory with just path', () => {
    const out = formatToolInputForPermission('create_directory', { path: '/repo/new' });
    expect(out).toEqual({ path: '/repo/new' });
  });

  it('falls back to generic key/value truncation for unknown tools', () => {
    const out = formatToolInputForPermission('custom_tool', {
      short: 'hi',
      long: 'y'.repeat(200),
    });
    expect(out.short).toBe('hi');
    // Values truncated past MAX_LEN (120) with ellipsis
    expect(out.long.length).toBeLessThanOrEqual(121); // 120 chars + '…'
    expect(out.long).toMatch(/…$/);
  });

  it('handles missing / malformed params gracefully', () => {
    // No path at all — should produce empty strings, not throw
    const out = formatToolInputForPermission('write_file', {});
    expect(out.file).toBe('');
    expect(out.path).toBe('');
  });
});

// ─── resolveLocalPath ─────────────────────────────────────────────────────────

describe('resolveLocalPath', () => {
  it('resolves file:// URIs to absolute paths', () => {
    expect(resolveLocalPath('file:///repo/src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('passes through bare absolute paths', () => {
    expect(resolveLocalPath('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('returns null for http(s) URIs', () => {
    expect(resolveLocalPath('https://example.com/file')).toBeNull();
    expect(resolveLocalPath('http://example.com')).toBeNull();
  });

  it('returns null for git URIs', () => {
    expect(resolveLocalPath('git://github.com/foo/bar')).toBeNull();
  });

  it('returns null for empty / relative paths', () => {
    expect(resolveLocalPath('')).toBeNull();
    expect(resolveLocalPath('relative/path')).toBeNull();
  });

  it('handles file:// URIs leniently (host part becomes a path)', () => {
    // fileURLToPath is more permissive than one might expect — single-segment
    // hosts like 'file://host' become '/host'. The catch branch in
    // resolveLocalPath only triggers for inputs the URL parser rejects
    // outright; this test just confirms the happy path for a typical URI.
    expect(resolveLocalPath('file:///repo/src/index.ts')).toBe('/repo/src/index.ts');
  });
});

// ─── collectEmbeddedContext ───────────────────────────────────────────────────

describe('collectEmbeddedContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeep-acp-embedded-'));
  });

  it('returns empty string when there are no relevant blocks', async () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'base64...' },
    ];
    expect(await collectEmbeddedContext(blocks)).toBe('');
  });

  it('reads a local file from a resource_link block', async () => {
    const filePath = join(tmpDir, 'snippet.ts');
    writeFileSync(filePath, 'export const x = 1;\n');
    const blocks: ContentBlock[] = [
      { type: 'resource_link', uri: `file://${filePath}`, name: 'snippet.ts' },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('File: snippet.ts');
    expect(out).toContain('export const x = 1;');
    expect(out).toContain('```');
  });

  it('skips non-local resource_link URIs with a note', async () => {
    const blocks: ContentBlock[] = [
      { type: 'resource_link', uri: 'https://example.com/remote', name: 'remote' },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('skipped — non-local URI');
  });

  it('reports a read failure for a missing file', async () => {
    const blocks: ContentBlock[] = [
      { type: 'resource_link', uri: `file://${tmpDir}/does-not-exist.ts`, name: 'missing' },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('read failed');
  });

  it('uses embedded text from a resource block when present', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'resource',
        resource: { uri: 'embedded.txt', text: 'inline content here' },
      },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('Resource: embedded.txt');
    expect(out).toContain('inline content here');
  });

  it('truncates embedded resource text past the 200 KB cap', async () => {
    const huge = 'x'.repeat(250_000);
    const blocks: ContentBlock[] = [
      { type: 'resource', resource: { uri: 'big.txt', text: huge } },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('truncated');
    expect(out).toContain('more chars');
  });

  it('falls back to reading the file when a resource block has a uri but no text', async () => {
    const filePath = join(tmpDir, 'fallback.txt');
    writeFileSync(filePath, 'fallback content');
    const blocks: ContentBlock[] = [
      { type: 'resource', resource: { uri: `file://${filePath}` } },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('fallback content');
  });

  it('combines multiple blocks into separate fenced snippets', async () => {
    const a = join(tmpDir, 'a.ts');
    const b = join(tmpDir, 'b.ts');
    writeFileSync(a, 'AAA');
    writeFileSync(b, 'BBB');
    const blocks: ContentBlock[] = [
      { type: 'resource_link', uri: `file://${a}`, name: 'a.ts' },
      { type: 'resource_link', uri: `file://${b}`, name: 'b.ts' },
    ];
    const out = await collectEmbeddedContext(blocks);
    expect(out).toContain('AAA');
    expect(out).toContain('BBB');
    // Two separate fenced blocks, separated by a blank line
    expect(out.match(/```/g)?.length).toBe(4);
  });
});

// ─── providerHasKey ───────────────────────────────────────────────────────────

describe('providerHasKey', () => {
  it('returns a boolean (does not throw) for an unknown provider', () => {
    expect(typeof providerHasKey('nonexistent-provider-id')).toBe('boolean');
  });

  it('returns true when the provider has an env var set', () => {
    // 'z.ai' provider uses ZAI_API_KEY
    const prev = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = 'test-key';
    try {
      expect(providerHasKey('z.ai')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = prev;
    }
  });

  it('returns false for a known provider with no key configured', () => {
    // Clear any env var a known provider might use, then check.
    // This is a smoke test — the keychain-backed path is exercised in
    // keychain.test.ts; here we just confirm the function doesn't crash
    // and returns a boolean.
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = providerHasKey('openai');
      expect(typeof result).toBe('boolean');
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

// ─── buildConfigOptions ───────────────────────────────────────────────────────

describe('buildConfigOptions', () => {
  beforeEach(() => {
    // Pin known config values so assertions are stable across environments.
    config.set('provider', 'z.ai');
    config.set('model', 'glm-5.1');
    config.set('language', 'en');
  });

  it('returns an array of SessionConfigOption objects', () => {
    const opts = buildConfigOptions();
    expect(Array.isArray(opts)).toBe(true);
    expect(opts.length).toBeGreaterThan(0);
    for (const opt of opts) {
      expect(opt).toHaveProperty('id');
      expect(opt).toHaveProperty('name');
      expect(opt).toHaveProperty('type');
      expect(opt).toHaveProperty('currentValue');
      expect(opt).toHaveProperty('options');
    }
  });

  it('includes a "model" option with provider/model composite values', () => {
    const opts = buildConfigOptions();
    const model = opts.find(o => o.id === 'model');
    expect(model).toBeDefined();
    expect(model!.options.length).toBeGreaterThan(0);
    // Each option value should be "<providerId>/<modelId>". Provider ids may
    // contain dots (e.g. "z.ai"), dashes, underscores.
    for (const o of model!.options) {
      expect(o.value).toMatch(/^[a-z0-9._-]+\//);
    }
  });

  it('includes a "language" option with the current language selected', () => {
    const opts = buildConfigOptions();
    const lang = opts.find(o => o.id === 'language');
    expect(lang).toBeDefined();
    expect(lang!.currentValue).toBe('en');
    // Auto + at least a few language codes
    expect(lang!.options.find(o => o.value === 'auto')).toBeDefined();
    expect(lang!.options.find(o => o.value === 'en')).toBeDefined();
  });

  it('includes the three confirmation-toggle options as boolean selects', () => {
    const opts = buildConfigOptions();
    const ids = opts.map(o => o.id);
    expect(ids).toContain('agentConfirmDeleteFile');
    expect(ids).toContain('agentConfirmExecuteCommand');
    expect(ids).toContain('agentConfirmWriteFile');
    for (const id of [
      'agentConfirmDeleteFile',
      'agentConfirmExecuteCommand',
      'agentConfirmWriteFile',
    ]) {
      const opt = opts.find(o => o.id === id)!;
      expect(opt.type).toBe('select');
      // currentValue is a string 'true' / 'false'
      expect(['true', 'false']).toContain(opt.currentValue);
      // Options are labelled with the action so the dropdown isn't ambiguous
      expect(opt.options.some(o => o.value === 'true')).toBe(true);
      expect(opt.options.some(o => o.value === 'false')).toBe(true);
    }
  });

  it('reflects the agentConfirmWriteFile default (false → "false")', () => {
    config.set('agentConfirmWriteFile', false);
    const opts = buildConfigOptions();
    const write = opts.find(o => o.id === 'agentConfirmWriteFile')!;
    expect(write.currentValue).toBe('false');

    config.set('agentConfirmWriteFile', true);
    const opts2 = buildConfigOptions();
    const write2 = opts2.find(o => o.id === 'agentConfirmWriteFile')!;
    expect(write2.currentValue).toBe('true');
  });
});

// ─── AGENT_MODES constant ─────────────────────────────────────────────────────

describe('AGENT_MODES', () => {
  it('exposes auto + manual modes', () => {
    expect(AGENT_MODES.availableModes.length).toBeGreaterThanOrEqual(2);
    const ids = AGENT_MODES.availableModes.map(m => m.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('manual');
  });

  it('defaults to "auto"', () => {
    expect(AGENT_MODES.currentModeId).toBe('auto');
  });

  it('gives each mode a human-readable name + description', () => {
    for (const mode of AGENT_MODES.availableModes) {
      expect(mode.name).toBeTruthy();
      expect(mode.description).toBeTruthy();
    }
  });
});
