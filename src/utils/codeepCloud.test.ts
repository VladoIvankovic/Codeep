import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  generateProjectId,
  _globalDirForTest,
  _readFileBundleForTest,
  _writeFileBundleForTest,
  _writePulledPersonalityBundleForTest,
  _applyPersonalityTombstonesForTest,
  getLastPersonalityPullBackupCount,
} from './codeepCloud';

describe('generateProjectId', () => {
  it('returns a 16-char hex string', () => {
    const id = generateProjectId('/home/me/project');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic for the same path', () => {
    expect(generateProjectId('/home/me/project'))
      .toBe(generateProjectId('/home/me/project'));
  });

  it('normalises a trailing slash before hashing', () => {
    expect(generateProjectId('/home/me/project/'))
      .toBe(generateProjectId('/home/me/project'));
  });

  it('normalises multiple trailing slashes', () => {
    expect(generateProjectId('/home/me/project///'))
      .toBe(generateProjectId('/home/me/project'));
  });

  it('is case-insensitive (lowercases before hashing)', () => {
    expect(generateProjectId('/Home/Me/Project'))
      .toBe(generateProjectId('/home/me/project'));
  });

  it('produces different ids for different paths', () => {
    expect(generateProjectId('/a/b')).not.toBe(generateProjectId('/a/c'));
  });

  it('produces a stable, known hash for a sample path', () => {
    // Pin the actual hash value so a future change to the normalisation
    // rule is caught.
    expect(generateProjectId('/tmp/codeep')).toBe(
      require('crypto').createHash('sha256').update('/tmp/codeep').digest('hex').slice(0, 16),
    );
  });
});

describe('_globalDirForTest', () => {
  it('returns ~/.codeep/<kind>', () => {
    expect(_globalDirForTest('personalities')).toBe(join(homedir(), '.codeep', 'personalities'));
    expect(_globalDirForTest('commands')).toBe(join(homedir(), '.codeep', 'commands'));
  });
});

describe('readFileBundle / writeFileBundle', () => {
  // We can't safely write to the real ~/.codeep, so instead we exercise
  // the read/write pair against a temp dir by monkey-patching _globalDirForTest.
  // Since the helpers call `globalDir` directly (not the export), we
  // instead test them end-to-end with the real helpers on a controlled
  // layout under the OS temp dir via a small fake "kind" that the helpers
  // don't special-case.
  //
  // The simpler approach: write+read round-trip in the real ~/.codeep
  // path is too intrusive. Instead we verify the documented validation
  // rules (name regex, length cap, size cap, non-clobber) by calling
  // writeFileBundle + readFileBundle against a controlled dir.

  let tmpHome: string;
  const REAL_HOME = homedir();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'codeep-cloud-'));
    // Monkey-patch os.homedir via process.env so `globalDir` resolves
    // into our sandbox. `homedir()` honours HOME on POSIX.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome; // Windows
  });

  afterEach(() => {
    process.env.HOME = REAL_HOME;
    process.env.USERPROFILE = REAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns an empty object when the bundle dir does not exist', () => {
    expect(_readFileBundleForTest('personalities')).toEqual({});
  });

  it('round-trips a well-named .md file', () => {
    const dir = join(tmpHome, '.codeep', 'personalities');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'concise.md'), 'be brief');
    expect(_readFileBundleForTest('personalities')).toEqual({ concise: 'be brief' });
  });

  it('ignores non-markdown files', () => {
    const dir = join(tmpHome, '.codeep', 'personalities');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.md'), 'yes');
    writeFileSync(join(dir, 'drop.txt'), 'no');
    writeFileSync(join(dir, 'README'), 'no');
    expect(_readFileBundleForTest('personalities')).toEqual({ keep: 'yes' });
  });

  it('lowercases filenames before validating the name regex', () => {
    const dir = join(tmpHome, '.codeep', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'valid.md'), 'v');
    // UPPER.md is lowercased to "upper" by readFileBundle, so it passes
    // the lowercase-only regex. Documents that case-folding happens first.
    writeFileSync(join(dir, 'UPPER.md'), 'u');
    writeFileSync(join(dir, '_leading-underscore.md'), 'x');
    writeFileSync(join(dir, 'has space.md'), 'x');
    expect(_readFileBundleForTest('commands')).toEqual({ valid: 'v', upper: 'u' });
  });

  it('rejects names longer than 64 chars', () => {
    const dir = join(tmpHome, '.codeep', 'commands');
    mkdirSync(dir, { recursive: true });
    const longName = 'a'.repeat(65);
    writeFileSync(join(dir, `${longName}.md`), 'x');
    expect(_readFileBundleForTest('commands')).toEqual({});
  });

  it('skips files larger than 64 KB', () => {
    const dir = join(tmpHome, '.codeep', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(64 * 1024 + 1));
    writeFileSync(join(dir, 'small.md'), 'x');
    expect(_readFileBundleForTest('commands')).toEqual({ small: 'x' });
  });

  it('accepts a file exactly at the 64 KB boundary', () => {
    const dir = join(tmpHome, '.codeep', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'exact.md'), 'x'.repeat(64 * 1024));
    expect(_readFileBundleForTest('commands').exact).toBe('x'.repeat(64 * 1024));
  });
});

