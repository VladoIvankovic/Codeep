import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  beginAuditRun, endAuditRun, recordAuditEvent, readAuditRuns, describeAuditTarget,
} from './auditLog';

let root: string;
const auditDir = () => join(root, '.codeep', 'audit');
const rawLines = () =>
  readdirSync(auditDir())
    .flatMap(f => readFileSync(join(auditDir(), f), 'utf8').split('\n'))
    .filter(Boolean);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codeep-audit-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('audit run round-trip', () => {
  it('records a run with its agent and the capabilities it was granted', () => {
    const run = beginAuditRun(root, {
      prompt: 'tidy the imports',
      agent: 'Reviewer',
      capabilities: ['files', 'tests'],
    });
    endAuditRun(root, run, 'ok');

    const [entry] = readAuditRuns(root);
    expect(entry.run).toBe(run);
    expect(entry.prompt).toBe('tidy the imports');
    expect(entry.agent).toBe('Reviewer');
    expect(entry.capabilities).toEqual(['files', 'tests']);
    expect(entry.outcome).toBe('ok');
  });

  it('counts refusals separately — the entry the boundary exists to produce', () => {
    const run = beginAuditRun(root, { prompt: 'read secrets' });
    recordAuditEvent(root, { ts: Date.now(), run, tool: 'read_file', action: 'refused', outcome: 'refused', target: 'secrets.env' });
    recordAuditEvent(root, { ts: Date.now(), run, tool: 'execute_command', action: 'command', outcome: 'ok', target: 'git log' });
    endAuditRun(root, run, 'ok');

    const [entry] = readAuditRuns(root);
    expect(entry.refusals).toBe(1);
    expect(entry.events).toHaveLength(2);
  });

  it('closes the run even when it failed, and says so', () => {
    const run = beginAuditRun(root, { prompt: 'break something' });
    endAuditRun(root, run, 'error', 'provider timed out');
    const [entry] = readAuditRuns(root);
    expect(entry.outcome).toBe('error');
  });

  it('returns runs newest first', () => {
    const older = beginAuditRun(root, { prompt: 'first' });
    endAuditRun(root, older, 'ok');
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const newer = beginAuditRun(root, { prompt: 'second' });
    endAuditRun(root, newer, 'ok');
    vi.useRealTimers();

    expect(readAuditRuns(root).map(r => r.prompt)).toEqual(['second', 'first']);
  });
});

