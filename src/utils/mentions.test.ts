import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractMentions,
  expandMentions,
  formatFileBlock,
  suggestMentions,
  clearSuggestionCache,
  extractFolderMentions,
  expandFolderMentions,
  expandFileAndFolderMentions,
  extractGitMentions,
  MAX_MENTION_BYTES,
} from './mentions';

// ─── Test sandbox ─────────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-mentions-'));
  clearSuggestionCache(); // each test gets a fresh listing
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── extractMentions (pure) ───────────────────────────────────────────────────

describe('extractMentions', () => {
  it('extracts a simple relative mention', () => {
    const tokens = extractMentions('fix @src/index.ts');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('src/index.ts');
    expect(tokens[0].raw).toBe('@src/index.ts');
  });

  it('extracts an absolute mention', () => {
    const tokens = extractMentions('see @/etc/hosts');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/etc/hosts');
  });

  it('extracts a ./relative mention', () => {
    const tokens = extractMentions('@./local.ts is wrong');
    expect(tokens[0].path).toBe('./local.ts');
  });

  it('extracts a double-quoted mention with spaces', () => {
    const tokens = extractMentions('check @"my file.ts"');
    expect(tokens[0].path).toBe('my file.ts');
  });

  it('extracts a single-quoted mention', () => {
    const tokens = extractMentions("check @'my file.ts'");
    expect(tokens[0].path).toBe('my file.ts');
  });

  it('extracts multiple mentions in order', () => {
    const tokens = extractMentions('@a.ts and @b.ts and @c.ts');
    expect(tokens.map((t) => t.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('ignores a bare @ with no path', () => {
    expect(extractMentions('email me at @')).toEqual([]);
  });

  it('does not match an email address (user@host)', () => {
    expect(extractMentions('contact user@host.com')).toEqual([]);
  });

  it('does not match a GitHub handle mid-sentence', () => {
    expect(extractMentions('ping @octocat about it')).toEqual([]);
  });

  it('matches a @ at the start of the string', () => {
    const tokens = extractMentions('@start.ts');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('start.ts');
  });

  it('matches a @ after whitespace, brackets, and punctuation', () => {
    for (const sep of [' ', '\t', '\n', '(', '[', '{', '<', ',', ';']) {
      const tokens = extractMentions(`${sep}@x.ts`);
      expect(tokens, `separator ${JSON.stringify(sep)}`).toHaveLength(1);
    }
  });

  it('does not match a @ after a word character', () => {
    expect(extractMentions('foo@bar.ts')).toEqual([]);
  });

  it('returns an empty array for text with no mentions', () => {
    expect(extractMentions('just a normal prompt')).toEqual([]);
  });
});

// ─── expandMentions ───────────────────────────────────────────────────────────

describe('expandMentions', () => {
  it('returns the prompt unchanged when there are no mentions', () => {
    const r = expandMentions('hello world', { root });
    expect(r.enrichedPrompt).toBe('hello world');
    expect(r.loaded).toEqual([]);
    expect(r.failures).toEqual([]);
  });

  it('loads a mentioned file and prepends its contents', () => {
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;\n');
    const r = expandMentions('review @index.ts', { root });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0].relativePath).toBe('index.ts');
    expect(r.loaded[0].content).toBe('export const x = 1;\n');
    expect(r.enrichedPrompt).toContain('[Attached files]');
    expect(r.enrichedPrompt).toContain('File: index.ts');
    expect(r.enrichedPrompt).toContain('export const x = 1;');
    // The visible prompt should have the @ stripped.
    expect(r.enrichedPrompt).toContain('review index.ts');
  });

  it('strips the @ but keeps the path in the visible prompt', () => {
    writeFileSync(join(root, 'a.ts'), 'a');
    const r = expandMentions('fix @a.ts now', { root });
    expect(r.enrichedPrompt).toContain('fix a.ts now');
    expect(r.enrichedPrompt).not.toContain('@a.ts');
  });

  it('dedupes repeated mentions of the same file', () => {
    writeFileSync(join(root, 'a.ts'), 'a');
    const r = expandMentions('@a.ts and @a.ts again', { root });
    expect(r.loaded).toHaveLength(1);
  });

  it('resolves a path in a subdirectory', () => {
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    writeFileSync(join(root, 'src', 'utils', 'helper.ts'), 'export const h = 1;\n');
    const r = expandMentions('check @src/utils/helper.ts', { root });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0].relativePath).toBe(['src', 'utils', 'helper.ts'].join('/'));
  });

  it('resolves a ./relative path against cwd', () => {
    writeFileSync(join(process.cwd(), 'cwd-local.ts'), 'cwd');
    try {
      const r = expandMentions('@./cwd-local.ts', { root });
      expect(r.loaded).toHaveLength(1);
    } finally {
      rmSync(join(process.cwd(), 'cwd-local.ts'), { force: true });
    }
  });

  it('reports a failure for a missing file', () => {
    const r = expandMentions('@nope.ts', { root });
    expect(r.loaded).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].mention).toBe('@nope.ts');
    expect(r.failures[0].reason).toBe('file not found');
  });

  it('reports a failure when the path is a directory', () => {
    mkdirSync(join(root, 'sub.dir'));
    const r = expandMentions('@sub.dir', { root });
    expect(r.failures[0].reason).toBe('not a file');
  });

  it('reports a failure when the file is too large', () => {
    const big = 'x'.repeat(MAX_MENTION_BYTES + 1);
    writeFileSync(join(root, 'big.ts'), big);
    const r = expandMentions('@big.ts', { root });
    expect(r.loaded).toEqual([]);
    expect(r.failures[0].reason).toContain('too large');
  });

  it('handles a mix of valid and invalid mentions', () => {
    writeFileSync(join(root, 'ok.ts'), 'ok');
    const r = expandMentions('@ok.ts and @missing.ts', { root });
    expect(r.loaded).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].mention).toBe('@missing.ts');
  });

  it('rejects a binary file (NUL byte)', () => {
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const r = expandMentions('@bin.dat', { root });
    expect(r.loaded).toEqual([]);
    expect(r.failures[0].reason).toContain('could not read');
  });
});

