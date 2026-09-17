import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
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
  looksLikeKeyMaterial,
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

  it('resolves ./ and . against the root the caller passes, not process.cwd()', () => {
    // In ACP the server's cwd is not the workspace: `@dir .` walked the
    // server's directory (with none of the project's .gitignore rules).
    expect(process.cwd()).not.toBe(root);
    writeFileSync(join(root, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(root, 'local.ts'), 'export const local = 1;');
    writeFileSync(join(root, 'secret.txt'), 'tok_live_IGNORED');
    const file = expandMentions('@./local.ts', { root });
    expect(file.loaded.map((f) => f.fullPath)).toEqual([join(root, 'local.ts')]);
    expect(file.loaded[0].relativePath).toBe('local.ts');

    for (const form of ['.', './']) {
      const dir = expandFileAndFolderMentions(`see @dir ${form}`, { root });
      expect(dir.loaded.map((f) => f.relativePath), form).toEqual(['.gitignore', 'local.ts']);
      expect(dir.enrichedPrompt, form).not.toContain('tok_live_IGNORED');
      expect(dir.failures.map((f) => f.reason), form).toEqual([
        'skipped 1 ignored file; use /add to attach one deliberately',
      ]);
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

  it('refuses secret files inside an @dir / @folder walk too', () => {
    // The single-file guard above was never applied to directory walks, so
    // `@dir config` shipped the key that `@config/server.key` refuses.
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'app.yaml'), 'port: 3000');
    writeFileSync(join(root, 'config', 'server.key'), '-----BEGIN PRIVATE KEY-----');
    mkdirSync(join(root, 'deploy'));
    writeFileSync(join(root, 'deploy', 'run.sh'), 'echo deploy');
    writeFileSync(join(root, 'deploy', '.env.production'), 'DB_PASSWORD=hunter2');

    for (const expand of [expandFolderMentions, expandFileAndFolderMentions]) {
      const res = expand('check @dir config and @folder deploy', { root });
      expect(res.loaded.map((f) => f.relativePath).sort()).toEqual(
        [join('config', 'app.yaml'), join('deploy', 'run.sh')],
      );
      expect(res.enrichedPrompt).not.toContain('BEGIN PRIVATE KEY');
      expect(res.enrichedPrompt).not.toContain('hunter2');
    }
  });

  it('refuses secret files when @dir points outside the project', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'OPENSSH PRIVATE KEY');
    writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA');
    const project = join(root, 'project');
    mkdirSync(project);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const res = expandFileAndFolderMentions('look at @dir ~/.ssh', { root: project });
      expect(res.loaded.map((f) => f.fullPath)).toEqual([join(home, '.ssh', 'id_ed25519.pub')]);
      expect(res.enrichedPrompt).not.toContain('OPENSSH PRIVATE KEY');
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('honours .gitignore below the named directory', () => {
    writeFileSync(join(root, '.gitignore'), 'secrets.json\nlogs/\n');
    mkdirSync(join(root, 'deploy', 'logs'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'run.sh'), 'echo deploy');
    writeFileSync(join(root, 'deploy', 'secrets.json'), '{"token":"tok_live_123"}');
    writeFileSync(join(root, 'deploy', 'logs', 'today.txt'), 'request failed');

    const res = expandFolderMentions('check @dir deploy', { root });
    expect(res.loaded.map((f) => f.relativePath)).toEqual([join('deploy', 'run.sh')]);
    expect(res.enrichedPrompt).not.toContain('tok_live_123');
  });

  it('still walks a directory the user named even when it is ignored', () => {
    // Naming `@dir dist` (or `.codeep/agents`) is deliberate; ignore rules only
    // apply beneath it, like the built-in skip list. `generated/*` ignores the
    // contents rather than the directory, and must not empty the walk either.
    mkdirSync(join(root, 'generated', 'sub'), { recursive: true });
    writeFileSync(join(root, 'generated', 'api.ts'), 'export const api = 1;');
    writeFileSync(join(root, 'generated', 'sub', 'b.ts'), 'export const b = 1;');
    writeFileSync(join(root, 'generated', 'debug.log'), 'noise');
    mkdirSync(join(root, '.codeep', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codeep', 'agents', 'helper.md'), 'Help.');

    for (const form of ['generated/', 'generated/*', 'generated/**', '/generated/*']) {
      writeFileSync(join(root, '.gitignore'), `${form}\n*.log\n`);
      const res = expandFolderMentions('see @dir generated and @dir .codeep/agents', { root });
      expect(res.loaded.map((f) => f.relativePath), form).toEqual([
        join('generated', 'api.ts'),
        join('generated', 'sub', 'b.ts'),
        join('.codeep', 'agents', 'helper.md'),
      ]);
      // The other rules still apply beneath it, and say so.
      expect(res.failures.map((f) => f.reason), form).toEqual([
        'skipped 1 ignored file; use /add to attach one deliberately',
      ]);
    }
  });

  it('says how many files and folders a walk skipped and why', () => {
    // Build output below the named directory and secrets used to vanish
    // without a word, leaving only "Loaded N file(s)" or "no source files".
    mkdirSync(join(root, 'app', 'target'), { recursive: true });
    writeFileSync(join(root, 'app', 'target', 'Main.java'), 'class Main {}');
    mkdirSync(join(root, 'src', 'out'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'out', 'gen.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'server.key'), 'key');
    writeFileSync(join(root, '.gitignore'), '*.log\n');
    writeFileSync(join(root, 'src', 'a.log'), 'noise');
    writeFileSync(join(root, 'src', 'b.log'), 'noise');
    mkdirSync(join(root, 'src', 'node_modules'));
    writeFileSync(join(root, 'src', 'node_modules', 'dep.ts'), 'dep'); // always quiet

    for (const expand of [expandFolderMentions, expandFileAndFolderMentions]) {
      const res = expand('check @dir app and @dir src', { root });
      expect(res.loaded.map((f) => f.relativePath)).toEqual([join('src', 'index.ts')]);
      expect(res.failures).toEqual([
        // `target/` holds a file but is one folder.
        { mention: '@dir app', reason: 'no source files found; skipped 1 ignored folder; use /add to attach one deliberately' },
        { mention: '@dir src', reason: 'skipped 1 secret-looking file, 2 ignored files, 1 ignored folder; use /add to attach one deliberately' },
      ]);
    }
  });

  it('refuses private keys whatever they are called', () => {
    // Keys are commonly saved as `~/.ssh/github` or `id_ed25519_work`, which no
    // name pattern listed, so `@dir ~/.ssh` still shipped them.
    const armour = (kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----`;
    mkdirSync(join(root, 'keys'));
    writeFileSync(join(root, 'keys', 'github'), `${armour('OPENSSH ')}\nb3BlbnNzaC1rZXktdjEAAAAA\n`);
    writeFileSync(join(root, 'keys', 'id_ed25519_work'), 'unrecognised body');
    writeFileSync(join(root, 'keys', 'id_ed25519_work.pub'), 'ssh-ed25519 AAAA work');
    writeFileSync(join(root, 'keys', 'sa.json'), `{"type":"service_account","private_key":"${armour('')}\\nMIIEvQ\\n"}`);
    writeFileSync(join(root, 'keys', 'deploy.txt'), `Bag Attributes\n    localKeyID: 01\n${armour('ENCRYPTED ')}\nMIIE\n`);
    writeFileSync(join(root, 'keys', 'readme.md'), 'Keys live here.');
    writeFileSync(join(root, 'keys', 'backup.asc'), '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBFPGPSECRET\n');
    writeFileSync(join(root, 'keys', 'session.txt'), 'PuTTY-User-Key-File-3: ssh-ed25519\nPUTTYSECRET\n');
    writeFileSync(join(root, 'keys', 'work.ppk'), 'nothing a content check would catch');
    // A key further into the file than the first 8 KB.
    writeFileSync(join(root, 'keys', 'late.json'), `{"pad":"${'x'.repeat(9000)}","private_key":"${armour('')}\\r\\nLATEKEYSECRET\\r\\n"}`);

    const res = expandFileAndFolderMentions('look at @dir keys', { root });
    expect(res.loaded.map((f) => f.relativePath)).toEqual([
      join('keys', 'id_ed25519_work.pub'),
      join('keys', 'readme.md'),
    ]);
    expect(res.enrichedPrompt).not.toContain('PRIVATE KEY');
    expect(res.enrichedPrompt).not.toMatch(/PGPSECRET|PUTTYSECRET|LATEKEYSECRET/);
    expect(res.failures.map((f) => f.reason)).toEqual([
      'skipped 8 secret-looking files; use /add to attach one deliberately',
    ]);

    for (const name of ['github', 'sa.json', 'deploy.txt', 'id_ed25519_work', 'backup.asc', 'session.txt', 'work.ppk', 'late.json']) {
      const one = expandMentions(`check @keys/${name}`, { root });
      expect(one.loaded, name).toHaveLength(0);
      expect(one.failures[0]?.reason, name).toMatch(/secrets file/);
    }
  });

  it('refuses plaintext credential files from common tools', () => {
    const home = mkdtempSync(join(tmpdir(), 'codeep-cred-home-'));
    try {
      const files: Record<string, string> = {
        '.git-credentials': 'https://me:ghp_TOKEN1@github.com',
        '.pypirc': '[pypi]\npassword = TOKEN2',
        '.dockercfg': '{"auths":{}}',
        '.docker/config.json': '{"auths":{"x":{"auth":"TOKEN3"}}}',
        '.kube/config': 'users:\n- user:\n    token: TOKEN4',
        '.config/gh/hosts.yml': 'github.com:\n    oauth_token: TOKEN5',
      };
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(home, rel, '..'), { recursive: true });
        writeFileSync(join(home, rel), body);
        const one = expandMentions(`look at @${join(home, rel)}`, { root });
        expect(one.loaded, rel).toHaveLength(0);
        expect(one.failures[0]?.reason, rel).toMatch(/secrets file/);
      }
      const walk = expandFolderMentions(`see @dir ${home}`, { root });
      expect(walk.enrichedPrompt).not.toMatch(/TOKEN\d/);
      // An ordinary config.json elsewhere is still fine.
      mkdirSync(join(root, 'app'), { recursive: true });
      writeFileSync(join(root, 'app', 'config.json'), '{"port":3000}');
      expect(expandMentions('check @app/config.json', { root }).loaded).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recognises a whole key block written the way code and config write it', () => {
    const kind = 'RSA ';
    const begin = `-----BEGIN ${kind}PRIVATE KEY-----`;
    const end = `-----END ${kind}PRIVATE KEY-----`;
    const b1 = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
    const b2 = 'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK';
    const shapes: Record<string, string> = {
      'one YAML line': `private_key: ${begin} ${b1} ${b2} ${end}`,
      'concatenated literals': `const key =\n  "${begin}\\n" +\n  "${b1}\\n" +\n  "${b2}\\n" +\n  "${end}";`,
      'joined array': `const key = [\n  '${begin}',\n  '${b1}',\n  '${b2}',\n  '${end}',\n].join('\\n');`,
      'double-escaped JSON': `{"cfg":"{\\"key\\":\\"${begin}\\\\n${b1}\\\\n${b2}\\\\n${end}\\"}"}`,
      'body glued to the armour': `${begin}${b1}${b2}${end}`,
      'PGP with escaped slashes': `{"k":"-----BEGIN PGP PRIVATE KEY BLOCK-----\\nComment: https:\\/\\/example.com\\/key\\n\\n${b1}\\n${b2}\\n-----END PGP PRIVATE KEY BLOCK-----"}`,
    };
    for (const [name, text] of Object.entries(shapes)) {
      expect(looksLikeKeyMaterial(text), name).toBe(true);
    }
  });

  it('does not take a placeholder or a template for a key block', () => {
    const begin = '-----BEGIN ' + 'PRIVATE KEY-----';
    const end = '-----END PRIVATE KEY-----';
    for (const text of [
      `${begin} ${'x'.repeat(64)} ${end}`,
      `${begin}\n<paste your key here>\n${end}`,
      `const pem = \`${begin}\n\${body}\n${end}\`;`,
      `wrap = (b) => '${begin}\\n' + b + '\\n${end}'`,
      // Prose after the armour: stripped of spaces it looks like base64.
      'A PKCS#8 file opens with `' + begin + '` and the lines that follow hold the DER bytes in base64.',
    ]) {
      expect(looksLikeKeyMaterial(text), text.slice(0, 60)).toBe(false);
    }
  });

  it('stays fast on a file full of armour lines with no end', () => {
    const text = ('-----BEGIN ' + 'PRIVATE KEY-----\n').repeat(6000);
    const started = Date.now();
    looksLikeKeyMaterial(text);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('loads code and docs that only name the key armour', () => {
    // TLS, JWT and SSH code quotes the header, builds PEM around a variable or
    // documents the format; none of that holds a key.
    const armour = (kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----`;
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'pem.test.ts'), `const fixture = "${armour('RSA ')}";\nexport function parse() {}\n`);
    writeFileSync(join(root, 'src', 'wrap.ts'), [
      `export const wrap = (body: string) => '${armour('')}\\n' + body + '\\n-----END PRIVATE KEY-----';`,
      'export const wrap2 = (b64: string) => `' + armour('EC ') + '\n${b64}\n-----END EC PRIVATE KEY-----`;',
      `export const RE = /${armour('(?:RSA )?')}/;`,
    ].join('\n'));
    writeFileSync(join(root, 'src', 'keys.md'), [
      'A key file starts with `' + armour('OPENSSH ') + '`:',
      '```',
      armour('OPENSSH '),
      '...',
      '-----END OPENSSH PRIVATE KEY-----',
      '```',
    ].join('\n'));

    const names = ['keys.md', 'pem.test.ts', 'wrap.ts'];
    const res = expandFileAndFolderMentions('look at @dir src', { root });
    expect(res.loaded.map((f) => f.relativePath)).toEqual(names.map((n) => join('src', n)));
    expect(res.failures).toEqual([]);
    for (const name of names) {
      expect(expandMentions(`check @src/${name}`, { root }).loaded, name).toHaveLength(1);
    }
  });

  it('refuses a named directory that links out of the project', () => {
    // `@docs/.zsh_history` was refused, but `@dir docs` with `docs -> ~` walked
    // the whole home directory. A sibling whose name starts with the
    // project's (`<root>-secrets`) is outside too.
    const outside = mkdtempSync(join(tmpdir(), 'codeep-mentions-home-'));
    const sibling = `${root}-secrets`;
    try {
      mkdirSync(join(outside, '.config', 'gh'), { recursive: true });
      writeFileSync(join(outside, '.zsh_history'), 'export TOKEN=HISTSECRET');
      writeFileSync(join(outside, '.config', 'gh', 'hosts.yml'), 'oauth_token: GHTOKENSECRET');
      mkdirSync(sibling);
      writeFileSync(join(sibling, 'x.txt'), 'SIBLINGSECRET');
      symlinkSync(outside, join(root, 'docs'));
      symlinkSync(sibling, join(root, 'sib'));
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes', 'a.md'), 'Notes.');
      symlinkSync(join(sibling, 'x.txt'), join(root, 'notes', 'sib.md'));

      for (const expand of [expandFolderMentions, expandFileAndFolderMentions]) {
        const res = expand('see @dir docs, @dir ./docs, @dir docs/.config, @dir sib and @dir notes', { root });
        expect(res.loaded.map((f) => f.relativePath)).toEqual([join('notes', 'a.md')]);
        expect(res.enrichedPrompt).not.toMatch(/HISTSECRET|GHTOKENSECRET|SIBLINGSECRET/);
        expect(res.failures).toEqual([
          { mention: '@dir docs', reason: 'links outside the project — use /add to attach it deliberately' },
          { mention: '@dir ./docs', reason: 'links outside the project — use /add to attach it deliberately' },
          { mention: '@dir docs/.config', reason: 'links outside the project — use /add to attach it deliberately' },
          { mention: '@dir sib', reason: 'links outside the project — use /add to attach it deliberately' },
          { mention: '@dir notes', reason: 'skipped 1 file linked from outside the project; use /add to attach one deliberately' },
        ]);
      }
      const one = expandMentions('check @notes/sib.md', { root });
      expect(one.loaded).toHaveLength(0);
      expect(one.failures[0]?.reason).toMatch(/links outside the project/);

      // Naming the outside directory itself is still a deliberate choice
      // (the gh token file in it is a credential and stays out).
      mkdirSync(join(outside, '.config', 'app'), { recursive: true });
      writeFileSync(join(outside, '.config', 'app', 'settings.yml'), 'theme: dark');
      const direct = expandFolderMentions(`see @dir ${join(outside, '.config')}`, { root });
      expect(direct.loaded.map((f) => f.fullPath)).toEqual([join(outside, '.config', 'app', 'settings.yml')]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('judges a symlink by the file it points at', () => {
    // A cloned repo can commit innocent-looking links to secrets: statSync and
    // readFileSync follow them, while the name check only saw the link.
    writeFileSync(join(root, '.env'), 'STRIPE_KEY=sk_live_SYMLINK');
    mkdirSync(join(root, 'cfgdir'));
    writeFileSync(join(root, 'cfgdir', 'app.yaml'), 'port: 3000');
    symlinkSync(join('..', '.env'), join(root, 'cfgdir', 'settings.yaml'));
    symlinkSync('.env', join(root, 'notes.md'));
    const outside = mkdtempSync(join(tmpdir(), 'codeep-mentions-outside-'));
    try {
      writeFileSync(join(outside, 'history.txt'), 'export TOKEN=hunter2');
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'docs', 'guide.md'), 'Read me.');
      symlinkSync(join(outside, 'history.txt'), join(root, 'docs', 'shell.md'));
      symlinkSync(outside, join(root, 'docs', 'more'));
      // A link that stays inside the project is fine.
      symlinkSync(join('..', 'cfgdir', 'app.yaml'), join(root, 'docs', 'app.yaml'));

      const res = expandFileAndFolderMentions('check @dir cfgdir and @dir docs', { root });
      expect(res.loaded.map((f) => f.relativePath)).toEqual([
        join('cfgdir', 'app.yaml'),
        join('docs', 'app.yaml'),
        join('docs', 'guide.md'),
      ]);
      expect(res.enrichedPrompt).not.toContain('sk_live_SYMLINK');
      expect(res.enrichedPrompt).not.toContain('hunter2');
      expect(res.failures.map((f) => f.reason)).toEqual([
        'skipped 1 secret-looking file; use /add to attach one deliberately',
        'skipped 1 file linked from outside the project, 1 folder linked from outside the project; use /add to attach one deliberately',
      ]);

      expect(expandMentions('check @notes.md', { root }).failures[0]?.reason).toMatch(/secrets file/);
      const shell = expandMentions('check @docs/shell.md', { root });
      expect(shell.loaded).toHaveLength(0);
      expect(shell.failures[0]?.reason).toMatch(/links outside the project/);
      // Naming a file outside the project directly is still allowed.
      expect(expandMentions(`check @${join(outside, 'history.txt')}`, { root }).loaded).toHaveLength(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps committed env templates readable', () => {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', '.env.example'), 'STRIPE_KEY=');
    writeFileSync(join(root, 'config', '.env.sample'), 'DB_URL=');
    writeFileSync(join(root, 'config', '.env.production.local'), 'DB_PASSWORD=hunter2');
    const res = expandFolderMentions('check @dir config', { root });
    expect(res.loaded.map((f) => f.relativePath)).toEqual([
      join('config', '.env.example'),
      join('config', '.env.sample'),
    ]);
    // A single mention is refused as it was before walks learned about
    // secrets: a template can still hold a real value.
    writeFileSync(join(root, 'config', '.env.template'), 'API_KEY=sk_live_REALINTEMPLATE');
    symlinkSync('.env.template', join(root, 'config', 'env.txt'));
    for (const name of ['.env.example', '.env.sample', '.env.template', 'env.txt']) {
      const one = expandMentions(`check @config/${name}`, { root });
      expect(one.loaded, name).toHaveLength(0);
      expect(one.failures[0]?.reason, name).toMatch(/secrets file/);
      expect(one.enrichedPrompt, name).not.toContain('sk_live_REALINTEMPLATE');
    }
  });

  it('does not let an oversized .gitignore stall or steer a walk', () => {
    // The rules are loaded on every @dir. A committed `.gitignore ->
    // /dev/zero` never finished reading; an oversized file is refused the
    // same way, before it is read.
    writeFileSync(join(root, '.gitignore'), `${'#'.repeat(2 * 1024 * 1024)}\n*.ts\n`);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
    const res = expandFolderMentions('see @dir src', { root });
    expect(res.loaded.map((f) => f.relativePath)).toEqual([join('src', 'a.ts')]);
  });
});