describe('writeFileBundle', () => {
  let tmpHome: string;
  const REAL_HOME = homedir();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'codeep-cloud-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = REAL_HOME;
    process.env.USERPROFILE = REAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes new files and returns the count', () => {
    const written = _writeFileBundleForTest('personalities', {
      alice: 'first',
      bob: 'second',
    });
    expect(written).toBe(2);
    expect(existsSync(join(tmpHome, '.codeep', 'personalities', 'alice.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.codeep', 'personalities', 'bob.md'))).toBe(true);
  });

  it('does not clobber an existing file (additive merge)', () => {
    const dir = join(tmpHome, '.codeep', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.md'), 'local edit');

    const written = _writeFileBundleForTest('commands', { keep: 'cloud version' });
    expect(written).toBe(0);
    expect(readFileSync(join(dir, 'keep.md'), 'utf8')).toBe('local edit');
  });

  it('creates the bundle directory if it does not exist', () => {
    expect(_writeFileBundleForTest('personalities', { x: 'y' })).toBe(1);
    expect(existsSync(join(tmpHome, '.codeep', 'personalities'))).toBe(true);
  });

  it('rejects invalid names in the input map', () => {
    const written = _writeFileBundleForTest('commands', {
      valid: 'ok',
      'UPPER': 'bad',
      'has space': 'bad',
      '': 'bad',
    });
    expect(written).toBe(1);
    expect(existsSync(join(tmpHome, '.codeep', 'commands', 'valid.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.codeep', 'commands', 'UPPER.md'))).toBe(false);
  });

  it('rejects names longer than 64 chars in the input map', () => {
    const longName = 'a'.repeat(65);
    const written = _writeFileBundleForTest('commands', { [longName]: 'x' });
    expect(written).toBe(0);
  });

  it('skips entries with an empty body', () => {
    const written = _writeFileBundleForTest('commands', { empty: '', ok: 'x' });
    expect(written).toBe(1);
    expect(existsSync(join(tmpHome, '.codeep', 'commands', 'ok.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.codeep', 'commands', 'empty.md'))).toBe(false);
  });

  it('skips entries with a non-string body', () => {
    const written = _writeFileBundleForTest('commands', {
      ok: 'x',
      bad: 123 as unknown as string,
    });
    expect(written).toBe(1);
  });

  it('writes multiple files across both kinds independently', () => {
    _writeFileBundleForTest('personalities', { p1: 'a' });
    _writeFileBundleForTest('commands', { c1: 'b' });
    expect(existsSync(join(tmpHome, '.codeep', 'personalities', 'p1.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.codeep', 'commands', 'c1.md'))).toBe(true);
  });
});