// ─── formatFileBlock ──────────────────────────────────────────────────────────

describe('formatFileBlock', () => {
  it('returns an empty string for no files', () => {
    expect(formatFileBlock([])).toBe('');
  });

  it('formats a single file with a code fence', () => {
    const out = formatFileBlock([{ relativePath: 'a.ts', content: 'const x = 1;' }]);
    expect(out).toContain('[Attached files]');
    expect(out).toContain('File: a.ts');
    expect(out).toContain('```\nconst x = 1;\n```');
  });

  it('formats multiple files in order', () => {
    const out = formatFileBlock([
      { relativePath: 'a.ts', content: 'a' },
      { relativePath: 'b.ts', content: 'b' },
    ]);
    expect(out).toContain('File: a.ts');
    expect(out).toContain('File: b.ts');
    expect(out.indexOf('a.ts')).toBeLessThan(out.indexOf('b.ts'));
  });

  it('ends with a blank line separator', () => {
    const out = formatFileBlock([{ relativePath: 'a.ts', content: 'a' }]);
    expect(out.endsWith('\n\n')).toBe(true);
  });
});

// ─── suggestMentions ──────────────────────────────────────────────────────────

describe('suggestMentions', () => {
  beforeEach(() => {
    // Build a small fixture tree.
    writeFileSync(join(root, 'index.ts'), 'x');
    writeFileSync(join(root, 'readme.md'), 'x');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'x');
    writeFileSync(join(root, 'src', 'util.ts'), 'x');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'x');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), 'x');
  });

  it('returns source files relative to root', () => {
    const out = suggestMentions({ root });
    const labels = out.map((s) => s.label);
    expect(labels).toContain('index.ts');
    expect(labels).toContain('src/app.ts');
  });

  it('skips node_modules and .git', () => {
    const out = suggestMentions({ root });
    const labels = out.map((s) => s.label);
    expect(labels.some((l) => l.includes('node_modules'))).toBe(false);
    expect(labels.some((l) => l.includes('.git'))).toBe(false);
  });

  it('filters by the query prefix (case-insensitive substring)', () => {
    const out = suggestMentions({ root, query: 'app' });
    expect(out.every((s) => s.label.toLowerCase().includes('app'))).toBe(true);
    expect(out.some((s) => s.label === 'src/app.ts')).toBe(true);
  });

  it('respects the limit', () => {
    const out = suggestMentions({ root, limit: 2 });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it('sets the detail to the file directory', () => {
    const out = suggestMentions({ root });
    const app = out.find((s) => s.label === 'src/app.ts');
    expect(app?.detail).toBe('src');
  });

  it('skips binary extensions', () => {
    writeFileSync(join(root, 'logo.png'), 'x');
    const out = suggestMentions({ root });
    expect(out.some((s) => s.label === 'logo.png')).toBe(false);
  });

  it('returns an empty array for an empty root', () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      expect(suggestMentions({ root: empty })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not throw on a nonexistent root', () => {
    expect(() => suggestMentions({ root: join(root, 'does-not-exist') })).not.toThrow();
  });
});

