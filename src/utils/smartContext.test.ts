import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractTargetFile,
  formatSmartContext,
  gatherSmartContext,
  clearImportResolutionCache,
  SmartContextResult,
  RelatedFile,
} from './smartContext';
import type { ProjectContext } from './project';

// ---------------------------------------------------------------------------
// Helper to build a SmartContextResult quickly
// ---------------------------------------------------------------------------
function makeContext(
  files: Array<Partial<RelatedFile> & { relativePath: string }>,
  overrides?: Partial<SmartContextResult>,
): SmartContextResult {
  const fullFiles: RelatedFile[] = files.map((f) => ({
    path: f.path ?? `/project/${f.relativePath}`,
    relativePath: f.relativePath,
    reason: f.reason ?? 'test reason',
    priority: f.priority ?? 5,
    content: f.content, // may be undefined
    size: f.size ?? (f.content ? f.content.length : 0),
  }));

  return {
    files: fullFiles,
    totalSize: overrides?.totalSize ?? fullFiles.reduce((s, f) => s + (f.content?.length ?? 0), 0),
    truncated: overrides?.truncated ?? false,
  };
}

// ===========================================================================
// extractTargetFile
// ===========================================================================
describe('extractTargetFile', () => {
  // ---- Action-verb patterns (edit, modify, update, change, fix) ----------
  describe('action verb patterns', () => {
    it('should extract file from "edit <file>"', () => {
      expect(extractTargetFile('edit src/utils/helper.ts')).toBe('src/utils/helper.ts');
    });

    it('should extract file from "modify the file <file>"', () => {
      expect(extractTargetFile('modify the file src/index.js')).toBe('src/index.js');
    });

    it('should extract file from "update <file>"', () => {
      expect(extractTargetFile('update config/settings.json')).toBe('config/settings.json');
    });

    it('should extract file from "change <file>"', () => {
      expect(extractTargetFile('change lib/core.ts')).toBe('lib/core.ts');
    });

    it('should extract file from "fix <file>"', () => {
      expect(extractTargetFile('fix src/api/endpoint.ts')).toBe('src/api/endpoint.ts');
    });

    it('should be case-insensitive for action verbs', () => {
      expect(extractTargetFile('Edit src/utils/helper.ts')).toBe('src/utils/helper.ts');
      expect(extractTargetFile('MODIFY src/utils/helper.ts')).toBe('src/utils/helper.ts');
    });

    it('should handle "the file" preamble', () => {
      expect(extractTargetFile('edit the file src/utils/helper.ts')).toBe('src/utils/helper.ts');
    });

    it('should handle "the" without "file"', () => {
      expect(extractTargetFile('fix the src/bug.ts')).toBe('src/bug.ts');
    });
  });

  // ---- "in/to" pattern ---------------------------------------------------
  describe('"in" and "to" patterns', () => {
    it('should extract file from "in <file>"', () => {
      expect(extractTargetFile('add a function in src/utils/helper.ts')).toBe('src/utils/helper.ts');
    });

    it('should extract file from "to <file>"', () => {
      expect(extractTargetFile('add a method to src/utils/helper.ts')).toBe('src/utils/helper.ts');
    });

    it('should extract file from "in the file <file>"', () => {
      expect(extractTargetFile('refactor code in the file src/app.tsx')).toBe('src/app.tsx');
    });
  });

  // ---- Quoted and backtick-quoted paths ----------------------------------
  describe('quoted file paths', () => {
    it('should extract file from single quotes', () => {
      expect(extractTargetFile("look at 'src/utils/helper.ts'")).toBe('src/utils/helper.ts');
    });

    it('should extract file from double quotes', () => {
      expect(extractTargetFile('look at "src/utils/helper.ts"')).toBe('src/utils/helper.ts');
    });

    it('should extract file from backticks', () => {
      expect(extractTargetFile('look at `src/utils/helper.ts`')).toBe('src/utils/helper.ts');
    });

    it('should extract quoted file after action verb', () => {
      expect(extractTargetFile('edit "src/utils/helper.ts"')).toBe('src/utils/helper.ts');
    });
  });

  // ---- Bare file path pattern (last resort) ------------------------------
  describe('bare file paths', () => {
    it('should extract a bare file path in the middle of text', () => {
      expect(extractTargetFile('please review src/utils/helper.ts soon')).toBe('src/utils/helper.ts');
    });

    it('should extract a bare file at the start of text', () => {
      expect(extractTargetFile('src/utils/helper.ts needs work')).toBe('src/utils/helper.ts');
    });

    it('should extract a bare file at the end of text', () => {
      expect(extractTargetFile('please look at src/utils/helper.ts')).toBe('src/utils/helper.ts');
    });
  });

  // ---- Various file extensions -------------------------------------------
  describe('various file extensions', () => {
    it('should match .ts files', () => {
      expect(extractTargetFile('edit app.ts')).toBe('app.ts');
    });

    it('should match .tsx files', () => {
      expect(extractTargetFile('edit App.tsx')).toBe('App.tsx');
    });

    it('should match .js files', () => {
      expect(extractTargetFile('edit index.js')).toBe('index.js');
    });

    it('should match .jsx files', () => {
      expect(extractTargetFile('edit Component.jsx')).toBe('Component.jsx');
    });

    it('should match .py files', () => {
      expect(extractTargetFile('edit main.py')).toBe('main.py');
    });

    it('should match .go files', () => {
      expect(extractTargetFile('edit main.go')).toBe('main.go');
    });

    it('should match .json files', () => {
      expect(extractTargetFile('edit package.json')).toBe('package.json');
    });

    it('should match .css files', () => {
      expect(extractTargetFile('edit styles.css')).toBe('styles.css');
    });

    it('should match .yaml files', () => {
      expect(extractTargetFile('edit config.yaml')).toBe('config.yaml');
    });

    it('should match .rs files', () => {
      expect(extractTargetFile('edit src/main.rs')).toBe('src/main.rs');
    });

    it('should match .html files', () => {
      expect(extractTargetFile('edit index.html')).toBe('index.html');
    });
  });

  // ---- Dotfiles, relative paths, and deeply nested paths -----------------
  describe('path variations', () => {
    it('should match relative paths with dot prefix', () => {
      expect(extractTargetFile('edit ./src/helper.ts')).toBe('./src/helper.ts');
    });

    it('should match deeply nested paths', () => {
      expect(extractTargetFile('edit src/components/ui/buttons/Primary.tsx')).toBe(
        'src/components/ui/buttons/Primary.tsx',
      );
    });

    it('should match filenames without directory', () => {
      expect(extractTargetFile('edit index.ts')).toBe('index.ts');
    });
  });

  // ---- No match cases ----------------------------------------------------
  describe('no match / edge cases', () => {
    it('should return null for empty string', () => {
      expect(extractTargetFile('')).toBeNull();
    });

    it('should return null for text with no file paths', () => {
      expect(extractTargetFile('add a new feature to the app')).toBeNull();
    });

    it('should return null for text with no file extension', () => {
      expect(extractTargetFile('edit the README')).toBeNull();
    });

    it('should return null when only directories are mentioned', () => {
      expect(extractTargetFile('look inside src/utils/')).toBeNull();
    });
  });

  // ---- Priority of patterns (first match wins) --------------------------
  describe('pattern priority', () => {
    it('should prefer the action-verb pattern when task starts with an action', () => {
      // "edit src/a.ts something in src/b.ts" should pick src/a.ts (first pattern)
      const result = extractTargetFile('edit src/a.ts something in src/b.ts');
      expect(result).toBe('src/a.ts');
    });

    it('should fall through to the quoted pattern when no action verb', () => {
      const result = extractTargetFile('look at "config.json" please');
      expect(result).toBe('config.json');
    });

    it('should fall through to the bare path pattern when nothing else matches', () => {
      // No action verb, no "in/to", no quotes — bare path is last resort
      const result = extractTargetFile('check src/helper.ts');
      expect(result).toBe('src/helper.ts');
    });
  });
});

