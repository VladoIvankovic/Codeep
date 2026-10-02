import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  stripQuotes,
  asStringArray,
  formatBundlesForSysprompt,
  formatBundleList,
  type SkillBundle,
} from './skillBundles';

// ─── helpers ────────────────────────────────────────────────────────────────
function bundle(overrides: Partial<SkillBundle> = {}): SkillBundle {
  return {
    name: 'demo',
    description: 'a demo skill',
    source: '/x/.codeep/skills/demo',
    scope: 'project',
    allowedTools: [],
    triggers: [],
    requiresMcp: [],
    frontmatterRaw: {},
    body: 'do the thing',
    ...overrides,
  };
}

// ─── stripQuotes ────────────────────────────────────────────────────────────
describe('stripQuotes', () => {
  it('strips matching double quotes', () => {
    expect(stripQuotes('"hello"')).toBe('hello');
  });

  it('strips matching single quotes', () => {
    expect(stripQuotes("'hello'")).toBe('hello');
  });

  it('strips mixed quotes only at the ends', () => {
    expect(stripQuotes("\"hello'")).toBe('hello');
  });

  it('strips a trailing quote even when the leading char is not a quote', () => {
    // The regex is `^["']|["']$` — either end independently. So an input
    // like `say "hi"` (no leading quote) still loses its trailing quote.
    // Documenting the current behaviour.
    expect(stripQuotes('say "hi"')).toBe('say "hi');
  });

  it('returns the input unchanged when unquoted', () => {
    expect(stripQuotes('plain')).toBe('plain');
    expect(stripQuotes('')).toBe('');
  });
});