// ─── @folder mentions ─────────────────────────────────────────────────────────

describe('extractFolderMentions', () => {
  it('extracts @folder with a path', () => {
    const tokens = extractFolderMentions('check @folder src/components');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('src/components');
  });

  it('extracts @dir as an alias', () => {
    const tokens = extractFolderMentions('@dir src/lib');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('src/lib');
  });

  it('extracts a quoted path', () => {
    const tokens = extractFolderMentions('@folder "my components"');
    expect(tokens[0].path).toBe('my components');
  });

  it('extracts multiple @folder mentions', () => {
    const tokens = extractFolderMentions('@folder a and @folder b');
    expect(tokens.map((t) => t.path)).toEqual(['a', 'b']);
  });

  it('does not match @folders (plural word)', () => {
    expect(extractFolderMentions('@folders are here')).toEqual([]);
  });

  it('does not match @folder without a path', () => {
    expect(extractFolderMentions('@folder')).toEqual([]);
  });

  it('strips the @folder token start at the @', () => {
    const tokens = extractFolderMentions('check @folder src/x');
    expect(tokens[0].raw).toBe('@folder src/x');
  });
});

describe('expandFolderMentions', () => {
  beforeEach(() => {
    // Build a small tree for the fixtures.
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    writeFileSync(join(root, 'src', 'components', 'Button.ts'), 'btn');
    writeFileSync(join(root, 'src', 'components', 'Card.ts'), 'card');
    writeFileSync(join(root, 'src', 'utils', 'format.ts'), 'fmt');
    // Ignored dirs should be skipped.
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'src', 'node_modules', 'dep.ts'), 'dep');
    // Binary ext should be skipped.
    writeFileSync(join(root, 'src', 'components', 'logo.png'), 'x');
  });

  it('loads all source files in a directory', () => {
    const r = expandFolderMentions('review @folder src/components', { root });
    expect(r.loaded).toHaveLength(2);
    const paths = r.loaded.map((f) => f.relativePath).sort();
    expect(paths).toEqual(['src/components/Button.ts', 'src/components/Card.ts']);
    expect(r.enrichedPrompt).toContain('[Attached files]');
    expect(r.enrichedPrompt).toContain('btn');
    expect(r.enrichedPrompt).toContain('card');
    expect(r.enrichedPrompt).not.toContain('@folder');
  });

  it('recurses into subdirectories', () => {
    const r = expandFolderMentions('@folder src', { root });
    // Button.ts, Card.ts, format.ts (node_modules + .png skipped).
    expect(r.loaded).toHaveLength(3);
  });

  it('skips node_modules', () => {
    const r = expandFolderMentions('@folder src', { root });
    expect(r.loaded.some((f) => f.relativePath.includes('node_modules'))).toBe(false);
  });

  it('skips binary extensions', () => {
    const r = expandFolderMentions('@folder src/components', { root });
    expect(r.loaded.some((f) => f.relativePath.endsWith('.png'))).toBe(false);
  });

  it('reports a failure for a missing directory', () => {
    const r = expandFolderMentions('@folder nonexistent', { root });
    expect(r.loaded).toEqual([]);
    expect(r.failures[0].reason).toBe('directory not found');
  });

  it('reports a failure when the path is a file', () => {
    writeFileSync(join(root, 'file.ts'), 'x');
    const r = expandFolderMentions('@folder file.ts', { root });
    expect(r.failures[0].reason).toContain('not a directory');
  });

  it('reports a failure when the directory has no source files', () => {
    mkdirSync(join(root, 'empty'), { recursive: true });
    const r = expandFolderMentions('@folder empty', { root });
    expect(r.failures[0].reason).toContain('no source files');
  });

  it('sorts files deterministically', () => {
    const r = expandFolderMentions('@folder src/components', { root });
    const paths = r.loaded.map((f) => f.relativePath);
    expect(paths).toEqual([...paths].sort());
  });

  it('caps total content at MAX_FOLDER_BYTES', () => {
    // Create a directory with files that individually fit but together
    // exceed the per-mention cap.
    mkdirSync(join(root, 'big'), { recursive: true });
    // MAX_FOLDER_BYTES is 200KB; MAX_MENTION_BYTES is 100KB. Use 80KB
    // files so three of them (240KB) exceed the cap.
    const big = 'x'.repeat(80 * 1024);
    writeFileSync(join(root, 'big', 'a.ts'), big);
    writeFileSync(join(root, 'big', 'b.ts'), big);
    writeFileSync(join(root, 'big', 'c.ts'), big);
    const r = expandFolderMentions('@folder big', { root });
    // The cap fires at ~200KB, so 2 files load (160KB) and the 3rd tips over.
    expect(r.loaded.length).toBeGreaterThanOrEqual(2);
    expect(r.failures.some((f) => f.reason.includes('cap'))).toBe(true);
  });
});