// ===========================================================================
// formatSmartContext
// ===========================================================================
describe('formatSmartContext', () => {
  // ---- Empty context -----------------------------------------------------
  describe('empty context', () => {
    it('should return empty string when no files', () => {
      const ctx = makeContext([]);
      expect(formatSmartContext(ctx)).toBe('');
    });

    it('should return empty string when files array is empty and truncated is true', () => {
      const ctx = makeContext([], { truncated: true });
      // No files => early return ''
      expect(formatSmartContext(ctx)).toBe('');
    });
  });

  // ---- Single file -------------------------------------------------------
  describe('single file with content', () => {
    it('should format one file with header, reason, and code block', () => {
      const ctx = makeContext([
        {
          relativePath: 'src/index.ts',
          reason: 'target file',
          content: 'console.log("hello");',
        },
      ]);

      const result = formatSmartContext(ctx);

      expect(result).toContain('## Related Files (Smart Context)');
      expect(result).toContain('### src/index.ts');
      expect(result).toContain('> Reason: target file');
      expect(result).toContain('```');
      expect(result).toContain('console.log("hello");');
    });

    it('should not include truncation note when truncated is false', () => {
      const ctx = makeContext([
        {
          relativePath: 'src/index.ts',
          reason: 'target file',
          content: 'code',
        },
      ]);

      const result = formatSmartContext(ctx);
      expect(result).not.toContain('truncated due to size limits');
    });
  });

  // ---- File without content (skipped) ------------------------------------
  describe('file without content', () => {
    it('should skip files that have no content', () => {
      const ctx = makeContext([
        {
          relativePath: 'src/big.ts',
          reason: 'imported module',
          content: undefined,
        },
      ]);

      const result = formatSmartContext(ctx);

      // Header is still produced because files.length > 0, but the file
      // itself should not appear as a section
      expect(result).toContain('## Related Files (Smart Context)');
      expect(result).not.toContain('### src/big.ts');
    });
  });

  // ---- Multiple files ----------------------------------------------------
  describe('multiple files', () => {
    it('should list multiple files in order', () => {
      const ctx = makeContext([
        {
          relativePath: 'src/a.ts',
          reason: 'target file',
          priority: 10,
          content: 'const a = 1;',
        },
        {
          relativePath: 'src/b.ts',
          reason: 'imported module',
          priority: 8,
          content: 'const b = 2;',
        },
        {
          relativePath: 'src/c.ts',
          reason: 'type definitions',
          priority: 7,
          content: 'export type C = string;',
        },
      ]);

      const result = formatSmartContext(ctx);

      expect(result).toContain('### src/a.ts');
      expect(result).toContain('### src/b.ts');
      expect(result).toContain('### src/c.ts');
      expect(result).toContain('> Reason: target file');
      expect(result).toContain('> Reason: imported module');
      expect(result).toContain('> Reason: type definitions');

      // Verify order: a.ts appears before b.ts, b.ts before c.ts
      const posA = result.indexOf('### src/a.ts');
      const posB = result.indexOf('### src/b.ts');
      const posC = result.indexOf('### src/c.ts');
      expect(posA).toBeLessThan(posB);
      expect(posB).toBeLessThan(posC);
    });

    it('should include content from all files that have it', () => {
      const ctx = makeContext([
        { relativePath: 'src/a.ts', content: 'AAA' },
        { relativePath: 'src/b.ts', content: undefined },
        { relativePath: 'src/c.ts', content: 'CCC' },
      ]);

      const result = formatSmartContext(ctx);

      expect(result).toContain('AAA');
      expect(result).not.toContain('### src/b.ts');
      expect(result).toContain('CCC');
    });
  });

  // ---- Truncation warning ------------------------------------------------
  describe('truncation warning', () => {
    it('should include truncation note when truncated is true', () => {
      const ctx = makeContext(
        [
          {
            relativePath: 'src/index.ts',
            reason: 'target file',
            content: 'code',
          },
        ],
        { truncated: true },
      );

      const result = formatSmartContext(ctx);
      expect(result).toContain('> Note: Some files were truncated due to size limits.');
    });

    it('should not include truncation note when truncated is false', () => {
      const ctx = makeContext(
        [
          {
            relativePath: 'src/index.ts',
            reason: 'target file',
            content: 'code',
          },
        ],
        { truncated: false },
      );

      const result = formatSmartContext(ctx);
      expect(result).not.toContain('truncated');
    });
  });

  // ---- Output structure --------------------------------------------------
  describe('output structure', () => {
    it('should start with the smart context header', () => {
      const ctx = makeContext([
        { relativePath: 'src/index.ts', content: 'x' },
      ]);

      const result = formatSmartContext(ctx);
      const lines = result.split('\n');
      expect(lines[0]).toBe('## Related Files (Smart Context)');
      expect(lines[1]).toBe('');
    });

    it('should wrap file content in fenced code blocks', () => {
      const ctx = makeContext([
        { relativePath: 'src/index.ts', content: 'const x = 1;' },
      ]);

      const result = formatSmartContext(ctx);
      // Find the code fences surrounding the content
      const codeBlockStart = result.indexOf('```\nconst x = 1;');
      const codeBlockEnd = result.indexOf('```', codeBlockStart + 3);
      expect(codeBlockStart).toBeGreaterThan(-1);
      expect(codeBlockEnd).toBeGreaterThan(codeBlockStart);
    });

    it('should separate file sections with blank lines', () => {
      const ctx = makeContext([
        { relativePath: 'src/a.ts', content: 'a' },
        { relativePath: 'src/b.ts', content: 'b' },
      ]);

      const result = formatSmartContext(ctx);

      // After the closing ``` of a file, there should be a blank line
      // before the next ### header
      const closingFenceA = result.indexOf('```\n\n### src/b.ts');
      expect(closingFenceA).toBeGreaterThan(-1);
    });

    it('should include reason as a blockquote', () => {
      const ctx = makeContext([
        { relativePath: 'x.ts', reason: 'imported module', content: 'y' },
      ]);

      const result = formatSmartContext(ctx);
      expect(result).toContain('> Reason: imported module');
    });
  });

  // ---- Content with special characters -----------------------------------
  describe('special content', () => {
    it('should handle content with backticks inside code blocks', () => {
      const ctx = makeContext([
        {
          relativePath: 'src/template.ts',
          content: 'const s = `hello ${name}`;',
        },
      ]);

      const result = formatSmartContext(ctx);
      expect(result).toContain('const s = `hello ${name}`;');
    });

    it('should handle empty string content', () => {
      const ctx = makeContext([
        {
          relativePath: 'src/empty.ts',
          content: '',
        },
      ]);

      // Empty content is falsy, so the file section is skipped
      const result = formatSmartContext(ctx);
      expect(result).not.toContain('### src/empty.ts');
    });

    it('should handle multiline content', () => {
      const multiline = 'line1\nline2\nline3';
      const ctx = makeContext([
        { relativePath: 'src/multi.ts', content: multiline },
      ]);

      const result = formatSmartContext(ctx);
      expect(result).toContain('line1\nline2\nline3');
    });
  });
});

