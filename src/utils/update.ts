import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface VersionInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  error?: string;
}

/**
 * Get current version from package.json
 */
export function getCurrentVersion(): string {
  try {
    // In built version, package.json is in parent directory
    const packagePath = join(__dirname, '../../package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
    return packageJson.version;
  } catch {
    return 'unknown';
  }
}

/**
 * Check for updates from npm registry
 */
export async function checkForUpdates(): Promise<VersionInfo> {
  const current = getCurrentVersion();
  
  if (current === 'unknown') {
    return {
      current,
      latest: null,
      hasUpdate: false,
      error: 'Could not determine current version',
    };
  }

  try {
    const response = await fetch('https://registry.npmjs.org/codeep/latest', {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const latest = data.version;

    const hasUpdate = compareVersions(latest, current) > 0;

    return {
      current,
      latest,
      hasUpdate,
    };
  } catch (error) {
    return {
      current,
      latest: null,
      hasUpdate: false,
      error: error instanceof Error ? error.message : 'Failed to check for updates',
    };
  }
}

/**
 * Compare two semver versions
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.replace(/^v/, '').split('.').map(Number);
  const bParts = b.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0;
    const bPart = bParts[i] || 0;

    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }

  return 0;
}

/**
 * Detect installation method
 */
function detectInstallMethod(): 'npm' | 'homebrew' | 'binary' {
  const execPath = process.execPath;
  const argv0 = process.argv[0];
  
  // Homebrew detection - installed in Cellar or with homebrew in path
  if (execPath.includes('/Cellar/codeep') || 
      execPath.includes('homebrew') ||
      execPath.includes('/opt/homebrew')) {
    return 'homebrew';
  }
  
  // npm global detection - running via node with npm in path
  if (process.env.npm_package_name === 'codeep' ||
      execPath.includes('/.npm/') ||
      execPath.includes('/npm/') ||
      argv0.includes('node')) {
    return 'npm';
  }
  
  // Binary installation (curl install or manual download)
  return 'binary';
}

/**
 * Get update instructions based on installation method
 */
export function getUpdateInstructions(): string {
  const method = detectInstallMethod();
  
  switch (method) {
    case 'homebrew':
      return 'brew update && brew upgrade codeep';
    
    case 'npm':
      return 'npm update -g codeep';
    
    case 'binary':
      return 'curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | bash';
    
    default:
      return 'Visit: https://codeep.dev';
  }
}

/**
 * Format version info for display
 */
export function formatVersionInfo(info: VersionInfo): string {
  if (info.error) {
    return `Current: ${info.current}\nUpdate check failed: ${info.error}`;
  }

  if (!info.latest) {
    return `Current: ${info.current}\nCould not check for updates`;
  }

  if (info.hasUpdate) {
    const instructions = getUpdateInstructions();
    return `Current: ${info.current}\nLatest: ${info.latest}\n\nUpdate available! Run:\n  ${instructions}`;
  }

  return `Current: ${info.current}\nYou're running the latest version! 🎉`;
}
