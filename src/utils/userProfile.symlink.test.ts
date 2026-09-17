import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../api/index.js', () => ({ chat: vi.fn(async () => '- Deploys with rsync') }));

import { clearLearnedProfile, loadUserProfilePrompt, scaffoldProfile, updateLearnedProfile } from './userProfile';

// No fs mocks: what matters is what reaches the prompt and the disk.
let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codeep-profile-')));
  root = join(base, 'repo');
  outside = join(base, 'home');
  mkdirSync(join(root, '.codeep'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'aws_secret_access_key = OUTSIDE_SECRET\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('project profile files that came with the repo', () => {
  it('are not read through a link out of the project', () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, '.codeep', 'profile.md'));
    symlinkSync(join(outside, 'secret.txt'), join(root, '.codeep', 'profile.learned.md'));
    expect(loadUserProfilePrompt(root)).not.toContain('OUTSIDE_SECRET');
  });

  it('do not hang on a link to a device', () => {
    symlinkSync('/dev/zero', join(root, '.codeep', 'profile.md'));
    expect(loadUserProfilePrompt(root)).not.toContain('\0');
  });

  it('are never written or deleted through a symlink', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, '.codeep', 'profile.learned.md'));
    const res = await updateLearnedProfile([{ role: 'user', content: 'I deploy with rsync' }], 'project', root);
    expect(res).toBeNull();
    expect(clearLearnedProfile(root)).toBe(false);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toContain('OUTSIDE_SECRET');

    rmSync(join(root, '.codeep'), { recursive: true });
    symlinkSync(outside, join(root, '.codeep'));
    expect(scaffoldProfile('project', root)).toBeNull();
    expect(existsSync(join(outside, 'profile.md'))).toBe(false);
  });
});
