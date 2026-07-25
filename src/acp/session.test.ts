/**
 * Unit tests for the ACP session bridge.
 *
 * `runAgentSession` itself orchestrates the agent loop and is too heavy to
 * unit-test without mocking half the codebase. These tests focus on the
 * three pure helpers it depends on:
 *
 *   - `buildProjectContext` — synthesises a minimal context when scanning
 *     fails, so runAgent never sees null.
 *   - `toolCallMeta` — maps internal tool names to the ACP `kind`/`title`
 *     the editor renders. Drives the tool-call cards in Zed/VS Code, so a
 *     wrong kind here means a wrong icon there.
 *   - `buildRawOutput` — produces the inline content shown inside a tool
 *     call card (the diff for edits, stdout for commands, the error text
 *     on failure).
 *
 * Together they cover the data-shaping surface of session.ts; the agent
 * loop integration is exercised end-to-end by the smoke test in
 * `toolExecution.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildProjectContext,
  toolCallMeta,
  buildRawOutput,
} from './session';

const ROOT = '/repo';

describe('buildProjectContext', () => {
  it('returns a non-null context with at least root + name + type', () => {
    const ctx = buildProjectContext(ROOT);
    expect(ctx).toBeTruthy();
    expect(ctx.root).toBe(ROOT);
    expect(typeof ctx.name).toBe('string');
    expect(ctx.name.length).toBeGreaterThan(0);
    expect(typeof ctx.type).toBe('string');
  });

  it('root is always the workspace path passed in (even when scanning finds a project)', () => {
    // `root` is the deterministic contract — `summary`/`name` are best-effort
    // descriptions and may evolve. Tests should rely on `root` for grounding.
    expect(buildProjectContext('/var/empty/some-deep-name').root)
      .toBe('/var/empty/some-deep-name');
    expect(buildProjectContext(ROOT).root).toBe(ROOT);
  });

  it('summary is a non-empty human-readable string', () => {
    const ctx = buildProjectContext(ROOT);
    expect(typeof ctx.summary).toBe('string');
    expect(ctx.summary.length).toBeGreaterThan(0);
  });

  it('keyFiles is always an array (possibly empty), never null', () => {
    const ctx = buildProjectContext(ROOT);
    expect(Array.isArray(ctx.keyFiles)).toBe(true);
  });
});

describe('toolCallMeta — kind mapping', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['read_file',        { path: 'a.ts' },                'read'],
    ['write_file',       { path: 'a.ts' },                'edit'],
    ['edit_file',        { path: 'a.ts' },                'edit'],
    ['delete_file',      { path: 'a.ts' },                'delete'],
    ['move_file',        { path: 'a.ts' },                'move'],
    ['list_files',       { path: 'src' },                 'read'],
    ['create_directory', { path: 'src/x' },               'edit'],
    ['search_code',      { pattern: 'TODO' },             'search'],
    ['find_files',       { pattern: '*.ts' },             'search'],
    ['execute_command',  { command: 'npm test' },         'execute'],
    ['fetch_url',        { url: 'https://x' },            'fetch'],
    ['web_search',       { query: 'q' },                  'fetch'],
    ['web_read',         { url: 'https://x' },            'fetch'],
    ['unknown_tool',     {},                              'other'],
  ];

  for (const [tool, params, expectedKind] of cases) {
    it(`${tool} → kind "${expectedKind}"`, () => {
      expect(toolCallMeta(tool, params, ROOT).kind).toBe(expectedKind);
    });
  }
});

describe('toolCallMeta — title', () => {
  it('uses basename for read/edit/delete, not the full path', () => {
    expect(toolCallMeta('read_file', { path: 'src/deep/file.ts' }, ROOT).title)
      .toBe('Reading file.ts');
    expect(toolCallMeta('delete_file', { path: 'a.txt' }, ROOT).title)
      .toBe('Deleting a.txt');
  });

  it('uses absolute path for edit_file so editors render a clickable link', () => {
    const title = toolCallMeta('edit_file', { path: 'src/a.ts' }, ROOT).title;
    expect(title).toContain('/repo/src/a.ts');
  });

  it('honours an already-absolute path verbatim', () => {
    const abs = '/abs/path/x.ts';
    expect(toolCallMeta('edit_file', { path: abs }, ROOT).title).toContain(abs);
  });

  it('falls back to "files" when list_files has no path', () => {
    expect(toolCallMeta('list_files', {}, ROOT).title).toBe('Listing files');
  });

  it('exposes the raw command string in execute_command title', () => {
    expect(toolCallMeta('execute_command', { command: 'npm run build' }, ROOT).title)
      .toBe('npm run build');
  });

  it('exposes the search pattern/query in fetch/search titles', () => {
    expect(toolCallMeta('search_code', { pattern: 'TODO' }, ROOT).title).toBe('Searching TODO');
    expect(toolCallMeta('web_search',  { query:   'vite' }, ROOT).title).toBe('Searching vite');
    expect(toolCallMeta('fetch_url',   { url: 'https://x' }, ROOT).title).toBe('Fetching https://x');
  });

  it('unknown tools fall back to the tool name as the title', () => {
    expect(toolCallMeta('weird_thing', {}, ROOT).title).toBe('weird_thing');
  });
});

describe('buildRawOutput — success cases', () => {
  it('write_file returns the content verbatim', () => {
    const out = buildRawOutput('write_file', { content: 'hello()\n' }, { success: true, output: '' });
    expect(out).toBe('hello()\n');
  });

  it('write_file returns undefined when content is empty', () => {
    expect(buildRawOutput('write_file', { content: '' }, { success: true, output: '' })).toBeUndefined();
  });

  it('edit_file returns a -/+ diff of old vs new text', () => {
    const out = buildRawOutput(
      'edit_file',
      { old_text: 'a\nb', new_text: 'a\nB' },
      { success: true, output: '' },
    );
    expect(out).toContain('- a');
    expect(out).toContain('- b');
    expect(out).toContain('+ a');
    expect(out).toContain('+ B');
  });

  it('edit_file returns undefined when both old and new are empty', () => {
    expect(buildRawOutput('edit_file', { old_text: '', new_text: '' }, { success: true, output: '' }))
      .toBeUndefined();
  });

  it('execute_command surfaces captured stdout', () => {
    expect(buildRawOutput('execute_command', {}, { success: true, output: 'ok\n' }))
      .toBe('ok\n');
  });

  it('execute_command falls back to error text when stdout is empty', () => {
    expect(buildRawOutput('execute_command', {}, { success: true, output: '', error: 'oops' }))
      .toBe('oops');
  });

  it('read_file surfaces the file content from output', () => {
    expect(buildRawOutput('read_file', {}, { success: true, output: 'file body' }))
      .toBe('file body');
  });

  it('other tools return undefined on success', () => {
    expect(buildRawOutput('search_code', {}, { success: true, output: 'matches' }))
      .toBeUndefined();
  });
});

describe('buildRawOutput — error cases', () => {
  it('always surfaces the error field on failure, regardless of tool', () => {
    const result = { success: false, output: '', error: 'Permission denied' };
    for (const tool of ['write_file', 'execute_command', 'read_file', 'unknown']) {
      expect(buildRawOutput(tool, {}, result)).toBe('Error: Permission denied');
    }
  });

  it('returns undefined on failure when no error string is present', () => {
    expect(buildRawOutput('write_file', {}, { success: false, output: '', error: undefined }))
      .toBeUndefined();
  });
});

// ─── Mention expansion (smoke — confirms ACP uses the same expanders) ─────────
//
// `runAgentSession` imports `expandFileAndFolderMentions`,
// `expandGitMentions`, and `expandWebMentions` dynamically. Rather than
// mock the entire agent loop, we verify the expanders themselves resolve
// `@file` / `@git` tokens — proving the ACP path inherits the same UX.
import { expandFileAndFolderMentions, expandGitMentions } from '../utils/mentions';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ACP mention expansion (parity with TUI)', () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'codeep-acp-mention-'));
    writeFileSync(join(tmpRoot, 'hello.ts'), 'export const x = 1;\n');
  });
  afterAll(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it('expands @file mentions (ACP inherits TUI behavior)', () => {
    const r = expandFileAndFolderMentions('review @hello.ts', { root: tmpRoot });
    expect(r.loaded.length).toBe(1);
    expect(r.enrichedPrompt).toContain('export const x');
  });

  it('expands @git mentions in a git repo (ACP inherits TUI behavior)', async () => {
    // Only exercise the pure extraction path; full git resolution is
    // covered by git.test.ts. Here we confirm the same entry point exists.
    const gitResult = await expandGitMentions('@git HEAD', { root: tmpRoot });
    // tmpRoot may not be a git repo — that's fine; we only assert the
    // function runs and returns a structured result.
    expect(typeof gitResult.enrichedPrompt).toBe('string');
    expect(Array.isArray(gitResult.failures)).toBe(true);
  });
});
