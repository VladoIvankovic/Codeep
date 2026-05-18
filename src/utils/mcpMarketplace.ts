/**
 * Curated catalog of popular MCP servers. Lets users discover and install
 * server entries via `/mcp browse` and `/mcp install <id>` without having
 * to know the right `command` / `args` incantation.
 *
 * Maintenance:
 *   - Keep this list short (< 30 entries). The point is curation, not
 *     completeness — anything more exhaustive belongs on the website.
 *   - Each entry's `args` should be the **invocation-without-runtime-args**
 *     so `/mcp install` can prompt for the things that vary per user
 *     (paths, tokens, etc.) via `argHints`.
 *   - Prefer official `@modelcontextprotocol/*` packages over third-party.
 */

import type { McpServer } from '../acp/protocol.js';

export interface MarketplaceEntry {
  /** Short id used by `/mcp install <id>` and shown in the catalog. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** One-line description shown in the marketplace listing. */
  description: string;
  /** Skeleton server config. `args` includes the package name; users
   *  may need to add path/argument args via `argHints`. */
  server: Omit<McpServer, 'name'>;
  /** Per-arg prompts shown by `/mcp install` so the user supplies the
   *  variable bits (file paths, db URLs, etc.). */
  argHints?: { description: string; placeholder?: string; required?: boolean }[];
  /** Env vars that should be set (e.g. API tokens). Surfaced as a note. */
  envNotes?: { name: string; description: string; required?: boolean }[];
  /** Homepage / docs URL for the curious. */
  url?: string;
}

export const MCP_MARKETPLACE: MarketplaceEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, list, and (optionally) write files in a sandbox directory.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    argHints: [
      { description: 'Absolute path to expose to the agent (one or more — pass several to allow several roots).', placeholder: '/Users/you/projects/notes', required: true },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Browse repositories, issues, PRs, and commits via the GitHub API.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    envNotes: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'Token with the `repo` scope (or `public_repo` if you only need public).', required: true },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Read repos, issues, MRs, and pipelines on GitLab (cloud or self-hosted).',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'] },
    envNotes: [
      { name: 'GITLAB_PERSONAL_ACCESS_TOKEN', description: 'Token with `read_api` scope.', required: true },
      { name: 'GITLAB_API_URL', description: 'Override for self-hosted GitLab (default: https://gitlab.com/api/v4).' },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
  },
  {
    id: 'git',
    name: 'Git (local repo)',
    description: 'Inspect commits, blame, diffs, branches in a local git repository.',
    server: { command: 'uvx', args: ['mcp-server-git'] },
    argHints: [
      { description: 'Path to a git repository (omit to use the current workspace).', placeholder: '/path/to/repo' },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only SQL access to a Postgres database — schema introspection + query.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    argHints: [
      { description: 'Postgres connection URI.', placeholder: 'postgresql://user:pass@localhost/dbname', required: true },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query a SQLite database file with full SQL.',
    server: { command: 'uvx', args: ['mcp-server-sqlite'] },
    argHints: [
      { description: 'Path to the .sqlite/.db file.', placeholder: '/path/to/data.db', required: true },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'fetch',
    name: 'Fetch (web)',
    description: 'Fetch arbitrary URLs and return the markdown-converted contents.',
    server: { command: 'uvx', args: ['mcp-server-fetch'] },
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search via the Brave Search API.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
    envNotes: [
      { name: 'BRAVE_API_KEY', description: 'Get a free key at brave.com/search/api/.', required: true },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels, post messages, look up users and threads.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
    envNotes: [
      { name: 'SLACK_BOT_TOKEN', description: 'xoxb-… bot token.', required: true },
      { name: 'SLACK_TEAM_ID', description: 'Numeric workspace id.', required: true },
    ],
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id: 'memory',
    name: 'Memory (knowledge graph)',
    description: 'Persistent knowledge graph the agent reads/writes across sessions.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'time',
    name: 'Time / timezones',
    description: 'Current time, timezone conversion, IANA timezone lookup.',
    server: { command: 'uvx', args: ['mcp-server-time'] },
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer (browser)',
    description: 'Headless Chromium for navigating, screenshotting, and scraping pages.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
];

export function findMarketplaceEntry(id: string): MarketplaceEntry | null {
  const lower = id.toLowerCase();
  return MCP_MARKETPLACE.find(e => e.id === lower) ?? null;
}

/**
 * Render the catalog as Markdown for `/mcp browse`. Compact: id + name +
 * one-line description. Full details (env vars, args) on `/mcp install`.
 */
export function formatMarketplaceList(): string {
  const lines: string[] = [
    '## MCP marketplace',
    '',
    `${MCP_MARKETPLACE.length} curated servers. Install with \`/mcp install <id>\`.`,
    '',
    '| id | name | what it does |',
    '|---|---|---|',
  ];
  for (const e of MCP_MARKETPLACE) {
    lines.push(`| \`${e.id}\` | ${e.name} | ${e.description} |`);
  }
  return lines.join('\n');
}

/** Render install instructions for a single entry (without writing config). */
export function formatMarketplaceEntry(entry: MarketplaceEntry): string {
  const lines: string[] = [
    `## ${entry.name} — \`${entry.id}\``,
    '',
    entry.description,
    '',
    `**Command:** \`${entry.server.command ?? entry.server.url} ${(entry.server.args ?? []).join(' ')}\``,
  ];
  if (entry.argHints?.length) {
    lines.push('', '**Additional arguments needed:**');
    for (const h of entry.argHints) {
      const req = h.required ? ' (required)' : '';
      const placeholder = h.placeholder ? ` _e.g._ \`${h.placeholder}\`` : '';
      lines.push(`- ${h.description}${req}${placeholder}`);
    }
  }
  if (entry.envNotes?.length) {
    lines.push('', '**Environment variables:**');
    for (const e of entry.envNotes) {
      const req = e.required ? ' (required)' : '';
      lines.push(`- \`${e.name}\`${req} — ${e.description}`);
    }
  }
  if (entry.url) lines.push('', `_Docs: ${entry.url}_`);
  return lines.join('\n');
}
