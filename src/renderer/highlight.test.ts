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
