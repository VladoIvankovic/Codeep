import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Loading main.ts must not shell out to git: `--version`, `--help` and
// `account` all import this module and would otherwise pay for 3–4 git
// subprocesses they never use.
vi.mock('../utils/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git')>();
  return { ...actual, getGitStatus: vi.fn(actual.getGitStatus) };
});

// Starting MCP servers must not spawn anything here; the registration is
// what the tests read.
vi.mock('../utils/mcpRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/mcpRegistry')>()),
  registerSessionServers: vi.fn(async () => ({ registered: [], errors: [] })),
}));

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveSessionName, startTuiMcpServers, startTrustedWorkspaceMcp } from './main';
import { getGitStatus } from '../utils/git';
import { registerSessionServers } from '../utils/mcpRegistry';
import { trustWorkspaceMcp } from '../utils/mcpConfig';

// Comment-stripped: a plain text match happily finds `// reportTurnStats(true)`
// and would pass against the very bug these guards exist to catch.
const mainSource = readFileSync('src/renderer/main.ts', 'utf-8')
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .join('\n');

describe('module load', () => {
  it('does not resolve the git branch at import time', () => {
    expect(getGitStatus).not.toHaveBeenCalled();
  });
});

// handleSubmit is not exported and mocking the whole chat pipeline to reach it
// would be brittle, so these guard the wiring at source level. Narrow on
// purpose: reportTurnStats once shipped DEFINED BUT NEVER CALLED — the success
// path kept an inline duplicate and the catch path reported nothing at all, so
// tokens burned by an aborted turn reached no one. tsc stayed silent because
// noUnusedLocals is off.
describe('cloud stats wiring', () => {
  it('calls reportTurnStats, rather than only defining it', () => {
    expect(mainSource).toMatch(/const reportTurnStats = /);
    expect(mainSource).toMatch(/\breportTurnStats\(true\)/);
  });

  it('reports the delta from the catch path too', () => {
    // An aborted or failed turn still burned tokens, and gracefulShutdown no
    // longer sends a cumulative catch-all that would sweep them up later.
    const catchBlock = mainSource.slice(mainSource.indexOf('} catch (error) {'));
    expect(catchBlock).toMatch(/\breportTurnStats\(false\)/);
  });

  it('keeps one reporting implementation, not an inline copy beside it', () => {
    // The inline duplicate is what silently kept working while the helper rotted.
    expect(mainSource.match(/getCostBreakdown\(tokenReportStart\)/g) ?? []).toHaveLength(1);
  });
});

/** Body of a top-level function or handler in mainSource, up to the next
 *  top-level statement. */
function sliceFrom(marker: string): string {
  const start = mainSource.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const end = mainSource.indexOf('\n}', start);
  return mainSource.slice(start, end);
}

describe('session identity wiring', () => {
  it('keeps the config copy of the session id in step whenever the terminal switches', () => {
    // /sessions, /recall --resume and the startup picker all load an older
    // conversation. Autosave used to follow config.currentSessionId, which
    // still named the previous one, and saved the loaded history over it.
    expect(sliceFrom('function setSessionId(')).toMatch(/config\.set\('currentSessionId', id\)/);
    expect(mainSource).toMatch(/^\s*setSessionId,$/m);
    expect(sliceFrom('function showSessionPickerInline(')).toMatch(/setSessionId\(selectedName\)/);
    expect(mainSource).not.toMatch(/(^|[^.\w])sessionId = selectedName/);
  });

  it('lets a finishing agent run see which conversation is on screen now', () => {
    // A run can end after /new or /sessions; it must not save the new
    // conversation's messages under its own id.
    expect(sliceFrom('function makeCtx(')).toMatch(/getSessionId: \(\) => sessionId,/);
  });

  it('names the conversation on every autosave', () => {
    const calls = mainSource.split('\n').filter(line => line.includes('autoSaveSession('));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/, sessionId\);/);
  });
});