describe('what must never reach the record', () => {
  // The record exists to say what was touched. history.ts is the thing that
  // keeps contents, because it has to put them back.
  it('describeAuditTarget never reads content-bearing arguments', () => {
    const target = describeAuditTarget({
      tool: 'write_file',
      parameters: { path: 'src/app.ts', content: 'SUPER SECRET BODY', old_string: 'ALSO SECRET' },
    });
    expect(target).toBe('src/app.ts');
    expect(target).not.toContain('SECRET');
  });

  it('keeps a command and its arguments, which are the point', () => {
    expect(describeAuditTarget({ tool: 'execute_command', parameters: { command: 'git', args: ['log', '-5'] } }))
      .toBe('git log -5');
  });

  // An MCP tool's arguments are its only account of what it will do, and the
  // permission prompt shows this line: `postgres__query` alone says nothing.
  it('shows what an MCP tool call is aimed at', () => {
    expect(describeAuditTarget({ tool: 'postgres__query', parameters: { sql: 'DELETE FROM users\nWHERE id = 5' } }))
      .toBe('sql=DELETE FROM users WHERE id = 5');
    expect(describeAuditTarget({ tool: 'github__create_issue', parameters: { owner: 'me', repo: 'r', labels: ['bug'], draft: false } }))
      .toBe('owner=me, repo=r, labels=bug, draft=false');
    // An exec tool's argument list is what it will run.
    expect(describeAuditTarget({ tool: 'shell__exec', parameters: { command: 'rm', args: ['-rf', '/Users/me'], timeout: 30 } }))
      .toBe('command=rm, args=-rf /Users/me, timeout=30');
  });

  // Lists and objects are where MCP servers keep file bodies under names of
  // their own, so the record counts them and never prints them.
  it('never prints a file body or a secret nested in an MCP argument', () => {
    const edit = describeAuditTarget({
      tool: 'filesystem__edit_file',
      parameters: {
        path: 'src/config.ts',
        edits: [
          { oldText: 'const API_KEY = "sk-live-abc123"', newText: 'const API_KEY = process.env.KEY' },
          { oldText: 'a', newText: 'b' },
        ],
        options: { dryRun: false },
      },
    });
    expect(edit).toBe('path=src/config.ts, edits=[2 items], options={1 key}');

    const push = describeAuditTarget({
      tool: 'github__push_files',
      parameters: {
        owner: 'acme', repo: 'r', branch: 'main',
        files: [{ path: '.env', content: 'STRIPE_SECRET=sk_live_zzz' }],
        message: 'm',
      },
    });
    expect(push).toBe('owner=acme, repo=r, branch=main, files=[1 item], message=m');

    const deep = describeAuditTarget({
      tool: 'x__y',
      parameters: { a: [[{ b: { content: 'BODY' } }]], c: { d: ['PASSWORD=hunter2'] } },
    });
    expect(deep).toBe('a=[1 item], c={1 key}');
    for (const target of [edit, push, deep]) {
      expect(target).not.toMatch(/sk[-_]live|STRIPE|BODY|hunter2|process\.env/);
    }
  });

  it('leaves out file bodies however the server spells the argument', () => {
    const target = describeAuditTarget({
      tool: 'fs__write',
      parameters: {
        path: 'a.ts', fileContent: 'BODY1', oldString: 'BODY2', NEW_TEXT: 'BODY3', 'new-text': 'BODY4',
        old_str: 'BODY5', new_str: 'BODY6', file_text: 'BODY7', newContent: 'BODY8', replacement: 'BODY9', body: 'BODY10',
      },
    });
    expect(target).toBe('path=a.ts');
  });

  it('redacts credentials in MCP arguments, by name or by shape', () => {
    const target = describeAuditTarget({
      tool: 'svc__login',
      parameters: {
        user: 'me',
        password: 'hunter2',
        apiKey: 'plainvalue',
        access_token: 'abc',
        max_tokens: 1000,
        note: 'use sk-live-abc123 please',
        header: 'Bearer abcdefghijklmnopqrstuvwxyz',
        gh: 'ghp_' + 'a'.repeat(36),
        aws: 'AKIA' + 'B'.repeat(16),
        key: '-----BEGIN OPENSSH PRIVATE KEY-----',
      },
    });
    expect(target).toBe(
      'user=me, password=[redacted], apiKey=[redacted], access_token=[redacted], max_tokens=1000, '
      + 'note=use [redacted] please, header=[redacted], gh=[redacted], aws=[redacted], key=[redacted]',
    );
    expect(describeAuditTarget({ tool: 'postgres__query', parameters: { sql: 'SELECT id FROM tokens_seen' } }))
      .toBe('sql=SELECT id FROM tokens_seen');
  });

  it('leaves file bodies out of an MCP tool call too, and says what it cut from a huge argument', () => {
    const target = describeAuditTarget({
      tool: 'filesystem__write_file',
      parameters: { path: 'notes.md', content: 'SUPER SECRET BODY', note: 'y'.repeat(3000) },
    });
    expect(target).not.toContain('SECRET');
    expect(target).toBe(`path=notes.md, note=${'y'.repeat(2000)}…[+1000 chars]`);
    // An ordinary long statement is shown whole: its end (a WHERE clause) matters.
    const sql = `UPDATE accounts SET balance = 0 WHERE ${'id <> 1 AND '.repeat(20)}owner = 'me'`;
    expect(describeAuditTarget({ tool: 'pg__query', parameters: { sql } })).toBe(`sql=${sql}`);
  });

  it('replaces only the credential in a value, so the rest of a command stays visible', () => {
    // Hiding the whole value would let a model hide what it runs by adding a fake key.
    const target = describeAuditTarget({
      tool: 'pg__query',
      parameters: { sql: 'DROP TABLE users; -- sk_live_abcdef123456 ghp_' + 'Z'.repeat(36) + ' end' },
    });
    expect(target).toBe('sql=DROP TABLE users; -- [redacted] [redacted] end');
    const pem = describeAuditTarget({
      tool: 'x__y',
      parameters: { cmd: 'install -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY----- done' },
    });
    expect(pem).toBe('cmd=install [redacted] done');
    expect(pem).not.toContain('MIIE');
  });

  it('judges credential names by their words', () => {
    const target = describeAuditTarget({
      tool: 'api__list',
      parameters: {
        page_token: 'CURSOR1', nextToken: 'CURSOR2', max_tokens: '4096', tokenizer: 'cl100k',
        access_token: 'S1', botToken: 'S2', api_token: 'S3', 'AUTH-TOKENS': ['S4', 'S5'], clientSecret: 'S6',
      },
    });
    expect(target).toBe(
      'page_token=CURSOR1, nextToken=CURSOR2, max_tokens=4096, tokenizer=cl100k, access_token=[redacted], '
      + 'botToken=[redacted], api_token=[redacted], AUTH-TOKENS=[redacted], clientSecret=[redacted]',
    );
  });

  it('names an MCP tool called without arguments', () => {
    expect(describeAuditTarget({ tool: 'time__now', parameters: {} })).toBe('time__now');
  });

  it('truncates a long target rather than writing an unbounded line', () => {
    const run = beginAuditRun(root, { prompt: 'x' });
    recordAuditEvent(root, { ts: Date.now(), run, action: 'read', target: 'a'.repeat(5000) });
    const longest = Math.max(...rawLines().map(l => l.length));
    expect(longest).toBeLessThan(1000);
  });
});

describe('the record says what it is', () => {
  // The module docstring used to claim the directory was git-ignored by
  // default. It is not — Codeep never edits a project's .gitignore. A comment
  // that promises a protection nobody implements is worse than no comment.
  it('does not claim to git-ignore anything', () => {
    const source = readFileSync(new URL('./auditLog.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/git-ignored by default/);
    expect(source).toMatch(/Codeep does\s+\*?\s*not edit anyone's `\.gitignore`/);
  });
});

describe('robustness', () => {
  it('survives a torn final line — an append-only log killed mid-write', () => {
    const run = beginAuditRun(root, { prompt: 'interrupted' });
    endAuditRun(root, run, 'ok');
    const file = join(auditDir(), readdirSync(auditDir())[0]);
    writeFileSync(file, readFileSync(file, 'utf8') + '{"run":"torn","ts":');

    const runs = readAuditRuns(root);
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe('interrupted');
  });

  it('returns nothing rather than throwing when no audit directory exists', () => {
    expect(readAuditRuns(join(root, 'nowhere'))).toEqual([]);
  });

  it('does not throw when the project cannot be written to', () => {
    // A file where a directory needs to be: mkdir under it fails with ENOTDIR
    // on every platform. The previous version used a /proc path, which only
    // means anything on Linux, and mocked process.cwd() — which vitest, vite
    // and module resolution all call, and which hung a CI runner for twenty
    // minutes. The spy was never needed: the path is passed in explicitly.
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'this is a file');

    expect(() => recordAuditEvent(blocker, {
      ts: Date.now(), run: 'r', action: 'read', target: 'x',
    })).not.toThrow();
  });
});
