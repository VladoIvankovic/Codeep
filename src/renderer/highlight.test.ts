import { describe, it, expect } from 'vitest';
import { highlightCode, SYNTAX } from './highlight';
import { stripAnsi } from './ansi';

// highlightCode only *adds* colour — stripping the ANSI must give back exactly
// the original source (for the line-based tokenizer + HTML). That invariant is
// what keeps copied/selected code intact in the TUI.

describe('highlightCode — text preservation', () => {
  const samples: Record<string, string> = {
    js:   'const x = 42;\nfunction add(a, b) { return a + b }',
    ts:   'let n: number = 1\ninterface Foo { bar: string }',
    py:   'def f(x):\n    return x # done',
    go:   'func main() {\n\tx := 1\n}',
    rust: 'fn main() { let mut x = 1; }',
  };
  for (const [lang, code] of Object.entries(samples)) {
    it(`leaves ${lang} source unchanged after stripping ANSI`, () => {
      expect(stripAnsi(highlightCode(code, lang))).toBe(code);
    });
  }

  it('preserves HTML text', () => {
    expect(stripAnsi(highlightCode('<div>hi</div>', 'html'))).toBe('<div>hi</div>');
  });
});

describe('highlightCode — token colouring', () => {
  it('colours keywords', () => {
    expect(highlightCode('const x', 'js')).toContain(SYNTAX.keyword + 'const');
  });

  it('colours numbers', () => {
    expect(highlightCode('x = 42', 'js')).toContain(SYNTAX.number + '42');
  });

  it('colours strings', () => {
    expect(highlightCode('"hi"', 'js')).toContain(SYNTAX.string + '"hi"');
  });

  it('colours line comments (and language-specific # comments)', () => {
    expect(highlightCode('// note', 'js')).toContain(SYNTAX.comment);
    expect(highlightCode('# note', 'py')).toContain(SYNTAX.comment);
  });

  it('colours a call target as a function', () => {
    expect(highlightCode('foo()', 'js')).toContain(SYNTAX.function + 'foo');
  });

  it('colours a capitalised identifier as a type', () => {
    expect(highlightCode('Foo bar', 'js')).toContain(SYNTAX.type + 'Foo');
  });
});

describe('highlightCode — language aliases', () => {
  it('maps "python" → py keywords', () => {
    expect(highlightCode('def f', 'python')).toContain(SYNTAX.keyword + 'def');
  });

  it('maps "typescript" → ts keywords', () => {
    expect(highlightCode('interface X', 'typescript')).toContain(SYNTAX.keyword + 'interface');
  });
});

describe('highlightCode — diff', () => {
  const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n unchanged';

  it('colours additions green (string) and removals red, leaving context plain', () => {
    const out = highlightCode(diff, 'diff');
    expect(out).toContain(SYNTAX.string + '+const a = 2');
    expect(out).toContain(SYNTAX.operator + '@@ -1 +1 @@');
    // a context line keeps no colour — it stays verbatim, unwrapped
    expect(out).toContain('\n unchanged');
    expect(out.endsWith(' unchanged')).toBe(true);
  });

  it('does NOT treat +/- lines as JS keywords (the old fallback bug)', () => {
    // `const` inside a diff line must not get keyword colouring — the whole
    // line is one diff token.
    const out = highlightCode('+const a = 2', 'diff');
    expect(out).not.toContain(SYNTAX.keyword + 'const');
  });

  it('preserves text under ANSI strip', () => {
    expect(stripAnsi(highlightCode(diff, 'diff'))).toBe(diff);
    expect(stripAnsi(highlightCode(diff, 'patch'))).toBe(diff);
  });
});
