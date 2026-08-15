import { describe, it, expect } from 'vitest';
import {
  buildSearchSnippets,
  parseKeepRecent,
  joinSessionName,
  parseTaskAddArgs,
  formatTaskList,
  TASK_TYPES,
} from './helpers';

// ─── buildSearchSnippets ──────────────────────────────────────────────────────
describe('buildSearchSnippets', () => {
  const messages = [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'The quick brown fox jumps' },
    { role: 'user', content: 'HELLO again' },
  ];

  it('returns matches case-insensitively', () => {
    const out = buildSearchSnippets(messages, 'hello');
    expect(out).toHaveLength(2);
    expect(out[0].messageIndex).toBe(0);
    expect(out[1].messageIndex).toBe(2);
  });

  it('returns an empty array when nothing matches', () => {
    expect(buildSearchSnippets(messages, 'nope')).toEqual([]);
  });

  it('includes the role and message index in each result', () => {
    const out = buildSearchSnippets(messages, 'fox');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].messageIndex).toBe(1);
  });

  it('collapses newlines in the snippet to spaces', () => {
    const msgs = [{ role: 'user', content: 'line one\nCODE\nline three' }];
    const out = buildSearchSnippets(msgs, 'code');
    expect(out[0].matchedText.includes('\n')).toBe(false);
  });

  it('adds a leading ellipsis when the match is not at the start', () => {
    const long = 'x'.repeat(60) + 'TARGET' + 'y'.repeat(60);
    const out = buildSearchSnippets([{ role: 'user', content: long }], 'target');
    expect(out[0].matchedText.startsWith('...')).toBe(true);
  });

  it('adds a trailing ellipsis when there is content after the window', () => {
    const long = 'TARGET' + 'y'.repeat(60);
    const out = buildSearchSnippets([{ role: 'user', content: long }], 'target');
    expect(out[0].matchedText.endsWith('...')).toBe(true);
  });

  it('omits the leading ellipsis when the match starts at index 0', () => {
    const out = buildSearchSnippets([{ role: 'user', content: 'target here' }], 'target');
    expect(out[0].matchedText.startsWith('...')).toBe(false);
  });

  it('matches only the first occurrence in a message', () => {
    const out = buildSearchSnippets([{ role: 'user', content: 'a a a' }], 'a');
    expect(out).toHaveLength(1);
  });

  it('handles an empty message list', () => {
    expect(buildSearchSnippets([], 'x')).toEqual([]);
  });

  it('handles an empty search term (matches everything at index 0)', () => {
    const out = buildSearchSnippets([{ role: 'user', content: 'hi' }], '');
    expect(out).toHaveLength(1);
  });
});

// ─── parseKeepRecent ──────────────────────────────────────────────────────────
describe('parseKeepRecent', () => {
  it('returns the fallback when the arg is undefined', () => {
    expect(parseKeepRecent(undefined)).toBe(4);
  });

  it('returns the parsed integer for a valid numeric arg', () => {
    expect(parseKeepRecent('10')).toBe(10);
  });

  it('clamps to a minimum of 2', () => {
    expect(parseKeepRecent('0')).toBe(2);
    expect(parseKeepRecent('1')).toBe(2);
    expect(parseKeepRecent('-5')).toBe(2);
  });

  it('returns the fallback when the arg is not a number', () => {
    expect(parseKeepRecent('abc')).toBe(4);
  });

  it('respects a custom fallback', () => {
    expect(parseKeepRecent(undefined, 8)).toBe(8);
    expect(parseKeepRecent('abc', 8)).toBe(8);
  });

  it('parses a string that starts with a number', () => {
    // parseInt('5xyz', 10) === 5 — documented behaviour.
    expect(parseKeepRecent('5xyz')).toBe(5);
  });

  it('handles the explicit "2" boundary', () => {
    expect(parseKeepRecent('2')).toBe(2);
  });
});

// ─── joinSessionName ──────────────────────────────────────────────────────────
describe('joinSessionName', () => {
  it('joins args with hyphens', () => {
    expect(joinSessionName(['my', 'session'])).toBe('my-session');
  });

  it('drops empty args', () => {
    expect(joinSessionName(['my', '', 'session', ''])).toBe('my-session');
  });

  it('returns an empty string for no args', () => {
    expect(joinSessionName([])).toBe('');
  });

  it('returns an empty string when all args are empty', () => {
    expect(joinSessionName(['', ''])).toBe('');
  });

  it('preserves a single arg', () => {
    expect(joinSessionName(['solo'])).toBe('solo');
  });

  it('does not collapse hyphens already in the args', () => {
    expect(joinSessionName(['a-b', 'c'])).toBe('a-b-c');
  });
});