// ─── asStringArray ──────────────────────────────────────────────────────────
describe('asStringArray', () => {
  it('returns the array when given a string array', () => {
    expect(asStringArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('filters non-string elements out of an array', () => {
    expect(asStringArray(['a', 1, true, 'b'])).toEqual(['a', 'b']);
  });

  it('wraps a single string into a one-element array', () => {
    expect(asStringArray('solo')).toEqual(['solo']);
  });

  it('returns null for non-string, non-array input', () => {
    expect(asStringArray(null)).toBeNull();
    expect(asStringArray(undefined)).toBeNull();
    expect(asStringArray(42)).toBeNull();
    expect(asStringArray({ a: 1 })).toBeNull();
  });

  it('returns null for an empty array', () => {
    // Note: an empty array is still an array — `.filter` keeps it empty,
    // so the result is `[]`, not `null`. Documenting the behaviour.
    expect(asStringArray([])).toEqual([]);
  });
});

// ─── parseFrontmatter ───────────────────────────────────────────────────────
describe('parseFrontmatter', () => {
  it('returns an empty meta + the raw body when there is no frontmatter', () => {
    const out = parseFrontmatter('just body text');
    expect(out.meta).toEqual({});
    expect(out.body).toBe('just body text');
  });

  it('parses a simple name/description block', () => {
    const out = parseFrontmatter('---\nname: x\ndescription: y\n---\nbody');
    expect(out.meta.name).toBe('x');
    expect(out.meta.description).toBe('y');
    expect(out.body).toBe('body');
  });

  it('parses an inline list value', () => {
    const out = parseFrontmatter('---\ntriggers: [a, b, c]\n---\n');
    expect(out.meta.triggers).toEqual(['a', 'b', 'c']);
  });

  it('parses a block-list value', () => {
    const out = parseFrontmatter('---\ntriggers:\n  - one\n  - two\n---\n');
    expect(out.meta.triggers).toEqual(['one', 'two']);
  });

  it('strips surrounding quotes from scalar values', () => {
    const out = parseFrontmatter('---\nname: "quoted"\n---\n');
    expect(out.meta.name).toBe('quoted');
  });

  it('handles kebab-case keys', () => {
    const out = parseFrontmatter('---\nallowed-tools: [read_file]\n---\n');
    expect(out.meta['allowed-tools']).toEqual(['read_file']);
  });

  it('normalises a leading BOM', () => {
    const out = parseFrontmatter('\uFEFF---\nname: x\n---\nbody');
    expect(out.meta.name).toBe('x');
    expect(out.body).toBe('body');
  });

  it('normalises CRLF line endings', () => {
    const out = parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\nbody');
    expect(out.meta.name).toBe('x');
    expect(out.body).toBe('body');
  });

  it('treats a closing --- without a trailing newline as valid', () => {
    const out = parseFrontmatter('---\nname: x\n---');
    expect(out.meta.name).toBe('x');
  });

  it('preserves the body verbatim, including blank lines', () => {
    const out = parseFrontmatter('---\nname: x\n---\n\npara one\n\npara two');
    expect(out.body).toBe('para one\n\npara two');
  });

  it('returns the whole input as body when the opening --- is missing', () => {
    const out = parseFrontmatter('name: not-yaml');
    expect(out.meta).toEqual({});
    expect(out.body).toBe('name: not-yaml');
  });
});

// ─── parseFrontmatter: block scalars ────────────────────────────────────────
describe('parseFrontmatter block scalars', () => {
  // The shape of Omarchy's skills (default/agents/skills/*/SKILL.md): a long
  // folded description, then the body.
  const FOLDED = [
    '---',
    'name: tidy-desk',
    'description: >',
    '  Tidy the desktop the way this machine expects it. Use when',
    '  asked to clean up windows, workspaces or the bar.',
    '  Triggers: tidy, declutter, "clean up".',
    '---',
    '',
    '# Tidy',
  ].join('\n');
  const FOLDED_DESCRIPTION =
    'Tidy the desktop the way this machine expects it. Use when asked to clean up windows, workspaces or the bar. Triggers: tidy, declutter, "clean up".\n';

  it('folds a `>` block into one line that ends in a line break', () => {
    const out = parseFrontmatter(FOLDED);
    expect(out.meta.name).toBe('tidy-desk');
    expect(out.meta.description).toBe(FOLDED_DESCRIPTION);
    expect(out.body).toBe('# Tidy');
  });

  it('keeps the line breaks of a `|` block', () => {
    const out = parseFrontmatter('---\ndescription: |\n  one\n  two\n---\n');
    expect(out.meta.description).toBe('one\ntwo\n');
  });

  it('keeps a blank line in a `>` block as a line break', () => {
    const out = parseFrontmatter('---\ndescription: >\n  one\n  two\n\n  three\n---\n');
    expect(out.meta.description).toBe('one two\nthree\n');
  });

  it('does not fold the breaks around a more-indented line', () => {
    const out = parseFrontmatter('---\ndescription: >\n  one\n    two\n  three\n---\n');
    expect(out.meta.description).toBe('one\n  two\nthree\n');
  });

  it('drops the trailing line break with `-`', () => {
    expect(parseFrontmatter('---\ndescription: >-\n  one\n  two\n---\n').meta.description).toBe('one two');
    expect(parseFrontmatter('---\ndescription: |-\n  one\n  two\n---\n').meta.description).toBe('one\ntwo');
  });

  it('keeps every trailing line break with `+`', () => {
    expect(parseFrontmatter('---\ndescription: >+\n  one\n  two\n\n\nname: x\n---\n').meta.description).toBe('one two\n\n\n');
    expect(parseFrontmatter('---\ndescription: |+\n  one\n\nname: x\n---\n').meta.description).toBe('one\n\n');
  });

  it('reads the keys after a block', () => {
    const out = parseFrontmatter('---\ndescription: >\n  one\n  two\n\nname: x\ntriggers:\n  - a\n  - b\n---\nbody');
    expect(out.meta.description).toBe('one two\n');
    expect(out.meta.name).toBe('x');
    expect(out.meta.triggers).toEqual(['a', 'b']);
    expect(out.body).toBe('body');
  });

  it('ends a block at the closing ---', () => {
    const out = parseFrontmatter('---\nname: x\ndescription: |\n  one\n  two\n---\nbody');
    expect(out.meta.description).toBe('one\ntwo\n');
    expect(out.body).toBe('body');
  });

  it('reads a block from a CRLF file', () => {
    const out = parseFrontmatter(FOLDED.replace(/\n/g, '\r\n'));
    expect(out.meta.description).toBe(FOLDED_DESCRIPTION);
    expect(out.body).toBe('# Tidy');
  });

  it('takes the indentation from the header when it gives one', () => {
    const out = parseFrontmatter('---\ndescription: |2\n    deeper\n  flush\n---\n');
    expect(out.meta.description).toBe('  deeper\nflush\n');
  });

  it('allows a comment after the header', () => {
    const out = parseFrontmatter('---\ndescription: >- # one line\n  one\n  two\n---\n');
    expect(out.meta.description).toBe('one two');
  });

  it('reads `- item` lines inside a block as text, not as a list', () => {
    const out = parseFrontmatter('---\ndescription: |\n  - one\n  - two\n---\n');
    expect(out.meta.description).toBe('- one\n- two\n');
  });

  it('reads a block with no lines as an empty string', () => {
    const out = parseFrontmatter('---\ndescription: >\nname: x\n---\n');
    expect(out.meta.description).toBe('');
    expect(out.meta.name).toBe('x');
  });

  it('leaves a quoted `>` as a plain value', () => {
    const out = parseFrontmatter('---\ndescription: ">"\nname: x\n---\n');
    expect(out.meta.description).toBe('>');
    expect(out.meta.name).toBe('x');
  });
});

// ─── formatBundlesForSysprompt ──────────────────────────────────────────────
describe('formatBundlesForSysprompt', () => {
  it('returns an empty string when no bundles are installed', () => {
    expect(formatBundlesForSysprompt([])).toBe('');
  });

  it('lists each bundle by name and description', () => {
    const out = formatBundlesForSysprompt([bundle({ name: 'commit', description: 'git commit flow' })]);
    expect(out).toContain('**commit**');
    expect(out).toContain('git commit flow');
  });

  it('includes up to three trigger hints when present', () => {
    const out = formatBundlesForSysprompt([
      bundle({ triggers: ['commit', 'save', 'checkpoint', 'extra'] }),
    ]);
    expect(out).toContain('triggers: commit, save, checkpoint');
    expect(out).not.toContain('extra');
  });

  it('omits the trigger hint when there are no triggers', () => {
    const out = formatBundlesForSysprompt([bundle({ triggers: [] })]);
    expect(out).not.toContain('triggers:');
  });

  it('caps the per-line length at 1200 chars', () => {
    // Room for a description at the Agent Skills limit of 1024, and no more.
    const long = bundle({ description: 'x'.repeat(1300) });
    const out = formatBundlesForSysprompt([long]);
    const line = out.split('\n').find((l) => l.startsWith('- **'))!;
    expect(line.length).toBe(1201); // 1200 + ellipsis: one long word is cut, not dropped
    expect(line.endsWith('…')).toBe(true);
  });

  it('emits an "omitted" note when the total catalog exceeds the budget', () => {
    // 4000-char budget — generate enough bundles to overflow it.
    const many = Array.from({ length: 100 }, (_, i) =>
      bundle({ name: `b${i}`, description: 'y'.repeat(80) }),
    );
    const out = formatBundlesForSysprompt(many);
    expect(out).toMatch(/more skills omitted/);
  });
});

// ─── formatBundleList ───────────────────────────────────────────────────────
describe('formatBundleList', () => {
  it('renders an "empty" hint when there are no bundles', () => {
    const out = formatBundleList([]);
    expect(out).toContain('No skill bundles installed');
  });

  it('groups bundles by scope (project / global)', () => {
    const out = formatBundleList([
      bundle({ name: 'p1', scope: 'project' }),
      bundle({ name: 'g1', scope: 'global' }),
    ]);
    expect(out).toContain('**Project**');
    expect(out).toContain('**Global**');
    expect(out).toContain('p1');
    expect(out).toContain('g1');
  });

  it('omits the project section when only global bundles exist', () => {
    const out = formatBundleList([bundle({ scope: 'global' })]);
    expect(out).not.toContain('**Project**');
    expect(out).toContain('**Global**');
  });

  it('shows the version badge when a version is present', () => {
    const out = formatBundleList([bundle({ version: '1.2.0' })]);
    expect(out).toContain('`v1.2.0`');
  });

  it('omits the version badge when no version is set', () => {
    const out = formatBundleList([bundle({ version: undefined })]);
    expect(out).not.toContain('`v');
  });
});
