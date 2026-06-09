import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getCurrentVersion } from './update';

describe('getCurrentVersion', () => {
  it('returns the package.json version (from the build-time-baked VERSION)', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
    );
    expect(getCurrentVersion()).toBe(pkg.version);
  });

  it('returns a real semver, never "unknown"', () => {
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(getCurrentVersion()).not.toBe('unknown');
  });
});