// ─── parseTaskAddArgs ─────────────────────────────────────────────────────────
describe('parseTaskAddArgs', () => {
  it('parses a bare title with default type', () => {
    expect(parseTaskAddArgs(['fix', 'login'])).toEqual({
      title: 'fix login',
      description: '',
      type: 'task',
    });
  });

  it('sets the type via --bug', () => {
    expect(parseTaskAddArgs(['--bug', 'crash']).type).toBe('bug');
  });

  it('sets the type via --feature', () => {
    expect(parseTaskAddArgs(['--feature', 'dark mode']).type).toBe('feature');
  });

  it('sets the type via --task explicitly', () => {
    expect(parseTaskAddArgs(['--task', 'thing']).type).toBe('task');
  });

  it('captures --desc as the description', () => {
    const out = parseTaskAddArgs(['title', '--desc', 'a long description here']);
    expect(out.title).toBe('title');
    expect(out.description).toBe('a long description here');
  });

  it('captures --description as the description (alias)', () => {
    const out = parseTaskAddArgs(['title', '--description', 'details']);
    expect(out.description).toBe('details');
  });

  it('ends description capture at the next flag', () => {
    const out = parseTaskAddArgs(['title', '--desc', 'words', '--bug', 'more']);
    expect(out.description).toBe('words');
    expect(out.title).toBe('title more');
    expect(out.type).toBe('bug');
  });

  it('last --type flag wins', () => {
    expect(parseTaskAddArgs(['--bug', '--feature', 'x']).type).toBe('feature');
  });

  it('returns an empty title when only flags are given', () => {
    expect(parseTaskAddArgs(['--bug']).title).toBe('');
  });

  it('returns an empty title and description for no args', () => {
    expect(parseTaskAddArgs([])).toEqual({ title: '', description: '', type: 'task' });
  });

  it('lower-cases flag names', () => {
    expect(parseTaskAddArgs(['--BUG', 'x']).type).toBe('bug');
    expect(parseTaskAddArgs(['--Desc', 'text']).description).toBe('text');
  });

  it('ignores unknown flags but ends description capture', () => {
    const out = parseTaskAddArgs(['title', '--unknown', 'word', '--desc', 'd']);
    expect(out.title).toBe('title word');
    expect(out.description).toBe('d');
  });

  it('TASK_TYPES is task/bug/feature', () => {
    expect(TASK_TYPES).toEqual(['task', 'bug', 'feature']);
  });
});