// ===========================================================================
// gatherSmartContext (real files)
// ===========================================================================
describe('gatherSmartContext', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeep-smartctx-'));
    clearImportResolutionCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Mirrors runAgent: the target is whatever path-like word the prompt holds.
  const gather = (prompt: string) =>
    gatherSmartContext(extractTargetFile(prompt), { root } as ProjectContext, prompt);
  const paths = (res: SmartContextResult) => res.files.map((f) => f.relativePath);

  describe('secrets files', () => {
    beforeEach(() => {
      writeFileSync(join(root, '.gitignore'), '.env.local\n');
      writeFileSync(join(root, '.env.local'), 'STRIPE_KEY=sk_live_SECRET123');
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'server.key'), '-----BEGIN PRIVATE KEY-----');
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');
    });

    it('never inlines a secrets file named in the prompt', () => {
      // In ACP the @-mention guard refuses `@.env.local` and strips the `@`,
      // so the agent still sees the bare path. Smart context must not then
      // put the file into the system prompt behind the user's back.
      for (const prompt of [
        'the app ignores .env.local on startup, fix it',
        "Why isn't my app picking up the values in .env.local",
        'rotate the cert in config/server.key please',
      ]) {
        const res = gather(prompt);
        const block = formatSmartContext(res);
        expect(paths(res), prompt).not.toContain('.env.local');
        expect(paths(res), prompt).not.toContain('config/server.key');
        expect(block, prompt).not.toContain('sk_live_SECRET123');
        expect(block, prompt).not.toContain('BEGIN PRIVATE KEY');
      }
    });

    it('never inlines a secrets file mentioned alongside the target', () => {
      writeFileSync(join(root, 'app.ts'), 'export const port = 3000;');
      const res = gather('fix app.ts so it loads config/server.key');
      expect(paths(res)).toContain('app.ts');
      expect(paths(res)).not.toContain('config/server.key');
      expect(formatSmartContext(res)).not.toContain('BEGIN PRIVATE KEY');
    });

    it('never inlines a secrets file the target imports', () => {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'tls.ts'), "import pem from '../config/server.key';\nexport default pem;");
      const res = gather('fix src/tls.ts');
      expect(paths(res)).toContain('src/tls.ts');
      expect(paths(res)).not.toContain('config/server.key');
      expect(formatSmartContext(res)).not.toContain('BEGIN PRIVATE KEY');
    });

    it('still inlines ordinary files', () => {
      writeFileSync(join(root, 'app.ts'), 'export const port = 3000;');
      expect(formatSmartContext(gather('fix app.ts'))).toContain('export const port = 3000;');
    });

    it('judges a symlink by the file it points at', () => {
      // Config files are picked up on every run, even when the prompt names
      // nothing, and the name check only ever saw the link.
      symlinkSync('.env.local', join(root, '.env.example'));
      symlinkSync('.env.local', join(root, 'notes.md'));
      symlinkSync(join('config', 'server.key'), join(root, 'tsconfig.json'));
      for (const prompt of ['hello there', 'fix notes.md please']) {
        const res = gather(prompt);
        const block = formatSmartContext(res);
        expect(paths(res), prompt).toEqual(['package.json']);
        expect(block, prompt).not.toContain('sk_live_SECRET123');
        expect(block, prompt).not.toContain('BEGIN PRIVATE KEY');
      }
    });

    it('never follows a link out of the project', () => {
      const outside = mkdtempSync(join(tmpdir(), 'codeep-smartctx-outside-'));
      try {
        writeFileSync(join(outside, 'tsconfig.json'), '{"token":"ghp_OUTSIDE"}');
        writeFileSync(join(outside, 'notes.md'), 'export TOKEN=hunter2');
        symlinkSync(join(outside, 'tsconfig.json'), join(root, 'tsconfig.json'));
        symlinkSync(join(outside, 'notes.md'), join(root, 'notes.md'));
        for (const prompt of ['hello there', 'fix notes.md please', `fix ../${outside.split('/').pop()}/notes.md`]) {
          const res = gather(prompt);
          const block = formatSmartContext(res);
          expect(paths(res), prompt).toEqual(['package.json']);
          expect(block, prompt).not.toContain('ghp_OUTSIDE');
          expect(block, prompt).not.toContain('hunter2');
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('never inlines key material, whatever the file is called', () => {
      const armour = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
      writeFileSync(join(root, 'tsconfig.json'), `${armour}\nb3BlbnNzaC1rZXktdjEAAAAA\n`);
      mkdirSync(join(root, 'deploy'));
      writeFileSync(join(root, 'deploy', 'prod.txt'), `${armour}\nb3BlbnNzaC1rZXktdjEAAAAA\n`);
      const res = gather('fix deploy/prod.txt');
      expect(paths(res)).toEqual(['package.json']);
      expect(formatSmartContext(res)).not.toContain('PRIVATE KEY');
    });

    it('finds key material anywhere in the part it reads', () => {
      // The check used to stop at 8 KB; a service account JSON can carry
      // its key further in.
      const armour = '-----BEGIN ' + 'PRIVATE KEY-----';
      writeFileSync(join(root, 'svc.json'), `{"pad":"${'x'.repeat(9000)}","private_key":"${armour}\\nLATEKEYSECRET\\n"}`);
      const res = gather('fix svc.json please');
      expect(paths(res)).toEqual(['package.json']);
      expect(formatSmartContext(res)).not.toContain('LATEKEYSECRET');
    });

    it('keeps a source file that only names the key armour', () => {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'pem.test.ts'), 'const fixture = "-----BEGIN ' + 'RSA PRIVATE KEY-----";\n');
      const res = gather('fix src/pem.test.ts please');
      expect(paths(res)).toContain('src/pem.test.ts');
    });

    it('treats a sibling whose name starts with the project name as outside', () => {
      const sibling = `${root}-secrets`;
      mkdirSync(sibling);
      try {
        writeFileSync(join(sibling, 'notes.md'), 'SIBLINGSECRET');
        symlinkSync(join(sibling, 'notes.md'), join(root, 'notes.md'));
        const res = gather('fix notes.md please');
        expect(paths(res)).toEqual(['package.json']);
        expect(formatSmartContext(res)).not.toContain('SIBLINGSECRET');
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });

    it('does not inline an .env template the @-mention guard refused', () => {
      // expandMentions refuses `@config/.env.template` and leaves the bare path
      // in the prompt; a template can still hold a real value.
      writeFileSync(join(root, 'config', '.env.template'), 'STRIPE_KEY=sk_live_TEMPLATE_REAL');
      for (const prompt of [
        'why does config/.env.template break the build',
        'compare src/app.ts with config/.env.template',
      ]) {
        const res = gather(prompt);
        expect(paths(res), prompt).not.toContain('config/.env.template');
        expect(formatSmartContext(res), prompt).not.toContain('TEMPLATE_REAL');
      }
    });

    it('keeps a committed .env.example as context', () => {
      writeFileSync(join(root, '.env.example'), 'STRIPE_KEY=');
      expect(paths(gather('hello there'))).toEqual(['package.json', '.env.example']);
    });
  });

  describe('size and file kind', () => {
    it('caps an oversized target instead of inlining all of it', () => {
      // The target was read up front and never counted against the budget,
      // so a multi-MB log went into the system prompt in full.
      writeFileSync(join(root, 'app.log'), 'x'.repeat(200_000));
      const res = gather('find the stack trace in app.log');
      const target = res.files.find((f) => f.relativePath === 'app.log');
      expect(target).toBeDefined();
      expect(target!.content!.length).toBeLessThanOrEqual(50_000 + 20);
      expect(target!.content).toMatch(/\(truncated\)$/);
      expect(res.truncated).toBe(true);
      expect(res.totalSize).toBeLessThanOrEqual(50_000 + 20);
      expect(formatSmartContext(res)).toContain('Some files were truncated');
    });

    it('caps an oversized related file the same way', () => {
      writeFileSync(join(root, 'package.json'), `{"description":"${'y'.repeat(120_000)}"}`);
      const res = gatherSmartContext(null, { root } as ProjectContext, 'hello there');
      const pkg = res.files.find((f) => f.relativePath === 'package.json');
      expect(pkg!.content!.length).toBeLessThanOrEqual(50_000 + 20);
      expect(res.truncated).toBe(true);
    });

    it('does not decode a binary target into the prompt', () => {
      mkdirSync(join(root, 'assets'));
      writeFileSync(join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]));
      const res = gather('update the icon in assets/logo.png');
      expect(paths(res)).not.toContain('assets/logo.png');
    });

    it('does not keep a multi-byte character split by the cut', () => {
      writeFileSync(join(root, 'notes.md'), 'a' + 'é'.repeat(30_000)); // the cut lands mid-character
      const target = gather('fix notes.md').files.find((f) => f.relativePath === 'notes.md');
      expect(target!.content).not.toContain('\uFFFD');
    });

    it('skips a target or config file that is not a regular file', () => {
      // A cloned repo can commit `tsconfig.json -> /dev/zero`; reading that
      // never returns. /dev/null takes the same path (a character device the
      // old existsSync-then-read code opened) but returns at once, so it
      // proves the file-kind check without hanging the test run.
      symlinkSync('/dev/null', join(root, 'tsconfig.json'));
      symlinkSync('/dev/null', join(root, 'notes.md'));
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');

      const none = gatherSmartContext(null, { root } as ProjectContext, 'hello there');
      expect(paths(none)).toEqual(['package.json']);

      const targeted = gather('fix notes.md');
      expect(paths(targeted)).not.toContain('notes.md');
      expect(paths(targeted)).not.toContain('tsconfig.json');
    });
  });
});