describe('cloud-authoritative personality pull', () => {
  let tmpHome: string;
  const REAL_HOME = homedir();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'codeep-personality-pull-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = REAL_HOME;
    process.env.USERPROFILE = REAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes a new cloud personality', () => {
    expect(_writePulledPersonalityBundleForTest({ reviewer: '# Reviewer\nCloud' })).toBe(1);
    expect(readFileSync(join(tmpHome, '.codeep', 'personalities', 'reviewer.md'), 'utf8')).toBe('# Reviewer\nCloud');
  });

  it('replaces a changed local body after preserving a backup', () => {
    const dir = join(tmpHome, '.codeep', 'personalities');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reviewer.md'), '# Reviewer\nLocal edits');

    expect(_writePulledPersonalityBundleForTest({ reviewer: '# Reviewer\nCloud edit' })).toBe(1);
    expect(getLastPersonalityPullBackupCount()).toBe(1);
    expect(readFileSync(join(dir, 'reviewer.md'), 'utf8')).toBe('# Reviewer\nCloud edit');

    const backupDir = join(tmpHome, '.codeep', 'backups', 'personalities');
    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(backupDir, backups[0]), 'utf8')).toBe('# Reviewer\nLocal edits');
  });

  it('does nothing when local and cloud bodies are identical', () => {
    const dir = join(tmpHome, '.codeep', 'personalities');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'same.md'), 'same');
    expect(_writePulledPersonalityBundleForTest({ same: 'same' })).toBe(0);
    expect(existsSync(join(tmpHome, '.codeep', 'backups', 'personalities'))).toBe(false);
  });

  it('rejects oversized cloud bodies', () => {
    expect(_writePulledPersonalityBundleForTest({ huge: 'x'.repeat(64 * 1024 + 1) })).toBe(0);
    expect(existsSync(join(tmpHome, '.codeep', 'personalities', 'huge.md'))).toBe(false);
  });
});

describe('applyPersonalityTombstones', () => {
  const REAL_HOME = homedir();
  let tmpHome: string;
  let dir: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'codeep-tomb-'));
    process.env.HOME = tmpHome;
    dir = join(tmpHome, '.codeep', 'personalities');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = REAL_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const write = (name: string, body = `# ${name}\n`) => writeFileSync(join(dir, `${name}.md`), body);
  const backups = () => {
    const b = join(tmpHome, '.codeep', 'backups', 'personalities');
    return existsSync(b) ? readdirSync(b) : [];
  };

  it('removes a tombstoned agent and backs it up first', () => {
    write('retired', '# Retired\nbody\n');
    expect(_applyPersonalityTombstonesForTest(['retired'])).toBe(1);
    expect(existsSync(join(dir, 'retired.md'))).toBe(false);
    const saved = backups();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^retired-/);
  });

  it('leaves every other agent alone', () => {
    write('keep-me');
    write('retired');
    _applyPersonalityTombstonesForTest(['retired']);
    expect(existsSync(join(dir, 'keep-me.md'))).toBe(true);
  });

  // The whole reason tombstones exist: absence must never imply deletion, or a
  // failed request that yields an empty payload would wipe the folder.
  it('deletes nothing when handed an empty list', () => {
    write('keep-me');
    expect(_applyPersonalityTombstonesForTest([])).toBe(0);
    expect(existsSync(join(dir, 'keep-me.md'))).toBe(true);
  });

  it('ignores names that never existed locally', () => {
    expect(_applyPersonalityTombstonesForTest(['never-here'])).toBe(0);
    expect(backups()).toHaveLength(0);
  });

  it('refuses names that could escape the personalities directory', () => {
    const outside = join(tmpHome, '.codeep', 'secret.md');
    writeFileSync(outside, 'do not touch');
    for (const evil of ['../secret', '../../etc/passwd', 'a/../../b', '.hidden', 'UPPER']) {
      expect(_applyPersonalityTombstonesForTest([evil])).toBe(0);
    }
    expect(existsSync(outside)).toBe(true);
  });

  it('ignores non-string entries rather than throwing', () => {
    write('keep-me');
    expect(_applyPersonalityTombstonesForTest([null, 42, {}] as unknown as string[])).toBe(0);
    expect(existsSync(join(dir, 'keep-me.md'))).toBe(true);
  });
});
