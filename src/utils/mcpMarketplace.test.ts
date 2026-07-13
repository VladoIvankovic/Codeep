import { describe, it, expect } from 'vitest';
import {
  MCP_MARKETPLACE,
  findMarketplaceEntry,
  formatMarketplaceList,
  formatMarketplaceEntry,
  type MarketplaceEntry,
} from './mcpMarketplace';

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