// ─── formatTaskList ───────────────────────────────────────────────────────────
describe('formatTaskList', () => {
  it('renders a header with the scoped project name', () => {
    const out = formatTaskList([{ title: 't' }], 'myproj');
    expect(out.startsWith('## Tasks — myproj')).toBe(true);
  });

  it('renders a bare header when no project name is given', () => {
    const out = formatTaskList([{ title: 't' }]);
    expect(out.startsWith('## Tasks\n')).toBe(true);
  });

  it('numbers tasks starting at 1', () => {
    const out = formatTaskList([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    expect(out).toContain('1. [task] a');
    expect(out).toContain('2. [task] b');
    expect(out).toContain('3. [task] c');
  });

  it('uses the type icon when set', () => {
    const out = formatTaskList([
      { title: 'a', type: 'bug' },
      { title: 'b', type: 'feature' },
      { title: 'c', type: 'task' },
    ]);
    expect(out).toContain('[bug] a');
    expect(out).toContain('[feature] b');
    expect(out).toContain('[task] c');
  });

  it('falls back to [task] for unknown types', () => {
    const out = formatTaskList([{ title: 'a', type: 'weird' }]);
    expect(out).toContain('[task] a');
  });

  it('falls back to [task] when type is missing', () => {
    const out = formatTaskList([{ title: 'a' }]);
    expect(out).toContain('[task] a');
  });

  it('renders the description on a new line when present', () => {
    const out = formatTaskList([{ title: 'a', description: 'details here' }]);
    expect(out).toContain('   details here');
  });

  it('omits the description line when description is null', () => {
    const out = formatTaskList([{ title: 'a', description: null }]);
    expect(out).not.toContain('   ');
  });

  it('tags each row with the project name in a global listing', () => {
    const out = formatTaskList([{ title: 'a', project_name: 'proj-x' }]);
    expect(out).toContain('_(proj-x)_');
  });

  it('does not tag rows when scoped to a single project', () => {
    const out = formatTaskList([{ title: 'a', project_name: 'proj-x' }], 'proj-x');
    expect(out).not.toContain('_(proj-x)_');
  });

  it('uses singular "task" for a single pending task', () => {
    const out = formatTaskList([{ title: 'a' }]);
    expect(out).toContain('1 pending task.');
  });

  it('uses plural "tasks" for multiple pending tasks', () => {
    const out = formatTaskList([{ title: 'a' }, { title: 'b' }]);
    expect(out).toContain('2 pending tasks.');
  });

  it('includes the agent-context footer', () => {
    const out = formatTaskList([{ title: 'a' }]);
    expect(out).toContain('Tasks loaded into agent context');
  });
});

// ─── formatProfileList ────────────────────────────────────────────────────────
import { formatProfileList } from './helpers';

describe('formatProfileList', () => {
  it('renders the header and usage hint', () => {
    const out = formatProfileList(['work', 'personal']);
    expect(out.startsWith('## Profiles\n\n')).toBe(true);
    expect(out).toContain('Use /profile load <name> to apply.');
  });

  it('lists each profile as a bullet', () => {
    const out = formatProfileList(['a', 'b']);
    expect(out).toContain('- a');
    expect(out).toContain('- b');
  });

  it('handles a single profile', () => {
    expect(formatProfileList(['only'])).toContain('- only');
  });

  it('handles an empty list (renders the header with no bullets)', () => {
    const out = formatProfileList([]);
    expect(out).toContain('## Profiles');
    expect(out).not.toContain('- ');
  });
});

// ─── formatMemoryList ─────────────────────────────────────────────────────────
import { formatMemoryList } from './helpers';

describe('formatMemoryList', () => {
  it('renders the header and numbered notes', () => {
    const out = formatMemoryList(['first', 'second']);
    expect(out.startsWith('**Project memory notes:**\n')).toBe(true);
    expect(out).toContain('  1. first');
    expect(out).toContain('  2. second');
  });

  it('numbers notes starting at 1', () => {
    const out = formatMemoryList(['a', 'b', 'c']);
    expect(out).toContain('  1. a');
    expect(out).toContain('  2. b');
    expect(out).toContain('  3. c');
  });

  it('handles a single note', () => {
    expect(formatMemoryList(['solo'])).toContain('  1. solo');
  });

  it('renders an empty body when there are no notes', () => {
    const out = formatMemoryList([]);
    expect(out).toBe('**Project memory notes:**\n');
  });
});

// ─── formatModelCost ──────────────────────────────────────────────────────────
import { formatModelCost } from './helpers';

describe('formatModelCost', () => {
  it('returns "free" for ollama regardless of cost', () => {
    expect(formatModelCost('ollama', 1.5)).toBe('free');
    expect(formatModelCost('ollama', 0)).toBe('free');
  });

  it('returns a formatted cost string when estimatedCost > 0', () => {
    expect(formatModelCost('openai', 0.00123)).toBe('~$0.0012');
  });

  it('returns "no pricing data" when cost is 0 for a non-ollama provider', () => {
    expect(formatModelCost('anthropic', 0)).toBe('(no pricing data)');
  });

  it('rounds to 4 decimal places', () => {
    expect(formatModelCost('x', 0.123456)).toBe('~$0.1235');
  });

  it('says "included in plan" for flat-fee providers instead of a dollar figure', () => {
    expect(formatModelCost('z.ai', 0.0031)).toBe('included in plan');
    expect(formatModelCost('kimi', 0.0029)).toBe('included in plan');
    expect(formatModelCost('modelscope', 0)).toBe('included in plan');
    // The pay-per-use twins keep their price.
    expect(formatModelCost('z.ai-api', 0.0031)).toBe('~$0.0031');
  });
});

// ─── formatStatsReport ────────────────────────────────────────────────────────
import {
  formatStatsReport,
  type StatsTotals,
  type StatsModelRow,
  type StatsCache,
  type PricingRow,
} from './helpers';

const idFmt = (n: number) => String(n);

const emptyTotals: StatsTotals = {
  requestCount: 0,
  totalTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  estimatedCost: 0,
};

const emptyCache: StatsCache = {
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedSavingsUsd: 0,
};

const samplePricing: PricingRow[] = [
  { model: 'gpt-4', inputPer1M: 30, outputPer1M: 60 },
  { model: 'claude-3', inputPer1M: 15, outputPer1M: 75 },
];

describe('formatStatsReport', () => {
  it('shows the "no calls" message when requestCount is 0', () => {
    const out = formatStatsReport({
      totals: emptyTotals,
      breakdown: [],
      cache: emptyCache,
      pricing: samplePricing,
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('*No API calls made yet this session.*');
  });

  it('always renders the pricing table even with no requests', () => {
    const out = formatStatsReport({
      totals: emptyTotals,
      breakdown: [],
      cache: emptyCache,
      pricing: samplePricing,
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('### Pricing (per 1M tokens)');
    expect(out).toContain('| gpt-4 | $30.000 | $60.000 |');
    expect(out).toContain('| claude-3 | $15.000 | $75.000 |');
  });

  it('shows request and token totals when requestCount > 0', () => {
    const out = formatStatsReport({
      totals: { requestCount: 5, totalTokens: 1000, totalPromptTokens: 700, totalCompletionTokens: 300, estimatedCost: 0.05 },
      breakdown: [],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('Requests: 5');
    expect(out).toContain('Tokens: 1000 total (700 in / 300 out)');
  });

  it('renders the per-model breakdown with cost', () => {
    const breakdown: StatsModelRow[] = [
      { model: 'gpt-4', provider: 'openai', promptTokens: 100, completionTokens: 50, estimatedCost: 0.02 },
    ];
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 150, totalPromptTokens: 100, totalCompletionTokens: 50, estimatedCost: 0.02 },
      breakdown,
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('### By model');
    expect(out).toContain('**gpt-4** (openai): 100 in / 50 out — ~$0.0200');
    expect(out).toContain('**Total: ~$0.0200**');
  });

  it('totals only the pay-per-use rows when a session mixes billing models', () => {
    const breakdown: StatsModelRow[] = [
      { model: 'glm-5.2', provider: 'z.ai', promptTokens: 1000, completionTokens: 500, estimatedCost: 0.0036 },
      { model: 'gpt-4', provider: 'openai', promptTokens: 100, completionTokens: 50, estimatedCost: 0.02 },
    ];
    const out = formatStatsReport({
      // totals.estimatedCost still carries the raw sum — the report must not use it.
      totals: { requestCount: 2, totalTokens: 1650, totalPromptTokens: 1100, totalCompletionTokens: 550, estimatedCost: 0.0236 },
      breakdown,
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('**glm-5.2** (z.ai): 1000 in / 500 out — included in plan');
    expect(out).toContain('**gpt-4** (openai): 100 in / 50 out — ~$0.0200');
    expect(out).toContain('**Total: ~$0.0200 + usage included in plan**');
    expect(out).not.toContain('0.0236');
  });

  it('shows a plan total when every row is flat-fee', () => {
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 1500, totalPromptTokens: 1000, totalCompletionTokens: 500, estimatedCost: 0.0036 },
      breakdown: [{ model: 'glm-5.2', provider: 'z.ai', promptTokens: 1000, completionTokens: 500, estimatedCost: 0.0036 }],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'z.ai',
      fmt: idFmt,
    });
    expect(out).toContain('**Total: included in plan · 1500 tokens**');
    expect(out).not.toContain('0.0036');
  });

  it('shows "free" total for ollama provider', () => {
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 150, totalPromptTokens: 100, totalCompletionTokens: 50, estimatedCost: 0 },
      breakdown: [{ model: 'llama3', provider: 'ollama', promptTokens: 100, completionTokens: 50, estimatedCost: 0 }],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'ollama',
      fmt: idFmt,
    });
    expect(out).toContain('**Total: free · 150 tokens**');
    expect(out).toContain('— free');
  });

  it('omits the total line when estimatedCost is 0 and provider is not ollama', () => {
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 150, totalPromptTokens: 100, totalCompletionTokens: 50, estimatedCost: 0 },
      breakdown: [{ model: 'x', provider: 'openai', promptTokens: 100, completionTokens: 50, estimatedCost: 0 }],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).not.toContain('**Total:');
  });

  it('renders the caching section only when there are cache tokens', () => {
    const withCache: StatsCache = { cacheReadTokens: 500, cacheCreationTokens: 200, estimatedSavingsUsd: 0.01 };
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 700, totalPromptTokens: 500, totalCompletionTokens: 200, estimatedCost: 0.01 },
      breakdown: [],
      cache: withCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('### Prompt caching');
    expect(out).toContain('Cache reads: 500 tokens');
    expect(out).toContain('Cache writes: 200 tokens');
    expect(out).toContain('Estimated savings vs no caching: $0.0100');
  });

  it('omits the caching section when there are no cache tokens', () => {
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 100, totalPromptTokens: 50, totalCompletionTokens: 50, estimatedCost: 0.01 },
      breakdown: [],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).not.toContain('### Prompt caching');
  });

  it('omits the cache-writes line when only reads are present', () => {
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 500, totalPromptTokens: 400, totalCompletionTokens: 100, estimatedCost: 0.01 },
      breakdown: [],
      cache: { cacheReadTokens: 400, cacheCreationTokens: 0, estimatedSavingsUsd: 0 },
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('Cache reads: 400 tokens');
    expect(out).not.toContain('Cache writes:');
  });

  it('uses the injected token formatter', () => {
    const commaFmt = (n: number) => n.toLocaleString('en-US');
    const out = formatStatsReport({
      totals: { requestCount: 1, totalTokens: 12345, totalPromptTokens: 10000, totalCompletionTokens: 2345, estimatedCost: 0 },
      breakdown: [],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: commaFmt,
    });
    expect(out).toContain('Tokens: 12,345 total');
  });

  it('formats pricing rows to 3 decimal places', () => {
    const out = formatStatsReport({
      totals: emptyTotals,
      breakdown: [],
      cache: emptyCache,
      pricing: [{ model: 'x', inputPer1M: 3.14159, outputPer1M: 6.28318 }],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('| x | $3.142 | $6.283 |');
  });

  it('handles an empty pricing table', () => {
    const out = formatStatsReport({
      totals: emptyTotals,
      breakdown: [],
      cache: emptyCache,
      pricing: [],
      currentProvider: 'openai',
      fmt: idFmt,
    });
    expect(out).toContain('### Pricing (per 1M tokens)');
    expect(out).toContain('| Model | Input | Output |');
    // No data rows beyond the header.
    const tableRows = out.split('\n').filter((l) => l.startsWith('| ') && l !== '| Model | Input | Output |' && l !== '|---|---|---|');
    expect(tableRows).toHaveLength(0);
  });
});

