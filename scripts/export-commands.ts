#!/usr/bin/env node --import tsx
/**
 * Export the TUI command reference as JSON for codeep.dev.
 *
 * The website's /docs/commands used to be a hand-written table, and it drifted
 * the way hand-written copies do: 19 real commands were missing from it, it
 * documented `/scan status` and `/scan clear`, which do not exist, described
 * `/agent` with no task as "interactive mode" when it prints a usage line, and
 * claimed "over 40" commands against 113.
 *
 * This makes `HELP_LAYOUT` in `src/renderer/commands/registry.ts` the one
 * document behind both `/help` and the website, and `registry.test.ts` holds it
 * complete: every visible command must appear in it, and no row may name a
 * command that does not exist.
 *
 * Run it from the CLI repo root after changing commands:
 *
 *   npm run export:commands
 *
 * The output is committed to the web repo so the site builds standalone.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { COMMANDS, HELP_LAYOUT } from '../src/renderer/commands/registry';
import { getBuiltInSkills } from '../src/utils/skills';
import { VERSION } from '../src/version';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(repoRoot, 'Codeep-web', 'src', 'data', 'commands.json');

// A built-in skill is unreachable when a command of the same name has its own
// handler instead of handing to runSkill — /docs opens the browser, so the
// `docs` skill never runs. Listing those on the website as things you can type
// would document behaviour nobody can get. Same rule as registry.test.ts.
const dispatcher = readFileSync(join(repoRoot, 'src', 'renderer', 'commands.ts'), 'utf8');
const shadowed = (name: string): boolean => {
  const at = dispatcher.search(new RegExp(`^ {4}case '${name}':`, 'm'));
  if (at < 0) return false;
  const body = dispatcher.slice(at, dispatcher.indexOf('\n    }\n', at));
  return !body.includes('runSkill(');
};

const sections = HELP_LAYOUT.map(cat => ({
  title: cat.title,
  items: cat.items.map(item => ({ key: item.key, description: item.web ?? item.description })),
}));

const skills = getBuiltInSkills().map(s => ({
  name: s.name,
  shortcut: s.shortcut ?? null,
  description: s.description,
  category: s.category,
  /** False when a command of the same name takes the slash name first. */
  runnable: !shadowed(s.name),
}));

const out = {
  generatedBy: `codeep ${VERSION}`,
  /** Visible slash commands — what the autocomplete offers. */
  commandCount: COMMANDS.filter(c => !c.hidden).length,
  skillCount: skills.filter(s => s.runnable).length,
  sections,
  skills,
};

mkdirSync(dirname(outPath), { recursive: true });
if (!existsSync(dirname(outPath))) throw new Error(`cannot write ${outPath}`);
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(
  `Exported ${out.commandCount} commands in ${sections.length} sections and ${skills.length} skills ` +
  `(${skills.length - out.skillCount} shadowed by a command) → ${outPath}`,
);
