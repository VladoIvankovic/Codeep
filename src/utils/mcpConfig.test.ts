import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect homedir() before mcpConfig is imported so the global config
// path resolves to our fixture, not the user's real ~/.codeep.
// Uses vi.hoisted so the value is wired up before mcpConfig binds its
// `import { homedir } from 'os'` reference.
const { fakeHomeRef } = vi.hoisted(() => ({ fakeHomeRef: { current: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => fakeHomeRef.current || actual.homedir(),
  };
});

import {
  loadMcpServerConfig,
  mergeMcpServers,
  addProjectMcpServer,
  removeProjectMcpServer,
} from './mcpConfig';
import type { McpServer } from '../acp/protocol';

let workspaceRoot: string;
let fakeHome: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codeep-mcp-cfg-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'codeep-mcp-home-'));
  fakeHomeRef.current = fakeHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  fakeHomeRef.current = '';
});

function writeProjectConfig(content: string) {
  const dir = join(workspaceRoot, '.codeep');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp_servers.json'), content);
}

function writeGlobalConfig(content: string) {
  const dir = join(fakeHome, '.codeep');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp_servers.json'), content);
}

describe('loadMcpServerConfig', () => {
  it('returns empty array when no config file exists', () => {
    expect(loadMcpServerConfig(workspaceRoot)).toEqual([]);
  });

  it('parses Claude Code-style map form', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/x'] },
        gh: { command: 'gh-mcp', args: [], env: { GH_TOKEN: 'tok' } },
      },
    }));
    const servers = loadMcpServerConfig(workspaceRoot);
    expect(servers).toHaveLength(2);
    const fs = servers.find(s => s.name === 'fs')!;
    expect(fs.command).toBe('npx');
    expect(fs.args).toEqual(['@modelcontextprotocol/server-filesystem', '/x']);
    const gh = servers.find(s => s.name === 'gh')!;
    expect(gh.env).toEqual({ GH_TOKEN: 'tok' });
  });

  it('parses ACP-style flat array form', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: [
        { name: 'fs', command: 'a', args: [] },
        { name: 'gh', command: 'b', args: [] },
      ],
    }));
    expect(loadMcpServerConfig(workspaceRoot).map(s => s.name).sort()).toEqual(['fs', 'gh']);
  });

  it('project entries shadow global entries with the same name', () => {
    writeGlobalConfig(JSON.stringify({
      mcpServers: { fs: { command: 'global-fs', args: [] }, gh: { command: 'global-gh', args: [] } },
    }));
    writeProjectConfig(JSON.stringify({
      mcpServers: { fs: { command: 'project-fs', args: [] } },
    }));
    const servers = loadMcpServerConfig(workspaceRoot);
    expect(servers.find(s => s.name === 'fs')?.command).toBe('project-fs');
    expect(servers.find(s => s.name === 'gh')?.command).toBe('global-gh');
  });

  it('returns global-only when no workspaceRoot is given (TUI without project)', () => {
    writeGlobalConfig(JSON.stringify({
      mcpServers: { fs: { command: 'global-fs', args: [] } },
    }));
    const servers = loadMcpServerConfig();
    expect(servers).toEqual([{ name: 'fs', command: 'global-fs', args: [] }]);
  });

  it('returns empty when JSON is corrupt (does not throw)', () => {
    writeProjectConfig('{ not valid json');
    // Suppress the stderr warning printed by the parser.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(loadMcpServerConfig(workspaceRoot)).toEqual([]);
    stderrSpy.mockRestore();
  });

  it('drops entries missing command (defensive)', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: {
        good: { command: 'ok', args: [] },
        bad: { args: [] },               // no command
      },
    }));
    expect(loadMcpServerConfig(workspaceRoot).map(s => s.name)).toEqual(['good']);
  });

  it('coerces non-string args to empty list', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: { fs: { command: 'x', args: 'not-an-array' } },
    }));
    expect(loadMcpServerConfig(workspaceRoot)[0].args).toEqual([]);
  });
});

describe('mergeMcpServers', () => {
  const a: McpServer = { name: 'a', command: 'aa', args: [] };
  const b: McpServer = { name: 'b', command: 'bb', args: [] };
  const aPrime: McpServer = { name: 'a', command: 'AA-overridden', args: [] };

  it('returns combined list when there are no collisions', () => {
    expect(mergeMcpServers([a], [b])).toEqual([a, b]);
  });

  it('ACP-provided entries override file entries with the same name', () => {
    const merged = mergeMcpServers([a], [aPrime]);
    expect(merged).toHaveLength(1);
    expect(merged[0].command).toBe('AA-overridden');
  });

  it('handles undefined ACP list', () => {
    expect(mergeMcpServers([a], undefined)).toEqual([a]);
  });
});

describe('addProjectMcpServer', () => {
  it('creates the config file if missing', () => {
    addProjectMcpServer(workspaceRoot, { name: 'fs', command: 'npx', args: ['filesystem'] });
    const path = join(workspaceRoot, '.codeep', 'mcp_servers.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.mcpServers.fs.command).toBe('npx');
    expect(parsed.mcpServers.fs.args).toEqual(['filesystem']);
  });

  it('replaces an existing entry with the same name', () => {
    addProjectMcpServer(workspaceRoot, { name: 'fs', command: 'old', args: [] });
    addProjectMcpServer(workspaceRoot, { name: 'fs', command: 'new', args: [] });
    const parsed = JSON.parse(readFileSync(join(workspaceRoot, '.codeep', 'mcp_servers.json'), 'utf-8'));
    expect(parsed.mcpServers.fs.command).toBe('new');
  });

  it('migrates an array-form file to map form on add', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: [{ name: 'existing', command: 'old', args: [] }],
    }));
    addProjectMcpServer(workspaceRoot, { name: 'new', command: 'nw', args: [] });
    const parsed = JSON.parse(readFileSync(join(workspaceRoot, '.codeep', 'mcp_servers.json'), 'utf-8'));
    expect(parsed.mcpServers.existing.command).toBe('old');
    expect(parsed.mcpServers.new.command).toBe('nw');
  });
});

describe('removeProjectMcpServer', () => {
  it('returns false when the file does not exist', () => {
    expect(removeProjectMcpServer(workspaceRoot, 'fs')).toBe(false);
  });

  it('removes from map-form file', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: { fs: { command: 'x', args: [] }, gh: { command: 'y', args: [] } },
    }));
    expect(removeProjectMcpServer(workspaceRoot, 'fs')).toBe(true);
    const remaining = loadMcpServerConfig(workspaceRoot).map(s => s.name);
    expect(remaining).toEqual(['gh']);
  });

  it('removes from array-form file', () => {
    writeProjectConfig(JSON.stringify({
      mcpServers: [
        { name: 'fs', command: 'x', args: [] },
        { name: 'gh', command: 'y', args: [] },
      ],
    }));
    expect(removeProjectMcpServer(workspaceRoot, 'fs')).toBe(true);
    expect(loadMcpServerConfig(workspaceRoot).map(s => s.name)).toEqual(['gh']);
  });

  it('returns false when the named server is not present', () => {
    writeProjectConfig(JSON.stringify({ mcpServers: { fs: { command: 'x', args: [] } } }));
    expect(removeProjectMcpServer(workspaceRoot, 'absent')).toBe(false);
  });
});
