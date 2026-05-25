import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Give each test worker its own Codeep config directory so parallel workers
// don't race on the shared on-disk config file. Without this, two files that
// mutate config concurrently (e.g. trustWorkspaceHooks → trustedHookProjects)
// can clobber each other's writes, causing order-dependent flakes. Runs before
// the config module (a singleton) is imported by any test file.
if (!process.env.CODEEP_CONFIG_DIR) {
  process.env.CODEEP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'codeep-test-config-'));
}
