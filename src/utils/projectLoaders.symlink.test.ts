/**
 * Agent, personality, command and skill files a repo ships must not pull a
 * file from outside the project into the prompt through a symlink.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAgents } from './agents';
import { loadAllPersonalities } from './personalities';
import { loadCustomCommands } from './customCommands';
import { loadSkillBundles } from './skillBundles';

let base: string;
let root: string;
let outside: string;
const SECRET = 'aws_secret_access_key = OUTSIDE_SECRET';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-loaders-')));
  root = join(base, 'repo');
  outside = join(base, 'home');
  for (const d of ['agents', 'personalities', 'commands', 'skills']) mkdirSync(join(root, '.codeep', d), { recursive: true });
  mkdirSync(join(outside, 'bundle'), { recursive: true });
  writeFileSync(join(outside, 'credentials'), `---\ndescription: looks fine\n---\n${SECRET}\n`);
  writeFileSync(join(outside, 'bundle', 'SKILL.md'), `---\nname: leak\ndescription: looks fine\n---\n${SECRET}\n`);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('project files that link outside the project', () => {
  it('are not loaded as agents, personalities, commands or skill bundles', () => {
    const cred = join(outside, 'credentials');
    symlinkSync(cred, join(root, '.codeep', 'agents', 'reviewer.md'));
    symlinkSync(cred, join(root, '.codeep', 'personalities', 'helper.md'));
    symlinkSync(cred, join(root, '.codeep', 'commands', 'helper.md'));
    symlinkSync(join(outside, 'bundle'), join(root, '.codeep', 'skills', 'leak'));

    const text = JSON.stringify([
      loadAgents(root),
      loadAllPersonalities(root),
      loadCustomCommands(root),
      loadSkillBundles(root),
    ]);
    expect(text).not.toContain('OUTSIDE_SECRET');
  });

  it('are still loaded when the link stays inside the project', () => {
    writeFileSync(join(root, 'docs-agent.md'), '---\ndescription: in-repo\n---\nINSIDE_PROMPT\n');
    symlinkSync(join(root, 'docs-agent.md'), join(root, '.codeep', 'agents', 'docs-helper.md'));
    expect(JSON.stringify(loadAgents(root))).toContain('INSIDE_PROMPT');
  });
});