describe('startTuiMcpServers', () => {
  let home: string;
  let workspace: string;
  const savedHome = process.env.HOME;
  const ui = { notify: vi.fn(), notifyWarn: vi.fn() };

  const writeServers = (dir: string, name: string) => {
    mkdirSync(join(dir, '.codeep'), { recursive: true });
    writeFileSync(join(dir, '.codeep', 'mcp_servers.json'),
      JSON.stringify({ mcpServers: { [name]: { command: `${name}-cmd` } } }));
  };
  const registeredNames = () => vi.mocked(registerSessionServers).mock.calls
    .map(([session, servers]) => [session, servers.map(s => s.name)]);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeep-mcp-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'codeep-mcp-ws-'));
    process.env.HOME = home;
    writeServers(home, 'global-server');
    writeServers(workspace, 'workspace-server');
    vi.mocked(registerSessionServers).mockClear();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('starts the global and workspace servers together in a trusted workspace', async () => {
    // Registering replaces the whole set: two calls left only the second list running.
    trustWorkspaceMcp(workspace);

    expect(await startTuiMcpServers(workspace, ui)).toEqual([]);
    expect(registeredNames()).toEqual([['codeep-tui', ['global-server', 'workspace-server']]]);
  });

  it('starts only the global servers until the workspace is trusted', async () => {
    const waiting = await startTuiMcpServers(workspace, ui);

    expect(waiting.map(s => s.name)).toEqual(['workspace-server']);
    expect(registeredNames()).toEqual([['codeep-tui', ['global-server']]]);

    // Trusting it afterwards keeps the global servers in the set.
    trustWorkspaceMcp(workspace);
    await startTuiMcpServers(workspace, ui);
    expect(registeredNames()[1]).toEqual(['codeep-tui', ['global-server', 'workspace-server']]);
  });

  it('shows why the servers of a just-trusted workspace did not start', async () => {
    trustWorkspaceMcp(workspace);
    ui.notifyWarn.mockClear();
    vi.mocked(registerSessionServers).mockRejectedValueOnce(new Error('spawn EACCES'));

    await expect(startTrustedWorkspaceMcp(workspace, ui)).resolves.toBeUndefined();
    expect(ui.notifyWarn).toHaveBeenCalledWith('MCP: could not start workspace servers: spawn EACCES');
  });

  it('is what the trust prompt runs once the user accepts', () => {
    const start = mainSource.indexOf("title: 'Trust workspace MCP servers?'");
    const onConfirm = mainSource.slice(start, mainSource.indexOf('onCancel:', start));
    expect(onConfirm).toMatch(/startTrustedWorkspaceMcp\(projectPath, app\)/);
    expect(onConfirm).not.toMatch(/\.catch\(\(\) =>/);
  });
});

describe('exit paths', () => {
  it('writes the pending save before the exit-time cloud sync', () => {
    // autoSaveSession only arms a 5-second timer, and the process exits as
    // soon as gracefulShutdown settles.
    const body = sliceFrom('async function gracefulShutdown(');
    const flush = body.indexOf('flushAutoSave()');
    expect(flush).toBeGreaterThan(body.indexOf('autoSaveSession('));
    expect(flush).toBeLessThan(body.indexOf('syncSessionAsync('));
    expect(body).not.toMatch(/\brequire\(/);
  });

  it('writes the pending save before exiting on a crash', () => {
    const body = sliceFrom("process.on('uncaughtException'");
    const flush = body.indexOf('flushAutoSave()');
    expect(flush).toBeGreaterThan(body.indexOf('autoSaveSession('));
    expect(flush).toBeLessThan(body.indexOf('process.exit(1)'));
  });
});

describe('deriveSessionName', () => {
  it('returns an empty string for blank input', () => {
    expect(deriveSessionName('')).toBe('');
    expect(deriveSessionName('   ')).toBe('');
  });

  it('keeps a short single-line message as-is', () => {
    expect(deriveSessionName('hello world')).toBe('hello world');
  });

  it('collapses runs of whitespace into single spaces', () => {
    expect(deriveSessionName('a\t\tb\n\nc')).toBe('a b c');
  });

  it('trims leading and trailing whitespace before deriving', () => {
    expect(deriveSessionName('   hi there   ')).toBe('hi there');
  });

  it('keeps at most the first five words', () => {
    const out = deriveSessionName('one two three four five six seven');
    expect(out).toBe('one two three four five');
  });

  it('keeps fewer than five words when the message is short', () => {
    expect(deriveSessionName('a b')).toBe('a b');
  });

  it('truncates to 45 chars + ellipsis when the first five words exceed 48', () => {
    // Build a message whose first 5 words total > 48 chars so truncation
    // kicks in. 5 words of 11 chars each, joined by spaces: 5*11 + 4 = 59.
    const long = ['abcdefghijk', 'abcdefghijk', 'abcdefghijk', 'abcdefghijk', 'abcdefghijk'].join(' ');
    expect(long.length).toBeGreaterThan(48);
    const out = deriveSessionName(long);
    expect(out.length).toBe(46); // 45 + …
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate when exactly at the 48-char boundary', () => {
    const words = 'word '.repeat(5).trim(); // "word word word word word" (24 chars)
    expect(deriveSessionName(words)).toBe(words);
  });

  it('keeps punctuation that is part of a word', () => {
    expect(deriveSessionName('fix bug #123')).toBe('fix bug #123');
  });

  it('combines collapse, trim, word-cap, and truncation', () => {
    // 6 long words, with extra whitespace — expect first 5, collapsed,
    // then truncated to 45 + ellipsis.
    const long = '  ' + Array.from({ length: 6 }, () => 'abcdefghij').join('   ');
    const out = deriveSessionName(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(46);
    expect(out).not.toContain('  '); // no double spaces
  });
});
