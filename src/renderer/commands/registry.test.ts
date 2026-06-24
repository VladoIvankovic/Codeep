/**
 * Registry invariants — these guard against the drift this refactor was
 *  created to fix. If a future edit introduces a duplicate name/alias or
 *  references an unknown category, this file fails before the change ships.
 */

import { describe, it, expect } from 'vitest';
import {
  COMMANDS,
  CATEGORY_ORDER,
  COMMAND_DESCRIPTIONS,
  ALL_COMMAND_NAMES,
  ALL_ALIASES,
  resolveCommand,
} from './registry';

describe('command registry', () => {
  it('every command has a name, description, and valid category', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.name, JSON.stringify(cmd)).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(cmd.description, cmd.name).toMatch(/\S/);
      expect(CATEGORY_ORDER, `category "${cmd.category}" of /${cmd.name}`).toContain(cmd.category);
    }
  });

  it('no two commands share a name', () => {
    const seen = new Map<string, number>();
    for (const cmd of COMMANDS) {
      seen.set(cmd.name, (seen.get(cmd.name) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes, `duplicate command names: ${dupes.map(([n]) => n).join(', ')}`).toEqual([]);
  });

  it('no alias collides with a command name or another alias', () => {
    const taken = new Map<string, string>(); // token → owner command name
    for (const cmd of COMMANDS) {
      // Names first — they take priority.
      expect(taken.has(cmd.name), `/${cmd.name} already owned by /${taken.get(cmd.name)}`).toBe(false);
      taken.set(cmd.name, cmd.name);
      for (const a of cmd.aliases ?? []) {
        expect(taken.has(a), `/${a} (alias of /${cmd.name}) already owned by /${taken.get(a)}`).toBe(false);
        taken.set(a, cmd.name);
      }
    }
  });

  it('aliases are lowercase, no leading slash, no whitespace', () => {
    for (const cmd of COMMANDS) {
      for (const a of cmd.aliases ?? []) {
        expect(a, `alias of /${cmd.name}`).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it('COMMAND_DESCRIPTIONS omits hidden commands and unlisted aliases', () => {
    for (const cmd of COMMANDS) {
      if (cmd.hidden) {
        expect(COMMAND_DESCRIPTIONS, `hidden /${cmd.name} should not be listed`).not.toHaveProperty(cmd.name);
      } else {
        expect(COMMAND_DESCRIPTIONS, `/${cmd.name} should be listed`).toHaveProperty(cmd.name);
      }
      for (const a of cmd.aliases ?? []) {
        // Single-letter aliases (the c/t/d/… shortcuts) are excluded from the
        // autocomplete map even when aliasListed — bare one-letter rows clutter
        // the `/` dropdown. Only multi-letter listed aliases (effort, stats) show.
        const shouldList = !cmd.hidden && cmd.aliasListed === true && a.length > 1;
        if (shouldList) {
          expect(COMMAND_DESCRIPTIONS, `/${a} (listed alias of /${cmd.name})`).toHaveProperty(a);
        } else {
          expect(COMMAND_DESCRIPTIONS, `/${a} should NOT be listed`).not.toHaveProperty(a);
        }
      }
    }
  });

  it('COMMAND_DESCRIPTIONS values match the source description', () => {
    for (const cmd of COMMANDS) {
      if (cmd.hidden) continue;
      expect(COMMAND_DESCRIPTIONS[cmd.name]).toBe(cmd.description);
      if (cmd.aliasListed) {
        for (const a of cmd.aliases ?? []) {
          if (a.length > 1) expect(COMMAND_DESCRIPTIONS[a]).toBe(cmd.description); // single-letter aliases excluded
        }
      }
    }
  });

  it('ALL_COMMAND_NAMES includes hidden + aliases; ALL_ALIASES only aliases', () => {
    for (const cmd of COMMANDS) {
      expect(ALL_COMMAND_NAMES.has(cmd.name)).toBe(true);
      for (const a of cmd.aliases ?? []) {
        expect(ALL_COMMAND_NAMES.has(a)).toBe(true);
        expect(ALL_ALIASES.has(a)).toBe(true);
      }
      // A bare command name is not in the alias-only set.
      if (!cmd.aliases?.includes(cmd.name)) {
        expect(ALL_ALIASES.has(cmd.name)).toBe(false);
      }
    }
  });

  it('resolveCommand maps names and aliases to the canonical def', () => {
    for (const cmd of COMMANDS) {
      expect(resolveCommand(cmd.name)?.name).toBe(cmd.name);
      for (const a of cmd.aliases ?? []) {
        expect(resolveCommand(a)?.name, `alias /${a}`).toBe(cmd.name);
      }
    }
    expect(resolveCommand('nonexistent')).toBeUndefined();
  });

  it('categories appear in CATEGORY_ORDER exactly once', () => {
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it('every category referenced by a command is represented in the order list', () => {
    const used = new Set(COMMANDS.map(c => c.category));
    for (const cat of used) {
      expect(CATEGORY_ORDER, `category ${cat} has commands but no entry in CATEGORY_ORDER`).toContain(cat);
    }
  });

  // ── Coverage of the existing dispatchers ─────────────────────────────────
  //
  // These two checks pin the refactor's main guarantee: every case label in
  // renderer/commands.ts and acp/commands.ts is a known registry token, so
  // adding a `case 'foo':` without a registry entry is a build-time failure.

  it('every command name is unique by case-insensitive comparison (no /FOO vs /foo traps)', () => {
    const lower = new Set<string>();
    for (const cmd of COMMANDS) {
      const n = cmd.name.toLowerCase();
      expect(lower.has(n), `case-insensitive duplicate: /${cmd.name}`).toBe(false);
      lower.add(n);
    }
  });

  // ── Dispatcher coverage ─────────────────────────────────────────────────
  //
  // The point of the registry is that a `case 'foo':` block can never be
  // added to renderer/commands.ts or acp/commands.ts without a matching
  // registry entry. These two tests parse the dispatcher source at runtime
  // (cheap; files are tiny) and assert every case label is a known token.

  it('every case label in renderer/commands.ts exists in the registry', async () => {
    const fs = await import('fs');
    const url = await import('url');
    const src = fs.readFileSync(
      url.fileURLToPath(new URL('../commands.ts', import.meta.url)),
      'utf8',
    );
    // Match only top-level case labels: the outer `switch (command)` is
    // indented 4 spaces, nested subcommand switches are deeper. Anchoring on
    // `^    case` excludes the nested ones (e.g. the `case 'create':` block
    // inside `case 'skill':`).
    const labels = new Set<string>();
    for (const m of src.matchAll(/^    case '([a-z][a-z0-9-]*)':/gm)) {
      labels.add(m[1]);
    }
    labels.delete('default');
    expect(labels.size, 'expected to find at least one top-level case label').toBeGreaterThan(0);
    const unknown = [...labels].filter(l => !ALL_COMMAND_NAMES.has(l));
    expect(unknown, `renderer/commands.ts has cases with no registry entry: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every case label in acp/commands.ts exists in the registry', async () => {
    const fs = await import('fs');
    const url = await import('url');
    const src = fs.readFileSync(
      url.fileURLToPath(new URL('../../acp/commands.ts', import.meta.url)),
      'utf8',
    );
    const labels = new Set<string>();
    for (const m of src.matchAll(/^    case '([a-z][a-z0-9-]*)':/gm)) {
      labels.add(m[1]);
    }
    labels.delete('default');
    expect(labels.size, 'expected to find at least one top-level case label').toBeGreaterThan(0);
    const unknown = [...labels].filter(l => !ALL_COMMAND_NAMES.has(l));
    expect(unknown, `acp/commands.ts has cases with no registry entry: ${unknown.join(', ')}`).toEqual([]);
  });
});
