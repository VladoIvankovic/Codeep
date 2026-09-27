import { describe, it, expect } from 'vitest';
import {
  MCP_MARKETPLACE,
  findMarketplaceEntry,
  formatMarketplaceList,
  formatMarketplaceEntry,
  formatInstallUsage,
  missingRequiredArgs,
  type MarketplaceEntry,
} from './mcpMarketplace';

/** The package an entry runs: the first argument that is not a flag, with a
 *  trailing `@latest` / `@1.2.3` dropped (split on the LAST `@` past index 0,
 *  so a scope such as `@playwright/mcp` survives). */
function packageOf(e: MarketplaceEntry): string {
  const pkg = (e.server.args ?? []).find(a => !a.startsWith('-')) ?? '';
  const at = pkg.lastIndexOf('@');
  return at > 0 ? pkg.slice(0, at) : pkg;
}

describe('MCP_MARKETPLACE', () => {
  it('lists exactly the packages checked against their registries', () => {
    // Checked on 2026-09-27: `npm view <pkg> name deprecated` for npx
    // entries; for uvx ones PyPI's simple API with
    // `Accept: application/vnd.pypi.simple.v1+json`, whose `project-status`
    // must be "active" (the /pypi/<pkg>/json API has no status at all — it
    // shows the archived mcp-server-sqlite as a normal project). Before that
    // check the catalog offered four packages npm marks "no longer
    // supported" and one archived on PyPI. Changing this list means running
    // those checks again for what you add.
    expect(MCP_MARKETPLACE.map(e => [e.id, e.server.command, packageOf(e)])).toEqual([
      ['filesystem', 'npx', '@modelcontextprotocol/server-filesystem'],
      ['git', 'uvx', 'mcp-server-git'],
      ['fetch', 'uvx', 'mcp-server-fetch'],
      ['brave-search', 'npx', '@brave/brave-search-mcp-server'],
      ['memory', 'npx', '@modelcontextprotocol/server-memory'],
      ['time', 'uvx', 'mcp-server-time'],
      ['playwright', 'npx', '@playwright/mcp'],
      ['ios-simulator', 'npx', 'ios-simulator-mcp'],
      ['mobile', 'npx', '@mobilenext/mobile-mcp'],
    ]);
  });

  it('runs Brave Search from Brave\'s own package over stdio', () => {
    // @modelcontextprotocol/server-brave-search is deprecated on npm.
    expect(findMarketplaceEntry('brave-search')!.server.args).toEqual(['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio']);
  });

  it('passes git\'s repository as --repository, the only form mcp-server-git accepts', () => {
    // A bare path after `mcp-server-git` is rejected at start.
    const git = findMarketplaceEntry('git')!;
    expect(git.argHints?.[0].placeholder).toMatch(/^--repository /);
    expect(git.argHints?.[0].required).toBeFalsy();
  });
});

describe('formatInstallUsage', () => {
  it('marks required arguments <…> and optional ones […]', () => {
    expect(formatInstallUsage(findMarketplaceEntry('filesystem')!)).toBe('/mcp install filesystem </Users/you/projects/notes>');
    expect(formatInstallUsage(findMarketplaceEntry('git')!)).toBe('/mcp install git [--repository /path/to/repo]');
    expect(formatInstallUsage(findMarketplaceEntry('memory')!)).toBe('/mcp install memory');
  });
});

describe('missingRequiredArgs', () => {
  const fs = () => findMarketplaceEntry('filesystem')!;

  it('refuses an entry whose required argument is missing, and says what to pass', () => {
    const why = missingRequiredArgs(fs(), []);
    expect(why).toContain('Nothing was saved');
    expect(why).toContain('/mcp install filesystem </Users/you/projects/notes>');
  });

  it('does not count blank arguments', () => {
    expect(missingRequiredArgs(fs(), ['', '  '])).not.toBeNull();
  });

  it('lets the install go ahead once the argument is there', () => {
    expect(missingRequiredArgs(fs(), ['/tmp'])).toBeNull();
  });

  it('never stops an entry with only optional arguments, or none', () => {
    expect(missingRequiredArgs(findMarketplaceEntry('git')!, [])).toBeNull();
    expect(missingRequiredArgs(findMarketplaceEntry('memory')!, [])).toBeNull();
  });
});

describe('findMarketplaceEntry', () => {
  it('finds an entry by id (case-insensitive)', () => {
    // Pick the first real id so the test doesn't hardcode a value that
    // might be removed from the catalog.
    const first = MCP_MARKETPLACE[0];
    expect(findMarketplaceEntry(first.id.toUpperCase())).toBe(first);
  });

  it('returns null for an unknown id', () => {
    expect(findMarketplaceEntry('does-not-exist-xyz')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(findMarketplaceEntry('')).toBeNull();
  });
});

describe('formatMarketplaceList', () => {
  it('renders a Markdown table header', () => {
    const out = formatMarketplaceList();
    expect(out).toContain('| id | name | what it does |');
    expect(out).toContain('|---|---|---|');
  });

  it('mentions the install command', () => {
    expect(formatMarketplaceList()).toContain('/mcp install');
  });

  it('includes one row per marketplace entry', () => {
    const out = formatMarketplaceList();
    const rows = out.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows.length).toBe(MCP_MARKETPLACE.length);
  });

  it('includes every entry id in the table', () => {
    const out = formatMarketplaceList();
    for (const e of MCP_MARKETPLACE) {
      expect(out).toContain(`\`${e.id}\``);
    }
  });
});

describe('formatMarketplaceEntry', () => {
  function sample(overrides: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
    return {
      id: 'sample',
      name: 'Sample Server',
      description: 'A sample MCP server for testing.',
      server: { command: 'npx', args: ['@sample/server'] },
      ...overrides,
    };
  }

  it('renders the entry name and id in the header', () => {
    const out = formatMarketplaceEntry(sample());
    expect(out).toContain('## Sample Server');
    expect(out).toContain('`sample`');
  });

  it('renders the description', () => {
    expect(formatMarketplaceEntry(sample())).toContain('A sample MCP server for testing.');
  });

  it('renders the command and args', () => {
    const out = formatMarketplaceEntry(sample());
    expect(out).toContain('npx');
    expect(out).toContain('@sample/server');
  });

  it('renders arg hints when present', () => {
    const e = sample({
      argHints: [{ description: 'API token', required: true, placeholder: 'xxx' }],
    });
    const out = formatMarketplaceEntry(e);
    expect(out).toContain('Additional arguments');
    expect(out).toContain('API token');
    expect(out).toContain('(required)');
    expect(out).toContain('xxx');
  });

  it('renders env notes when present', () => {
    const e = sample({
      envNotes: [{ name: 'SAMPLE_KEY', description: 'the key', required: true }],
    });
    const out = formatMarketplaceEntry(e);
    expect(out).toContain('Environment variables');
    expect(out).toContain('SAMPLE_KEY');
    expect(out).toContain('(required)');
  });

  it('links to docs when a url is set', () => {
    const e = sample({ url: 'https://example.com/docs' });
    expect(formatMarketplaceEntry(e)).toContain('https://example.com/docs');
  });

  it('omits the docs line when no url is set', () => {
    expect(formatMarketplaceEntry(sample())).not.toContain('Docs:');
  });
});
