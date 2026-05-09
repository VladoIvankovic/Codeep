#!/usr/bin/env node
/**
 * Release wrapper. Bumps version, commits, tags, pushes — and verifies a
 * CHANGELOG entry exists for the new version *before* doing any of that, so
 * the GitHub Actions workflow can use it as the release body.
 *
 * Usage:
 *   npm run release patch          # 1.3.38 → 1.3.39
 *   npm run release minor          # 1.3.38 → 1.4.0
 *   npm run release major          # 1.3.38 → 2.0.0
 *   npm run release 1.4.2          # explicit version
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run release <patch|minor|major|x.y.z>');
  process.exit(1);
}

// ── 1. Working tree must be clean ──────────────────────────────────────────
const dirty = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' }).trim();
if (dirty) {
  console.error('❌ Working tree has uncommitted changes:\n');
  console.error(dirty);
  console.error('\nCommit or stash before releasing.');
  process.exit(1);
}

// ── 2. Compute next version ────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const current = pkg.version;

function bump(version, kind) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Cannot parse current version: ${version}`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === 'major') { major++; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor++; patch = 0; }
  else if (kind === 'patch') { patch++; }
  else throw new Error(`Unknown bump kind: ${kind}`);
  return `${major}.${minor}.${patch}`;
}

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else if (['patch', 'minor', 'major'].includes(arg)) {
  next = bump(current, arg);
} else {
  console.error(`❌ Invalid version arg: ${arg} (expected patch|minor|major|x.y.z)`);
  process.exit(1);
}

console.log(`Releasing ${current} → ${next}\n`);

// ── 3. Verify CHANGELOG has section for the new version ────────────────────
const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
const sectionPattern = new RegExp(`^## \\[${next.replace(/\./g, '\\.')}\\]`, 'm');
if (!sectionPattern.test(changelog)) {
  const today = new Date().toISOString().slice(0, 10);
  console.error(`❌ CHANGELOG.md is missing a section for v${next}.\n`);
  console.error(`Add this near the top of CHANGELOG.md (above the previous version):\n`);
  console.error(`  ## [${next}] — ${today}\n`);
  console.error(`  ### Added`);
  console.error(`  - …\n`);
  console.error(`  ### Fixed`);
  console.error(`  - …\n`);
  console.error(`Then commit it and re-run the release.`);
  process.exit(1);
}
console.log(`✓ CHANGELOG.md has section for v${next}`);

// ── 4. Run tests ───────────────────────────────────────────────────────────
console.log('\nRunning tests…');
try {
  execSync('npm test', { cwd: repoRoot, stdio: 'inherit' });
} catch {
  console.error('\n❌ Tests failed. Aborting release.');
  process.exit(1);
}

// ── 5. Bump version (creates commit + tag) ─────────────────────────────────
// `npm version <x.y.z>` mutates package.json, commits with message "x.y.z",
// and tags as v<x.y.z>. We pass the explicit version so npm doesn't compute it.
console.log(`\nBumping package.json and tagging…`);
execSync(`npm version ${next} -m "%s"`, { cwd: repoRoot, stdio: 'inherit' });

// ── 6. Push commit and tag ─────────────────────────────────────────────────
console.log('\nPushing commit…');
execSync('git push', { cwd: repoRoot, stdio: 'inherit' });
console.log('Pushing tag…');
execSync(`git push origin v${next}`, { cwd: repoRoot, stdio: 'inherit' });

console.log(`\n✅ v${next} released.`);
console.log(`\nWatch the workflow:`);
console.log(`  gh run watch -R VladoIvankovic/Codeep`);
console.log(`Or: https://github.com/VladoIvankovic/Codeep/actions`);