// ─── extractCodeBlocks ────────────────────────────────────────────────────────
import { extractCodeBlocks } from './helpers';

describe('extractCodeBlocks', () => {
  it('extracts a single fenced block body', () => {
    expect(extractCodeBlocks('```\ncode\n```')).toEqual(['code\n']);
  });

  it('ignores the language fence', () => {
    expect(extractCodeBlocks('```ts\nconst x = 1\n```')).toEqual(['const x = 1\n']);
  });

  it('extracts multiple blocks in order', () => {
    const text = '```js\na\n```\n---\n```py\nb\n```';
    expect(extractCodeBlocks(text)).toEqual(['a\n', 'b\n']);
  });

  it('returns an empty array when there are no fences', () => {
    expect(extractCodeBlocks('no code here')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(extractCodeBlocks('')).toEqual([]);
  });

  it('captures multiline block bodies', () => {
    const text = '```\nline1\nline2\nline3\n```';
    expect(extractCodeBlocks(text)).toEqual(['line1\nline2\nline3\n']);
  });

  it('does not capture fences without a trailing newline', () => {
    expect(extractCodeBlocks('```inline code```')).toEqual([]);
  });
});

// ─── resolveBlockIndex ────────────────────────────────────────────────────────
import { resolveBlockIndex } from './helpers';

describe('resolveBlockIndex', () => {
  it('returns null when there are no blocks', () => {
    expect(resolveBlockIndex(1, 0)).toBeNull();
  });

  it('resolves -1 to the last block', () => {
    expect(resolveBlockIndex(-1, 3)).toBe(2);
  });

  it('converts a 1-based index to 0-based', () => {
    expect(resolveBlockIndex(1, 3)).toBe(0);
    expect(resolveBlockIndex(2, 3)).toBe(1);
    expect(resolveBlockIndex(3, 3)).toBe(2);
  });

  it('returns null for an index below 1', () => {
    expect(resolveBlockIndex(0, 3)).toBeNull();
  });

  it('returns null for an index above the block count', () => {
    expect(resolveBlockIndex(4, 3)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(resolveBlockIndex(NaN, 3)).toBeNull();
  });
});

// ─── extractFileChanges ───────────────────────────────────────────────────────
import { extractFileChanges } from './helpers';

describe('extractFileChanges', () => {
  it('extracts a fence with a filename header', () => {
    const text = '```ts\nsrc/foo.ts\nconst x = 1;\n```';
    expect(extractFileChanges(text)).toEqual([{ path: 'src/foo.ts', content: 'const x = 1;\n' }]);
  });

  it('extracts multiple fences', () => {
    const text = '```js\na.js\nA\n```\n```py\nb.py\nB\n```';
    expect(extractFileChanges(text)).toEqual([
      { path: 'a.js', content: 'A\n' },
      { path: 'b.py', content: 'B\n' },
    ]);
  });

  it('skips paths without a dot', () => {
    const text = '```\nREADME\ncontent\n```';
    expect(extractFileChanges(text)).toEqual([]);
  });

  it('skips paths with spaces', () => {
    const text = '```\nmy file.ts\ncontent\n```';
    expect(extractFileChanges(text)).toEqual([]);
  });

  it('falls back to the // File: comment pattern when no fence headers match', () => {
    const text = '```ts\n// File: src/bar.ts\nconst y = 2;\n```';
    expect(extractFileChanges(text)).toEqual([{ path: 'src/bar.ts', content: 'const y = 2;\n' }]);
  });

  it('falls back to the # Path: comment pattern', () => {
    const text = '```py\n# Path: scripts/run.py\nprint(1)\n```';
    expect(extractFileChanges(text)).toEqual([{ path: 'scripts/run.py', content: 'print(1)\n' }]);
  });

  it('does not fall back when fence headers already matched', () => {
    const text = '```ts\nreal.ts\nA\n```\n```ts\n// File: ignored.ts\nB\n```';
    const out = extractFileChanges(text);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('real.ts');
  });

  it('returns an empty array when nothing matches', () => {
    expect(extractFileChanges('no code')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(extractFileChanges('')).toEqual([]);
  });
});

// ─── shortPathForDisplay ──────────────────────────────────────────────────────
import { shortPathForDisplay } from './helpers';

describe('shortPathForDisplay', () => {
  it('returns the path unchanged when it fits', () => {
    expect(shortPathForDisplay('src/foo.ts')).toBe('src/foo.ts');
  });

  it('truncates to the last 37 chars with a leading ellipsis when too long', () => {
    const long = 'a'.repeat(50);
    const out = shortPathForDisplay(long);
    expect(out.length).toBe(40);
    expect(out.startsWith('...')).toBe(true);
    expect(out.slice(3)).toBe(long.slice(-37));
  });

  it('uses a custom max length', () => {
    expect(shortPathForDisplay('abcdef', 4)).toBe('...f');
  });

  it('does not truncate a path exactly at max length', () => {
    expect(shortPathForDisplay('abcd', 4)).toBe('abcd');
  });
});

// ─── formatApplyDiffLine ──────────────────────────────────────────────────────
import { formatApplyDiffLine } from './helpers';

describe('formatApplyDiffLine', () => {
  it('renders a CREATE line when the file does not exist', () => {
    const out = formatApplyDiffLine({ path: 'new.ts', content: 'a\nb\nc' }, '');
    expect(out[0]).toBe('+ CREATE: new.ts');
    expect(out[1]).toBe('  (3 lines)');
  });

  it('renders a MODIFY line with the line delta when the file exists', () => {
    const out = formatApplyDiffLine({ path: 'mod.ts', content: 'a\nb\nc\nd' }, 'x\ny');
    expect(out[0]).toBe('~ MODIFY: mod.ts');
    expect(out[1]).toBe('  2 → 4 lines (+2)');
  });

  it('shows a negative delta with no leading +', () => {
    const out = formatApplyDiffLine({ path: 'mod.ts', content: 'a' }, 'x\ny\nz\nw');
    expect(out[1]).toBe('  4 → 1 lines (-3)');
  });

  it('shows +0 when the line count is unchanged', () => {
    const out = formatApplyDiffLine({ path: 'mod.ts', content: 'a\nb' }, 'x\ny');
    expect(out[1]).toContain('+0');
  });

  it('truncates long paths in the output', () => {
    const long = 'a'.repeat(50);
    const out = formatApplyDiffLine({ path: long, content: 'x' }, '');
    expect(out[0]).toContain('...');
  });

  it('counts a trailing newline as an extra line in the new content', () => {
    // "a\nb\n".split('\n') === ['a','b',''] → length 3.
    const out = formatApplyDiffLine({ path: 'p.ts', content: 'a\nb\n' }, '');
    expect(out[1]).toBe('  (3 lines)');
  });
});

// ─── parsePromptArgs ──────────────────────────────────────────────────────────
import { parsePromptArgs } from './helpers';

describe('parsePromptArgs', () => {
  it('parses key=value tokens', () => {
    expect(parsePromptArgs(['k1=v1', 'k2=v2'])).toEqual({ k1: 'v1', k2: 'v2' });
  });

  it('parses a single token', () => {
    expect(parsePromptArgs(['only=me'])).toEqual({ only: 'me' });
  });

  it('returns an empty object for no tokens', () => {
    expect(parsePromptArgs([])).toEqual({});
  });

  it('skips tokens without an =', () => {
    expect(parsePromptArgs(['nope', 'k=v'])).toEqual({ k: 'v' });
  });

  it('skips tokens with = at position 0', () => {
    expect(parsePromptArgs(['=val', 'k=v'])).toEqual({ k: 'v' });
  });

  it('captures values containing =', () => {
    expect(parsePromptArgs(['url=http://x?a=b'])).toEqual({ url: 'http://x?a=b' });
  });

  it('allows empty values', () => {
    expect(parsePromptArgs(['k='])).toEqual({ k: '' });
  });

  it('last value wins on duplicate keys', () => {
    expect(parsePromptArgs(['k=1', 'k=2'])).toEqual({ k: '2' });
  });
});

// ─── pluralTools ──────────────────────────────────────────────────────────────
import { pluralTools } from './helpers';

describe('pluralTools', () => {
  it('returns "tool" for 1', () => {
    expect(pluralTools(1)).toBe('tool');
  });
  it('returns "tools" for 0', () => {
    expect(pluralTools(0)).toBe('tools');
  });
  it('returns "tools" for 2+', () => {
    expect(pluralTools(2)).toBe('tools');
    expect(pluralTools(100)).toBe('tools');
  });
});

// ─── groupToolsByServer ───────────────────────────────────────────────────────
import { groupToolsByServer } from './helpers';

describe('groupToolsByServer', () => {
  it('returns an empty array for no tools', () => {
    expect(groupToolsByServer([])).toEqual([]);
  });

  it('groups tools by serverName', () => {
    const tools = [
      { serverName: 'a', x: 1 },
      { serverName: 'b', x: 2 },
      { serverName: 'a', x: 3 },
    ];
    const out = groupToolsByServer(tools);
    expect(out).toHaveLength(2);
    expect(out[0].serverName).toBe('a');
    expect(out[0].serverTools).toEqual([{ serverName: 'a', x: 1 }, { serverName: 'a', x: 3 }]);
    expect(out[1].serverName).toBe('b');
    expect(out[1].serverTools).toEqual([{ serverName: 'b', x: 2 }]);
  });

  it('preserves first-seen order', () => {
    const tools = [
      { serverName: 'z' },
      { serverName: 'a' },
      { serverName: 'z' },
    ];
    const out = groupToolsByServer(tools);
    expect(out.map((g) => g.serverName)).toEqual(['z', 'a']);
  });

  it('keeps a single server as one group', () => {
    const tools = [{ serverName: 'only' }, { serverName: 'only' }];
    expect(groupToolsByServer(tools)).toHaveLength(1);
    expect(out0(tools).serverTools).toHaveLength(2);
  });
});
const out0 = <T extends { serverName: string }>(t: T[]) => groupToolsByServer(t)[0];

// ─── formatMcpServerList ──────────────────────────────────────────────────────
import { formatMcpServerList } from './helpers';

describe('formatMcpServerList', () => {
  it('shows the empty-state message when there are no tools and no errors', () => {
    const out = formatMcpServerList([], []);
    expect(out).toContain('_No MCP servers connected to this session._');
    expect(out).toContain('/mcp add');
    expect(out).toContain('/mcp install');
  });

  it('lists servers and their tools', () => {
    const tools = [
      { serverName: 'fs', agentName: 'read_file', description: 'Reads a file' },
      { serverName: 'fs', agentName: 'write_file' },
      { serverName: 'git', agentName: 'git_status' },
    ];
    const out = formatMcpServerList(tools, []);
    expect(out).toContain('## MCP servers');
    expect(out).toContain('**fs** — 2 tools');
    expect(out).toContain('- `read_file` — Reads a file');
    expect(out).toContain('- `write_file`');
    expect(out).toContain('**git** — 1 tool');
    expect(out).toContain('- `git_status`');
  });

  it('uses singular "tool" for a single tool', () => {
    const tools = [{ serverName: 'x', agentName: 't' }];
    expect(formatMcpServerList(tools, [])).toContain('**x** — 1 tool');
  });

  it('lists failed servers', () => {
    const errors = [{ server: 'broken', error: 'ENOENT' }];
    const out = formatMcpServerList([], errors);
    expect(out).toContain('### Failed servers');
    expect(out).toContain('**broken** — `ENOENT`');
  });

  it('shows both tools and errors when both are present', () => {
    const tools = [{ serverName: 'ok', agentName: 't' }];
    const errors = [{ server: 'bad', error: 'x' }];
    const out = formatMcpServerList(tools, errors);
    expect(out).toContain('**ok**');
    expect(out).toContain('### Failed servers');
  });
});

// ─── formatMcpReloadReport ────────────────────────────────────────────────────
import { formatMcpReloadReport } from './helpers';

describe('formatMcpReloadReport', () => {
  it('shows the tool and server counts', () => {
    const out = formatMcpReloadReport(5, 2, []);
    expect(out).toContain('## MCP reloaded');
    expect(out).toContain('**5** tools from **2** servers.');
  });

  it('uses singular forms for 1', () => {
    const out = formatMcpReloadReport(1, 1, []);
    expect(out).toContain('**1** tool from **1** server.');
  });

  it('lists failed servers', () => {
    const out = formatMcpReloadReport(1, 2, [{ server: 'bad', error: 'boom' }]);
    expect(out).toContain('### Failed servers');
    expect(out).toContain('**bad** — `boom`');
  });

  it('omits the failed-servers section when there are no errors', () => {
    expect(formatMcpReloadReport(1, 1, [])).not.toContain('### Failed servers');
  });
});

// ─── formatMcpResourcesList ───────────────────────────────────────────────────
import { formatMcpResourcesList } from './helpers';

describe('formatMcpResourcesList', () => {
  it('shows the empty-state message when there are no groups', () => {
    expect(formatMcpResourcesList([])).toBe('_No MCP server in this session exposes resources._');
  });

  it('lists resources with their URI, name, mime, and description', () => {
    const groups = [
      {
        serverName: 'fs',
        resources: [
          { uri: 'file:///a', name: 'A', mimeType: 'text/plain', description: 'The A file' },
          { uri: 'file:///b' },
        ],
      },
    ];
    const out = formatMcpResourcesList(groups);
    expect(out).toContain('## MCP resources');
    expect(out).toContain('**fs** — 2 resources');
    expect(out).toContain('- A — `file:///a` (text/plain) — The A file');
    expect(out).toContain('- `file:///b`');
    expect(out).toContain('Read one with `/mcp read <uri>`.');
  });

  it('uses singular "resource" for one', () => {
    const out = formatMcpResourcesList([{ serverName: 'x', resources: [{ uri: 'u' }] }]);
    expect(out).toContain('**x** — 1 resource');
  });
});

// ─── formatMcpResourceRead ────────────────────────────────────────────────────
import { formatMcpResourceRead } from './helpers';

describe('formatMcpResourceRead', () => {
  it('shows the empty-state message when contents is empty', () => {
    expect(formatMcpResourceRead('file:///x', [])).toBe('_No content returned for `file:///x`._');
  });

  it('renders text content in a fenced block', () => {
    const out = formatMcpResourceRead('file:///x', [{ text: 'hello' }]);
    expect(out).toContain('## Resource: `file:///x`');
    expect(out).toContain('```\nhello\n```');
  });

  it('uses the json fence when mimeType includes json', () => {
    const out = formatMcpResourceRead('u', [{ text: '{}', mimeType: 'application/json' }]);
    expect(out).toContain('```json\n{}\n```');
  });

  it('uses the markdown fence when mimeType includes markdown', () => {
    const out = formatMcpResourceRead('u', [{ text: '# hi', mimeType: 'text/markdown' }]);
    expect(out).toContain('```markdown\n# hi\n```');
  });

  it('renders blobs as a non-rendered note', () => {
    const out = formatMcpResourceRead('u', [{ blob: 'AAAA', mimeType: 'image/png' }]);
    expect(out).toContain('(image/png blob, 4 base64 chars — not rendered)');
  });

  it('defaults blob mime to "binary"', () => {
    const out = formatMcpResourceRead('u', [{ blob: 'QQ==' }]);
    expect(out).toContain('(binary blob, 4 base64 chars — not rendered)');
  });
});

// ─── formatMcpPromptsList ─────────────────────────────────────────────────────
import { formatMcpPromptsList } from './helpers';

describe('formatMcpPromptsList', () => {
  it('shows the empty-state message when there are no groups', () => {
    expect(formatMcpPromptsList([])).toBe('_No MCP server in this session exposes prompt templates._');
  });

  it('lists prompts with their arguments', () => {
    const groups = [
      {
        serverName: 'git',
        prompts: [
          {
            name: 'commit',
            description: 'Make a commit',
            arguments: [
              { name: 'msg', required: true },
              { name: 'scope' },
            ],
          },
        ],
      },
    ];
    const out = formatMcpPromptsList(groups);
    expect(out).toContain('## MCP prompt templates');
    expect(out).toContain('**git** — 1 prompt');
    expect(out).toContain('- `commit` (msg, [scope]) — Make a commit');
  });

  it('omits the arg list when there are no arguments', () => {
    const out = formatMcpPromptsList([{ serverName: 'x', prompts: [{ name: 'p' }] }]);
    expect(out).toContain('- `p`');
    expect(out).not.toContain('(');
  });

  it('uses singular "prompt" for one', () => {
    const out = formatMcpPromptsList([{ serverName: 'x', prompts: [{ name: 'p' }] }]);
    expect(out).toContain('**x** — 1 prompt');
  });
});

// ─── formatMcpPromptResult ────────────────────────────────────────────────────
import { formatMcpPromptResult } from './helpers';

describe('formatMcpPromptResult', () => {
  it('renders the header and message list', () => {
    const out = formatMcpPromptResult('srv', 'greet', 'A greeting', [
      { role: 'user', content: { text: 'hi' } },
      { role: 'assistant', content: { text: 'hello' } },
    ]);
    expect(out).toContain('## Prompt `srv/greet`');
    expect(out).toContain('_A greeting_');
    expect(out).toContain('**user:** hi');
    expect(out).toContain('**assistant:** hello');
  });

  it('omits the description line when description is undefined', () => {
    const out = formatMcpPromptResult('s', 'n', undefined, [{ role: 'user', content: { text: 'x' } }]);
    expect(out).not.toContain('_undefined_');
    expect(out).toContain('**user:** x');
  });

  it('falls back to JSON when content.text is not a string', () => {
    const out = formatMcpPromptResult('s', 'n', undefined, [
      { role: 'user', content: { foo: 'bar' } as unknown as { text?: string } },
    ]);
    expect(out).toContain('**user:** {"foo":"bar"}');
  });

  it('trims trailing blank lines', () => {
    const out = formatMcpPromptResult('s', 'n', undefined, [{ role: 'user', content: { text: 'x' } }]);
    expect(out.endsWith('x')).toBe(true);
  });
});

// ─── parseInsightsDays ────────────────────────────────────────────────────────
import { parseInsightsDays } from './helpers';

describe('parseInsightsDays', () => {
  it('returns the default (7) when no flag is present', () => {
    expect(parseInsightsDays([])).toBe(7);
    expect(parseInsightsDays(['foo'])).toBe(7);
  });

  it('parses --days N (space-separated)', () => {
    expect(parseInsightsDays(['--days', '30'])).toBe(30);
  });

  it('parses --days=N (equals form)', () => {
    expect(parseInsightsDays(['--days=14'])).toBe(14);
  });

  it('keeps the last --days when multiple are given', () => {
    expect(parseInsightsDays(['--days', '5', '--days=10'])).toBe(10);
  });

  it('ignores --days with no following value', () => {
    expect(parseInsightsDays(['--days'])).toBe(7);
  });

  it('ignores a non-numeric value', () => {
    expect(parseInsightsDays(['--days', 'abc'])).toBe(7);
    expect(parseInsightsDays(['--days=xyz'])).toBe(7);
  });

  it('accepts 0', () => {
    expect(parseInsightsDays(['--days', '0'])).toBe(0);
  });

  it('accepts negative values (no clamping)', () => {
    expect(parseInsightsDays(['--days', '-3'])).toBe(-3);
  });

  it('respects a custom fallback', () => {
    expect(parseInsightsDays([], 30)).toBe(30);
  });
});

// ─── formatCloudSessionLabel ──────────────────────────────────────────────────
import { formatCloudSessionLabel } from './helpers';

describe('formatCloudSessionLabel', () => {
  const base = {
    sessionId: 'abc123def456',
    updatedAt: '2024-01-15T10:00:00Z',
    messageCount: 12,
  };

  it('uses the sessionName when present', () => {
    const out = formatCloudSessionLabel({ ...base, sessionName: 'My Session', projectName: null });
    expect(out.startsWith('My Session')).toBe(true);
  });

  it('falls back to the first 8 chars of sessionId when sessionName is null', () => {
    const out = formatCloudSessionLabel({ ...base, sessionName: null, projectName: null });
    expect(out.startsWith('abc123de')).toBe(true);
  });

  it('includes the message count', () => {
    const out = formatCloudSessionLabel({ ...base, sessionName: 's', projectName: null });
    expect(out).toContain('12 msg');
  });

  it('appends the project tag when projectName is set', () => {
    const out = formatCloudSessionLabel({ ...base, sessionName: 's', projectName: 'myproj' });
    expect(out).toContain('· myproj');
  });

  it('omits the project tag when projectName is null', () => {
    const out = formatCloudSessionLabel({ ...base, sessionName: 's', projectName: null });
    expect(out).not.toMatch(/· myproj/);
  });

  it('formats the date as "Mon D"', () => {
    const out = formatCloudSessionLabel({ ...base, sessionName: 's', projectName: null });
    // Jan 15 2024 → "Jan 15"
    expect(out).toContain('Jan 15');
  });
});

// ─── formatMeSyncReport ───────────────────────────────────────────────────────
import { formatMeSyncReport } from './helpers';

describe('formatMeSyncReport', () => {
  it('shows both push and pull lines on full success', () => {
    const out = formatMeSyncReport(true, 1);
    expect(out).toContain('✓ Profile pushed to the dashboard');
    expect(out).toContain('✓ Profile pulled to this machine');
  });

  it('shows only the push line when pulled is not 1', () => {
    const out = formatMeSyncReport(true, 0);
    expect(out).toContain('✓ Profile pushed to the dashboard');
    expect(out).not.toContain('pulled');
  });

  it('shows the empty-state hint when nothing happened', () => {
    const out = formatMeSyncReport(false, 0);
    expect(out).toContain('Nothing to sync yet');
  });

  it('handles pulled === null (network failure)', () => {
    const out = formatMeSyncReport(false, null);
    expect(out).toContain('Nothing to sync yet');
  });

  it('includes the header', () => {
    expect(formatMeSyncReport(true, 1)).toContain('## Profile sync');
  });
});

// ─── formatMeLearnResult ──────────────────────────────────────────────────────
import { formatMeLearnResult } from './helpers';

describe('formatMeLearnResult', () => {
  it('renders the "updated" message when facts were written', () => {
    const out = formatMeLearnResult('global', '~/.codeep/profile.learned.md', { updated: true, facts: '- likes TS' });
    expect(out).toContain('Updated your global learned profile');
    expect(out).toContain('~/.codeep/profile.learned.md');
    expect(out).toContain('- likes TS');
    expect(out).toContain('/me forget');
  });

  it('renders the "no changes" message when already covered', () => {
    const out = formatMeLearnResult('project', '.codeep/profile.learned.md', { updated: false, facts: '- x' });
    expect(out).toContain('No changes');
    expect(out).toContain('project');
    expect(out).toContain('- x');
  });
});

// ─── formatMeInitResult ───────────────────────────────────────────────────────
import { formatMeInitResult } from './helpers';

describe('formatMeInitResult', () => {
  it('renders the "created" message', () => {
    const out = formatMeInitResult('global', { created: true, path: '~/.codeep/profile.md' });
    expect(out).toContain('Created global profile');
    expect(out).toContain('~/.codeep/profile.md');
  });

  it('renders the "already exists" message for global scope', () => {
    const out = formatMeInitResult('global', { created: false, path: '~/.codeep/profile.md' });
    expect(out).toContain('Global profile already exists');
  });

  it('renders the "already exists" message for project scope', () => {
    const out = formatMeInitResult('project', { created: false, path: '.codeep/profile.md' });
    expect(out).toContain('Project profile already exists');
  });
});

// ─── formatSkillsShow ─────────────────────────────────────────────────────────
import { formatSkillsShow } from './helpers';

describe('formatSkillsShow', () => {
  it('renders the bundle detail view', () => {
    const out = formatSkillsShow({ name: 'commit', description: 'Commits changes', source: 'builtin', body: 'Run git commit' });
    expect(out).toContain('# commit');
    expect(out).toContain('_Commits changes_');
    expect(out).toContain('**Source:** builtin');
    expect(out).toContain('---');
    expect(out).toContain('Run git commit');
  });
});

// ─── formatSkillsBrowseEmpty ──────────────────────────────────────────────────
import { formatSkillsBrowseEmpty } from './helpers';

describe('formatSkillsBrowseEmpty', () => {
  it('shows the "no matches" message when a query is given', () => {
    expect(formatSkillsBrowseEmpty('git')).toBe('_No public skills matching "git"._');
  });

  it('shows the generic empty message when no query', () => {
    expect(formatSkillsBrowseEmpty('')).toBe('_No public skills published yet._');
  });
});

// ─── formatSkillsPublishResult ────────────────────────────────────────────────
import { formatSkillsPublishResult } from './helpers';

describe('formatSkillsPublishResult', () => {
  it('includes the slug and visibility', () => {
    const out = formatSkillsPublishResult('myskill', true, 'alice');
    expect(out).toContain('`myskill`');
    expect(out).toContain('public');
    expect(out).toContain('/skills install alice/myskill');
  });

  it('uses "private" when isPublic is false', () => {
    expect(formatSkillsPublishResult('s', false, 'bob')).toContain('private');
  });

  it('falls back to "<you>" when owner is undefined', () => {
    expect(formatSkillsPublishResult('s', true, undefined)).toContain('<you>/s');
  });

  it('falls back to "<you>" when owner is null', () => {
    expect(formatSkillsPublishResult('s', true, null)).toContain('<you>/s');
  });
});