describe('expandFileAndFolderMentions', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    writeFileSync(join(root, 'src', 'components', 'Button.ts'), 'btn');
    writeFileSync(join(root, 'src', 'index.ts'), 'root');
  });

  it('merges @folder and @file into one [Attached files] block', () => {
    const r = expandFileAndFolderMentions(
      'review @folder src/components and @src/index.ts',
      { root },
    );
    expect(r.loaded).toHaveLength(2);
    const paths = r.loaded.map((f) => f.relativePath).sort();
    expect(paths).toEqual(['src/components/Button.ts', 'src/index.ts']);
    // Only one [Attached files] header.
    const blockCount = (r.enrichedPrompt.match(/\[Attached files\]/g) ?? []).length;
    expect(blockCount).toBe(1);
  });

  it('handles @folder alone', () => {
    const r = expandFileAndFolderMentions('@folder src/components', { root });
    expect(r.loaded).toHaveLength(1);
  });

  it('handles @file alone', () => {
    const r = expandFileAndFolderMentions('@src/index.ts', { root });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0].relativePath).toBe('src/index.ts');
  });

  it('returns the prompt unchanged when no mentions', () => {
    const r = expandFileAndFolderMentions('hello world', { root });
    expect(r.enrichedPrompt).toBe('hello world');
    expect(r.loaded).toEqual([]);
  });

  it('collects failures from both kinds', () => {
    const r = expandFileAndFolderMentions(
      '@folder missing @src/absent.ts',
      { root },
    );
    expect(r.failures.length).toBe(2);
  });
});

// ─── @git mention extraction (pure) ─────────────────────────────────────────

describe('extractGitMentions', () => {
  it('extracts a simple @git ref', () => {
    const tokens = extractGitMentions('review @git HEAD');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].ref).toBe('HEAD');
  });

  it('extracts @git diff', () => {
    expect(extractGitMentions('@git diff')[0].ref).toBe('diff');
  });

  it('extracts @git diff --staged', () => {
    expect(extractGitMentions('@git diff --staged')[0].ref).toBe('diff --staged');
  });

  it('extracts a file-at-ref', () => {
    expect(extractGitMentions('@git main:src/x.ts')[0].ref).toBe('main:src/x.ts');
  });

  it('extracts a SHA', () => {
    expect(extractGitMentions('@git abc1234')[0].ref).toBe('abc1234');
  });

  it('extracts a quoted ref with spaces', () => {
    expect(extractGitMentions('@git "diff HEAD~3"')[0].ref).toBe('diff HEAD~3');
  });

  it('extracts multiple @git mentions', () => {
    const tokens = extractGitMentions('@git diff and @git HEAD');
    expect(tokens.map((t) => t.ref)).toEqual(['diff', 'HEAD']);
  });

  it('does not match @github (longer word)', () => {
    expect(extractGitMentions('see @github/user/repo')).toEqual([]);
  });

  it('does not match @git without a ref', () => {
    expect(extractGitMentions('just @git')).toEqual([]);
  });

  it('does not match @git inside an email address', () => {
    expect(extractGitMentions('user@git.example.com')).toEqual([]);
  });

  it('strips the @git token start at the @', () => {
    const tokens = extractGitMentions('review @git HEAD');
    expect(tokens[0].raw).toBe('@git HEAD');
  });

  it('records byte offsets for prompt stripping', () => {
    const text = 'check @git HEAD now';
    const tokens = extractGitMentions(text);
    expect(tokens).toHaveLength(1);
    // Stripping the token range and replacing with the bare ref should
    // leave a coherent sentence.
    const stripped = text.slice(0, tokens[0].start) + tokens[0].ref + text.slice(tokens[0].end);
    expect(stripped).toBe('check HEAD now');
  });
});

// ─── Regressions ──────────────────────────────────────────────────────────────

describe('mention expansion — regressions', () => {
  it('attaches each mentioned file exactly once', () => {
    // The merged file+folder path used to strip its own `[Attached files]`
    // block back out of the enriched prompt with a lazy regex. That removed
    // only the header and left the bodies, so the re-formatted block appended
    // every file a second time — doubling the token cost of every mention.
    writeFileSync(join(root, 'a.ts'), 'export const A = 1;');
    const out = expandFileAndFolderMentions('review @a.ts please', { root }).enrichedPrompt;
    expect(out.match(/\[Attached files\]/g)).toHaveLength(1);
    expect(out.match(/File: a\.ts/g)).toHaveLength(1);
    expect(out.match(/export const A = 1;/g)).toHaveLength(1);
  });

  it('exposes a block-free strippedPrompt alongside the enriched one', () => {
    writeFileSync(join(root, 'a.ts'), 'export const A = 1;');
    const res = expandMentions('review @a.ts please', { root });
    expect(res.strippedPrompt).toBe('review a.ts please');
    expect(res.strippedPrompt).not.toContain('[Attached files]');
  });

  it('refuses to auto-inline secret files', () => {
    // Mentions can come from pasted text (an issue body, a log, model output),
    // so silently inlining `@.env` would ship credentials to the provider.
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-secret-123');
    writeFileSync(join(root, 'server.pem'), '-----BEGIN PRIVATE KEY-----');
    writeFileSync(join(root, 'id_rsa'), 'ssh-private');

    for (const name of ['.env', 'server.pem', 'id_rsa']) {
      const res = expandMentions(`check @${name}`, { root });
      expect(res.loaded).toHaveLength(0);
      expect(res.failures[0]?.reason).toMatch(/secrets file/);
      expect(res.enrichedPrompt).not.toContain('sk-secret-123');
      expect(res.enrichedPrompt).not.toContain('BEGIN PRIVATE KEY');
    }

    // ...but ordinary source files are unaffected.
    writeFileSync(join(root, 'ok.ts'), 'export const x = 1;');
    expect(expandMentions('check @ok.ts', { root }).loaded).toHaveLength(1);
  });
});
