import Conf from 'conf';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

import { PROVIDERS, getProvider, getProviderBaseUrl } from './providers';
import { logSession } from '../utils/logger';
import { createSecureStorage, type SecureStorage } from '../utils/keychain';

interface Session {
  name: string;
  title?: string;
  /** LLM-generated one-liner (utils/sessionTitles.ts). Preferred over
   *  `title` when present — see listSessionsWithInfo. */
  aiTitle?: string;
  history: Message[];
  createdAt: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

type LanguageCode = 'auto' | 'en' | 'zh' | 'es' | 'hi' | 'ar' | 'pt' | 'fr' | 'de' | 'ja' | 'ru' | 'hr';

interface ProjectPermission {
  path: string;
  readPermission: boolean;
  writePermission: boolean;
  grantedAt: string;
}

// Shape of .codeep/config.json (local per-project config)
interface LocalProjectConfig {
  permission?: ProjectPermission;
  [key: string]: unknown;
}

interface ProviderApiKey {
  providerId: string;
  apiKey: string;
}

type AgentMode = 'on' | 'manual';

interface ConfigSchema {
  apiKey: string; // Legacy, kept for backwards compatibility
  provider: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  plan: 'lite' | 'pro' | 'max';
  language: LanguageCode;
  autoSave: boolean;
  /** Auto-generate an LLM one-liner title for sessions on save. Makes a
   *  small background API call (uses the active model) once per session.
   *  Default true; set false to avoid any unsolicited API calls. */
  autoSessionTitle: boolean;
  /** When prior chat history overflows the agent's context budget, summarize
   *  the dropped (oldest) messages via one LLM call instead of silently
   *  discarding them — so long sessions keep early decisions/constraints.
   *  Default true; set false to fall back to plain truncation (no extra call). */
  autoSummarizeHistory: boolean;
  /** Inject the user profile (`~/.codeep/profile.md` + project
   *  `.codeep/profile.md`) into the agent's system prompt so it adapts to the
   *  user (reply language, style, stack, preferences). Default true; set false
   *  to keep the profile files but stop injecting them. Managed via `/me`. */
  userProfile: boolean;
  /** Auto-learn: at session save, run one LLM pass to extract durable facts /
   *  preferences about the user and merge them into `~/.codeep/profile.learned.md`
   *  (injected alongside the hand-written profile). OFF by default — opt in via
   *  `/me learn on`. Throttled + single-flight so it doesn't spam API calls. */
  autoLearnProfile: boolean;
  /** Absolute workspace roots whose project-local `.codeep/hooks/*` the user
   *  has approved to run. Untrusted projects' hooks are skipped (a cloned repo
   *  can't execute shell on first tool call). Granted via `/hooks trust`. */
  trustedHookProjects: string[];
  currentSessionId: string;
  /** Highest one-shot config migration applied (see the migration block
   *  after config creation). Bump MIGRATION_VERSION when adding one. */
  migrationVersion: number;
  temperature: number;
  maxTokens: number;
  apiTimeout: number;
  rateLimitApi: number; // API requests per minute
  rateLimitCommands: number; // Commands per minute
  agentMode: AgentMode; // on = always use agent, manual = use /agent command
  ollamaUrl: string; // Ollama base URL (default: http://localhost:11434)
  /** Route Ollama through its NATIVE /api/chat endpoint instead of the
   *  OpenAI-compatible /v1 shim. The native endpoint honors num_ctx + keep_alive
   *  and exposes the model's real context window. OFF by default — opt-in until
   *  verified against a live Ollama; when off, the existing /v1 path is used
   *  unchanged so current behavior is preserved. */
  ollamaNativeApi: boolean;
  /** How long Ollama keeps the model loaded in memory between requests (e.g.
   *  "30m", "1h", "-1" for forever). Avoids reload latency every turn. Sent on
   *  native /api/chat requests (only when ollamaNativeApi is on). Default "30m". */
  ollamaKeepAlive: string;
  /** Override num_ctx (context window) for Ollama. 0 = auto-detect the model's
   *  real max via /api/show. Set a specific number to cap VRAM use. Default 0. */
  ollamaNumCtx: number;
  customBaseUrl: string; // Base URL for the "custom" OpenAI-compatible provider (e.g. vLLM/LiteLLM: http://host:8000/v1)
  agentConfirmation: 'always' | 'dangerous' | 'never'; // Confirmation mode for agent actions
  agentConfirmDeleteFile: boolean; // Confirm before delete_file in dangerous mode
  agentConfirmExecuteCommand: boolean; // Confirm before execute_command in dangerous mode
  agentConfirmWriteFile: boolean; // Confirm before write_file/edit_file in dangerous mode
  agentAutoCommit: boolean; // Auto-commit after agent completes
  agentAutoCommitBranch: boolean; // Create new branch for commits
  agentAutoVerify: 'off' | 'build' | 'typecheck' | 'test' | 'all'; // Auto-run verification after changes
  /** After a top-level agent run that changed files, delegate to the `reviewer`
   *  sub-agent and append its findings — a guaranteed review stage. Default
   *  false (opt-in); one extra nested LLM pass when on. */
  agentAutoReview: boolean;
  agentMaxFixAttempts: number; // Max attempts to fix errors (default: 1)
  agentMaxIterations: number; // Max agent iterations (default: 50)
  agentMaxDuration: number; // Max agent duration in minutes (default: 20)
  agentApiTimeout: number; // Base API timeout for agent in ms (default: 90000, dynamically adjusted)
  agentInteractive: boolean; // Show interactive mode (default: true)
  projectPermissions: ProjectPermission[];
  /** @deprecated Legacy PLAINTEXT key store. Kept only so the one-time
   *  migration into secure storage can read it; emptied afterwards. New keys
   *  go to the OS keychain via utils/keychain.ts — never written here. */
  providerApiKeys: ProviderApiKey[];
  /** Non-secret index of provider IDs that have a key in secure storage, so we
   *  can list/load configured providers without probing the keychain for all
   *  providers. Secrets themselves never live here. */
  configuredProviderIds: string[];
  /** True once legacy plaintext keys (providerApiKeys / apiKey) have been
   *  migrated into secure storage and wiped from the config file. */
  keysSecured: boolean;
  /** Plaintext fallback key map used by utils/keychain.ts ONLY when the OS
   *  keychain is unavailable. Swept into the keychain once it becomes available
   *  (see sweepFallbackKeysToKeychain). Empty {} on keychain-capable systems. */
  apiKeys?: Record<string, string>;
  /** Master switch for automatic cloud uploads (usage stats, session
   *  transcripts, progress, memory notes). Default true; set false to opt out.
   *  The CODEEP_NO_TELEMETRY / DO_NOT_TRACK env vars also force it off. */
  telemetry: boolean;
  /** Opt-in to syncing API keys to codeep.dev (`codeep account push`/`sync`).
   *  OFF by default — keys live only in the OS keychain unless you enable this.
   *  Synced keys are stored server-readable (AES from a server-held secret), so
   *  this is an explicit consent switch. Enable via `/keysync on` or Settings;
   *  the CODEEP_NO_KEY_SYNC env var forces it off (org-policy hard switch). */
  syncKeysToCloud: boolean;
  githubId: string;
  githubUsername: string;
  syncToken: string;
  deviceId: string;
  /** OpenRouter provider-routing preferences (see utils/openrouterPrefs.ts). */
  openrouterPreferences?: {
    order?: string[];
    allow_fallbacks?: boolean;
    ignore?: string[];
    data_collection?: 'allow' | 'deny';
    require_parameters?: boolean;
  };
  /**
   * Active personality preset (`concise`, `senior-reviewer`, custom user
   * personalities from .codeep/personalities/*.md, …). When set, the
   * loader text is appended to every agent system prompt. See
   * utils/personalities.ts.
   */
  activePersonality?: string | null;
}

export type { AgentMode };

export type { LanguageCode };

// We'll initialize GLOBAL_SESSIONS_DIR after config is created (to use config.path)

/**
 * Get sessions directory - local .codeep/sessions/ if in project, otherwise global
 */
function getSessionsDir(projectPath?: string): string {
  if (projectPath && isProjectDirectory(projectPath)) {
    const localDir = join(projectPath, '.codeep', 'sessions');
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }
    return localDir;
  }
  return GLOBAL_SESSIONS_DIR;
}

/**
 * Get local project config path
 */
function getLocalConfigPath(projectPath: string): string | null {
  if (!isProjectDirectory(projectPath)) return null;
  const configDir = join(projectPath, '.codeep');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return join(configDir, 'config.json');
}

/**
 * Check if directory is a project
 * Looks for common project indicators: package.json, pyproject.toml, Cargo.toml, go.mod, composer.json, etc.
 * Also checks if user has manually initialized this folder as a project (.codeep/project.json)
 */
function isProjectDirectory(path: string): boolean {
  // Check if user has manually initialized this as a project
  const manualProjectMarker = join(path, '.codeep', 'project.json');
  if (existsSync(manualProjectMarker)) {
    return true;
  }
  
  const projectFiles = [
    'package.json',      // Node.js
    'pyproject.toml',    // Python (Poetry)
    'requirements.txt',  // Python (pip)
    'setup.py',          // Python
    'Cargo.toml',        // Rust
    'go.mod',            // Go
    'composer.json',     // PHP
    'pom.xml',           // Java (Maven)
    'build.gradle',      // Java (Gradle)
    '.git',              // Git repository
  ];
  
  return projectFiles.some(file => existsSync(join(path, file)));
}

/**
 * Check if directory has standard project markers (not manually initialized)
 */
export function hasStandardProjectMarkers(path: string): boolean {
  const projectFiles = [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'Cargo.toml',
    'go.mod',
    'composer.json',
    'pom.xml',
    'build.gradle',
    '.git',
  ];
  
  return projectFiles.some(file => existsSync(join(path, file)));
}

/**
 * Initialize a folder as a Codeep project
 * Creates .codeep/project.json marker file
 */
export function initializeAsProject(path: string): boolean {
  try {
    const codeepDir = join(path, '.codeep');
    if (!existsSync(codeepDir)) {
      mkdirSync(codeepDir, { recursive: true });
    }
    
    const projectFile = join(codeepDir, 'project.json');
    const projectData = {
      name: path.split('/').pop() || 'project',
      initializedAt: new Date().toISOString(),
      version: '1.0',
    };
    
    writeFileSync(projectFile, JSON.stringify(projectData, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if folder was manually initialized as project
 */
export function isManuallyInitializedProject(path: string): boolean {
  return existsSync(join(path, '.codeep', 'project.json'));
}

/**
 * Get fallback config directory if standard location is not writable
 * Falls back to .codeep in current working directory
 */
function getFallbackConfigDir(): string | undefined {
  const cwdConfig = join(process.cwd(), '.codeep');
  try {
    if (!existsSync(cwdConfig)) {
      mkdirSync(cwdConfig, { recursive: true });
    }
    return cwdConfig;
  } catch {
    return undefined;
  }
}

/**
 * Check if a directory is writable
 */
function isWritable(dir: string): boolean {
  try {
    const testFile = join(dir, '.write-test');
    writeFileSync(testFile, 'test');
    unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create config with fallback logic
 * 1. Try standard Conf location (~/.config/codeep-nodejs on Linux, etc.)
 * 2. If not writable, use .codeep in current working directory
 */
function createConfig(): Conf<ConfigSchema> {
  const defaults: ConfigSchema = {
    apiKey: '',
    migrationVersion: 0,
    provider: 'z.ai',
    model: 'glm-5.2',
    agentMode: 'on',
    ollamaUrl: 'http://localhost:11434',
    ollamaNativeApi: false,
    ollamaKeepAlive: '30m',
    ollamaNumCtx: 0,
    customBaseUrl: '',
    agentConfirmation: 'dangerous',
    agentConfirmDeleteFile: true,
    agentConfirmExecuteCommand: true,
    agentConfirmWriteFile: false,
    agentAutoCommit: false,
    agentAutoCommitBranch: false,
    agentAutoVerify: 'off',
    agentAutoReview: false,
    // One fix attempt is enough for modern models — if verification fails twice
    // with the same approach, the agent usually needs human input, not more loops.
    agentMaxFixAttempts: 1,
    // Sane ceiling: typical coding tasks finish in 3–8 iterations; 50 covers
    // multi-file refactors comfortably. Users can raise this in /settings
    // for large autonomous tasks.
    agentMaxIterations: 50,
    agentMaxDuration: 480,
    agentApiTimeout: 600000,
    agentInteractive: true,
    protocol: 'openai',
    plan: 'lite',
    language: 'en',
    autoSave: true,
    autoSessionTitle: true,
    autoSummarizeHistory: true,
    userProfile: true,
    autoLearnProfile: false,
    trustedHookProjects: [],
    currentSessionId: '',
    temperature: 0.7,
    maxTokens: 32768,
    apiTimeout: 60000,
    rateLimitApi: 10000,
    rateLimitCommands: 10000,
    projectPermissions: [],
    providerApiKeys: [],
    configuredProviderIds: [],
    keysSecured: false,
    apiKeys: {},
    telemetry: true,
    syncKeysToCloud: false,
    githubId: '',
    githubUsername: '',
    syncToken: '',
    deviceId: '',
  };

  // Test/CI isolation: when CODEEP_CONFIG_DIR is set, keep config in that
  // directory (one per test worker) so parallel workers don't race on a shared
  // on-disk config file (e.g. clobbering trustedHookProjects). Never set in
  // normal use, so the production resolution below is unchanged.
  const overrideDir = process.env.CODEEP_CONFIG_DIR;
  if (overrideDir) {
    try {
      return new Conf<ConfigSchema>({ projectName: 'codeep', cwd: overrideDir, defaults });
    } catch {
      // fall through to standard resolution
    }
  }

  // First try standard location
  try {
    const standardConfig = new Conf<ConfigSchema>({
      projectName: 'codeep',
      defaults,
    });
    
    // Test if we can write to the config directory
    const configDir = dirname(standardConfig.path);
    if (isWritable(configDir)) {
      return standardConfig;
    }
  } catch {
    // Standard location failed, try fallback
  }
  
  // Fallback: use .codeep in current working directory
  const fallbackDir = getFallbackConfigDir();
  if (fallbackDir) {
    try {
      return new Conf<ConfigSchema>({
        projectName: 'codeep',
        cwd: fallbackDir,
        defaults,
      });
    } catch {
      // Even fallback failed
    }
  }
  
  // Last resort: use standard config anyway (may fail on write)
  return new Conf<ConfigSchema>({
    projectName: 'codeep',
    defaults,
  });
}

export const config = createConfig();

// Migrate old 'auto' value to 'on'
if ((config.get('agentMode') as string) === 'auto') {
  config.set('agentMode', 'on');
}

// One-shot migrations of old defaults. These used to run unconditionally on
// EVERY startup, which silently clobbered values the user later chose in
// /settings (e.g. maxTokens 8192 was forced back to 32768 each launch — the
// affected sliders were effectively lies). Each migration now runs exactly
// once per config, recorded via `migrationVersion`; after that, whatever the
// user sets sticks. Bump MIGRATION_VERSION when adding a new one.
const MIGRATION_VERSION = 1;
if ((config.get('migrationVersion') ?? 0) < 1) {
  // Migrate the old runaway default (10000 iterations) down to a sane
  // ceiling, and old conservative defaults up to the current ones.
  if (config.get('agentMaxIterations') >= 10000) {
    config.set('agentMaxIterations', 50);
  }
  if (config.get('agentMaxDuration') < 480) {
    config.set('agentMaxDuration', 480);
  }
  if (config.get('maxTokens') < 32768) {
    config.set('maxTokens', 32768);
  }
  if (config.get('agentApiTimeout') <= 180000) {
    config.set('agentApiTimeout', 600000);
  }
  if (config.get('rateLimitApi') <= 30) {
    config.set('rateLimitApi', 10000);
  }
  if (config.get('rateLimitCommands') <= 100) {
    config.set('rateLimitCommands', 10000);
  }
  config.set('migrationVersion', MIGRATION_VERSION);
}

// Global sessions directory - use same directory as conf package for cross-platform consistency
// config.path gives us something like ~/.config/codeep-nodejs/config.json, we use its parent
const GLOBAL_BASE_DIR = dirname(config.path);
const GLOBAL_SESSIONS_DIR = join(GLOBAL_BASE_DIR, 'sessions');

// Ensure global sessions directory exists
if (!existsSync(GLOBAL_SESSIONS_DIR)) {
  mkdirSync(GLOBAL_SESSIONS_DIR, { recursive: true });
}

// In-memory cache for API keys (populated on first access)
const apiKeyCache = new Map<string, string>();

// ── Secure key storage (OS keychain, plaintext-config fallback) ──────────────
// API keys persist in the OS keychain via utils/keychain.ts. The cache above is
// the synchronous read path (getApiKey); the keychain is the async persistence
// layer (set/load). A non-secret `configuredProviderIds` index in config tells
// us which providers have a key without probing the keychain for every provider.
let _secureKeyStore: SecureStorage | null = null;
function secureKeyStore(): SecureStorage {
  if (!_secureKeyStore) _secureKeyStore = createSecureStorage(config);
  return _secureKeyStore;
}

function addConfiguredProviderId(providerId: string): void {
  const ids = config.get('configuredProviderIds') || [];
  if (!ids.includes(providerId)) {
    config.set('configuredProviderIds', [...ids, providerId]);
  }
}

function removeConfiguredProviderId(providerId: string): void {
  const ids = config.get('configuredProviderIds') || [];
  if (ids.includes(providerId)) {
    config.set('configuredProviderIds', ids.filter(id => id !== providerId));
  }
}

let _migrationPromise: Promise<void> | null = null;
/**
 * One-time migration of legacy PLAINTEXT keys (the `providerApiKeys` array and
 * the very-old single `apiKey` field) into secure storage, then wipe the
 * plaintext from the config file. Idempotent and guarded so concurrent callers
 * share a single run. Each key's plaintext is wiped only after its write to
 * secure storage actually succeeds; any key that fails to persist is retained
 * and `keysSecured` stays false so the next startup retries — the last copy of
 * a secret is never destroyed before a new copy is confirmed.
 */
async function migrateKeysToSecureStorage(): Promise<void> {
  if (config.get('keysSecured')) return;
  // Dedupe concurrent callers (loadApiKey + loadAllApiKeys at startup) onto a
  // single run; cleared in finally so a later un-secured state can re-migrate.
  if (!_migrationPromise) {
    _migrationPromise = (async () => {
      const store = secureKeyStore();
      const legacyArray = config.get('providerApiKeys') || [];
      // Only drain entries we actually persisted; keep failures so the next
      // startup retries instead of destroying the last copy of a key.
      const failed: ProviderApiKey[] = [];
      for (const entry of legacyArray) {
        if (!entry?.providerId || !entry?.apiKey) continue;
        try {
          await store.setApiKey(entry.providerId, entry.apiKey);
          addConfiguredProviderId(entry.providerId);
        } catch {
          failed.push(entry);
        }
      }
      const legacySingle = config.get('apiKey');
      let legacySingleMigrated = false;
      if (legacySingle) {
        try {
          await store.setApiKey('z.ai', legacySingle);
          addConfiguredProviderId('z.ai');
          legacySingleMigrated = true;
        } catch { /* keep the legacy field for retry */ }
      }
      // Wipe only the plaintext that made it into secure storage.
      config.set('providerApiKeys', failed);
      if (legacySingle && legacySingleMigrated) config.set('apiKey', '');
      // Mark secured only when everything migrated; a partial failure retries.
      if (failed.length === 0 && (!legacySingle || legacySingleMigrated)) {
        config.set('keysSecured', true);
      }
    })();
  }
  try { await _migrationPromise; } finally { _migrationPromise = null; }
}

let _sweepPromise: Promise<void> | null = null;
/**
 * If the OS keychain is now available but API keys are still sitting in the
 * plaintext `apiKeys` fallback map (written by utils/keychain.ts while the
 * keychain was unavailable on a prior run), move each into the keychain. The
 * keychain write also deletes the entry from the plaintext fallback map, so a
 * successful sweep leaves no plaintext behind. Cheap no-op when the map is
 * empty or the keychain is unavailable; deduped for concurrent callers. Runs
 * independently of `keysSecured` so a key written during a keychain outage is
 * still swept up later.
 */
async function sweepFallbackKeysToKeychain(): Promise<void> {
  if (!_sweepPromise) {
    _sweepPromise = (async () => {
      const store = secureKeyStore();
      // Only sweep when the keychain is actually usable; otherwise leave the
      // plaintext fallback in place (there's nowhere safer to move it).
      if (!store.isKeychainAvailable || !(await store.isKeychainAvailable())) return;
      const plaintext = config.get('apiKeys') || {};
      for (const [providerId, apiKey] of Object.entries(plaintext)) {
        if (typeof apiKey !== 'string' || !apiKey) continue;
        try {
          await store.setApiKey(providerId, apiKey); // writes keychain + deletes from fallback map
          addConfiguredProviderId(providerId);
        } catch { /* keep the plaintext entry on failure — never lose a key */ }
      }
    })();
  }
  try { await _sweepPromise; } finally { _sweepPromise = null; }
}

export const LANGUAGES: Record<string, string> = {
  'auto': 'Auto-detect',
  'en': 'English',
  'zh': 'Chinese',
  'es': 'Spanish',
  'hi': 'Hindi',
  'ar': 'Arabic',
  'pt': 'Portuguese',
  'fr': 'French',
  'de': 'German',
  'ja': 'Japanese',
  'ru': 'Russian',
  'hr': 'Croatian',
};

export const PROTOCOLS: Record<string, string> = {
  'openai': 'OpenAI Compatible',
  'anthropic': 'Anthropic Protocol',
};

// Get API key for current or specified provider
/**
 * Load API key from config into cache
 */
export async function loadApiKey(providerId?: string): Promise<string> {
  const provider = providerId || config.get('provider');
  const providerConfig = getProvider(provider);
  
  // Check environment variable first
  if (providerConfig?.envKey) {
    const envKey = process.env[providerConfig.envKey];
    if (envKey) {
      apiKeyCache.set(provider, envKey);
      return envKey;
    }
  }
  
  // Legacy env vars for z.ai
  if (provider === 'z.ai') {
    if (process.env.ZAI_API_KEY) {
      apiKeyCache.set(provider, process.env.ZAI_API_KEY);
      return process.env.ZAI_API_KEY;
    }
    if (process.env.ZHIPUAI_API_KEY) {
      apiKeyCache.set(provider, process.env.ZHIPUAI_API_KEY);
      return process.env.ZHIPUAI_API_KEY;
    }
  }
  
  // Secure storage (OS keychain). Migrate any legacy plaintext keys first.
  await migrateKeysToSecureStorage();
  const stored = await secureKeyStore().getApiKey(provider);
  if (stored) {
    apiKeyCache.set(provider, stored);
    return stored;
  }

  return '';
}

/**
 * Load API keys for ALL providers into cache
 * Should be called at app startup
 */
export async function loadAllApiKeys(): Promise<void> {
  // Migrate any legacy plaintext keys, then sweep any keychain-fallback plaintext
  // up into the keychain (no-op when none / keychain unavailable), then load all
  // from secure storage using the non-secret configuredProviderIds index.
  await migrateKeysToSecureStorage();
  await sweepFallbackKeysToKeychain();
  const store = secureKeyStore();
  for (const providerId of (config.get('configuredProviderIds') || [])) {
    const key = await store.getApiKey(providerId);
    if (key) apiKeyCache.set(providerId, key);
  }

  // Also check environment variables for each provider
  for (const [providerId, providerConfig] of Object.entries(PROVIDERS)) {
    if (providerConfig.envKey) {
      const envKey = process.env[providerConfig.envKey];
      if (envKey) {
        apiKeyCache.set(providerId, envKey);
      }
    }
  }
  
  // Legacy env vars for z.ai (the legacy `apiKey` config field is migrated into
  // secure storage by migrateKeysToSecureStorage above).
  if (!apiKeyCache.get('z.ai')) {
    if (process.env.ZAI_API_KEY) {
      apiKeyCache.set('z.ai', process.env.ZAI_API_KEY);
    } else if (process.env.ZHIPUAI_API_KEY) {
      apiKeyCache.set('z.ai', process.env.ZHIPUAI_API_KEY);
    }
  }
}

/**
 * Get API key synchronously from cache (must call loadAllApiKeys first)
 */
export function getApiKey(providerId?: string): string {
  const provider = providerId || config.get('provider');
  return apiKeyCache.get(provider) || '';
}

/**
 * Set API key — persists to secure storage (OS keychain), never plaintext.
 * Returns a promise, but updates the synchronous cache first so callers that
 * fire-and-forget still see the key immediately via getApiKey().
 */
export async function setApiKey(key: string, providerId?: string): Promise<void> {
  const provider = providerId || config.get('provider');

  // Update cache immediately so synchronous getApiKey() works right away.
  apiKeyCache.set(provider, key);

  // Persist to secure storage (keychain, or plaintext-config fallback if the
  // keychain is unavailable — utils/keychain.ts warns in that case). Let a hard
  // persistence failure propagate so callers can report it instead of claiming
  // success; the index + secured flag are set only after a confirmed write.
  await secureKeyStore().setApiKey(provider, key);
  addConfiguredProviderId(provider);
  // No plaintext key was written here, so the store is already "secured".
  config.set('keysSecured', true);
}

export function getMaskedApiKey(providerId?: string): string {
  const key = getApiKey(providerId);
  if (key.length > 4) {
    return '*'.repeat(key.length - 4) + key.slice(-4);
  }
  return key;
}

/**
 * Get list of providers that have API keys configured
 */
export function getConfiguredProviders(): { id: string; name: string }[] {
  const ids = config.get('configuredProviderIds') || [];
  return ids.map(id => ({ id, name: getProvider(id)?.name || id }));
}

/**
 * Whether automatic cloud uploads are allowed (usage stats, session
 * transcripts, progress, memory notes). Opt out via the `telemetry: false`
 * config flag, the CODEEP_NO_TELEMETRY env var, or the cross-tool DO_NOT_TRACK
 * convention. Explicit `codeep account push/sync` commands are user-initiated
 * and are NOT gated by this.
 */
function envForcesTelemetryOff(): boolean {
  const off = (v?: string) => !!v && !/^(0|false|no|off)$/i.test(v.trim());
  return off(process.env.CODEEP_NO_TELEMETRY) || off(process.env.DO_NOT_TRACK);
}

export function isTelemetryEnabled(): boolean {
  if (envForcesTelemetryOff()) return false;
  return config.get('telemetry') !== false;
}

/**
 * True when an env var (CODEEP_NO_TELEMETRY / DO_NOT_TRACK) is forcing telemetry
 * off — in which case the `telemetry` config flag can't turn it back on. Lets
 * the /telemetry command explain why a toggle had no effect.
 */
export function telemetryForcedOffByEnv(): boolean {
  return envForcesTelemetryOff();
}

/**
 * Whether syncing API keys to the cloud is allowed. OFF by default (opt-in):
 * unlike telemetry, this also gates the EXPLICIT `codeep account push` and the
 * key-download half of `account sync`, because pushing a key stores it
 * server-readable. The CODEEP_NO_KEY_SYNC env var forces it off as an
 * org-policy hard switch the config flag can't override.
 */
function envForcesKeySyncOff(): boolean {
  const off = (v?: string) => !!v && !/^(0|false|no|off)$/i.test(v.trim());
  return off(process.env.CODEEP_NO_KEY_SYNC);
}

export function isKeySyncEnabled(): boolean {
  if (envForcesKeySyncOff()) return false;
  return config.get('syncKeysToCloud') === true; // default OFF — must be explicitly true
}

/**
 * True when CODEEP_NO_KEY_SYNC is forcing key sync off — so the `syncKeysToCloud`
 * flag can't turn it back on. Lets the /keysync command explain why a toggle had
 * no effect.
 */
export function keySyncForcedOffByEnv(): boolean {
  return envForcesKeySyncOff();
}

/**
 * Clear API key for a specific provider
 */
export async function clearApiKey(providerId: string): Promise<void> {
  // Clear from cache
  apiKeyCache.delete(providerId);

  // Clear from secure storage + the non-secret index
  try { await secureKeyStore().deleteApiKey(providerId); } catch { /* ignore */ }
  removeConfiguredProviderId(providerId);
}

export async function isConfiguredAsync(providerId?: string): Promise<boolean> {
  const key = await loadApiKey(providerId);
  return Boolean(key);
}

export function isConfigured(providerId?: string): boolean {
  return Boolean(getApiKey(providerId));
}

// Get current provider info
export function getCurrentProvider(): { id: string; name: string } {
  let providerId = config.get('provider');
  let provider = getProvider(providerId);

  // If stored provider no longer exists in registry, fall back to first available
  if (!provider) {
    const fallback = Object.keys(PROVIDERS)[0];
    if (fallback) {
      providerId = fallback;
      provider = getProvider(fallback);
      config.set('provider', fallback);
    }
  }

  return {
    id: providerId,
    name: provider?.name || providerId,
  };
}

// Set provider and update model/protocol to defaults
export function setProvider(providerId: string): boolean {
  const provider = getProvider(providerId);
  if (!provider) return false;
  
  config.set('provider', providerId);
  config.set('model', provider.defaultModel);
  config.set('protocol', provider.defaultProtocol);
  
  // Load API key for the new provider into cache
  // This is async but we fire-and-forget since the key will be loaded before next API call
  loadApiKey(providerId).catch(() => { /* key will be fetched again on next API call */ });
  
  return true;
}

// Get models for current provider
export function getModelsForCurrentProvider(): Record<string, string> {
  const providerId = config.get('provider');
  const provider = getProvider(providerId);
  if (!provider) return {};

  const models: Record<string, string> = {};
  for (const model of provider.models) {
    models[model.id] = `${model.name} - ${model.description}`;
  }
  return models;
}

/**
 * Fetch the full OpenRouter model catalog (100+ entries) including pricing.
 * Cached for 5 minutes per process — the catalog changes daily-ish, not
 * per-keystroke. Returns null on network / parse failure so callers fall
 * back to the hardcoded shortlist in `providers.ts`.
 */
interface OpenRouterModelEntry {
  id: string;
  name?: string;
  description?: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
}
let openRouterCache: { fetchedAt: number; models: { id: string; name: string; description: string }[] } | null = null;
const OPENROUTER_CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchOpenRouterModels(apiKey?: string): Promise<{ id: string; name: string; description: string }[] | null> {
  if (openRouterCache && Date.now() - openRouterCache.fetchedAt < OPENROUTER_CACHE_TTL_MS) {
    return openRouterCache.models;
  }
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: OpenRouterModelEntry[] };
    if (!Array.isArray(data.data)) return null;

    // Format pricing for the dropdown description so users can pick cheap
    // models without leaving the picker. OpenRouter returns USD-per-token
    // as strings like "0.000003" — multiply by 1M for the per-1M figure
    // most users think in.
    const models = data.data
      .filter(m => typeof m.id === 'string')
      .map(m => {
        const inPrice = m.pricing?.prompt ? Number(m.pricing.prompt) * 1_000_000 : null;
        const outPrice = m.pricing?.completion ? Number(m.pricing.completion) * 1_000_000 : null;
        const priceStr = inPrice !== null && outPrice !== null
          ? ` · $${inPrice.toFixed(2)} in / $${outPrice.toFixed(2)} out per 1M`
          : '';
        const ctxStr = m.context_length ? ` · ${Math.round(m.context_length / 1000)}K ctx` : '';
        return {
          id: m.id,
          name: m.name ?? m.id,
          description: (m.description?.slice(0, 80) ?? 'OpenRouter model') + priceStr + ctxStr,
        };
      });
    openRouterCache = { fetchedAt: Date.now(), models };
    return models;
  } catch {
    return null;
  }
}

export async function fetchOllamaModels(baseUrl?: string): Promise<{ id: string; name: string; description: string }[] | null> {
  const url = (baseUrl || config.get('ollamaUrl') || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: { name: string; size?: number }[] };
    if (!data.models) return null;
    return data.models.map(m => ({
      id: m.name,
      name: m.name,
      description: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : 'local model',
    }));
  } catch {
    return null;
  }
}

/**
 * Fetch the model list from an OpenAI-compatible server's `/models`
 * endpoint (vLLM, LiteLLM, LM Studio, etc.). `baseUrl` is the full base
 * (e.g. http://host:8000/v1). Returns null on error.
 */
export async function fetchOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<{ id: string; name: string; description: string }[] | null> {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string }[] };
    if (!Array.isArray(data.data)) return null;
    return data.data.map(m => ({ id: m.id, name: m.id, description: '' }));
  } catch {
    return null;
  }
}

/**
 * Resolve the effective OpenAI-protocol base URL for a provider, honoring
 * user overrides the static provider table can't express:
 *   - ollama  → configured `ollamaUrl` + /v1
 *   - custom  → configured `customBaseUrl` (full base, e.g. http://host:8000/v1)
 *   - openai  → the OPENAI_BASE_URL env var, if set (OpenAI-SDK convention)
 * Falls back to the provider's hardcoded base URL. Only the `openai`
 * protocol takes overrides; the anthropic protocol uses the static table.
 */
export function resolveBaseUrl(providerId: string, protocol: 'openai' | 'anthropic'): string | null {
  const fallback = getProviderBaseUrl(providerId, protocol);
  if (protocol !== 'openai') return fallback;
  if (providerId === 'ollama') {
    const u = (config.get('ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, '');
    return `${u}/v1`;
  }
  if (providerId === 'custom') {
    const u = (config.get('customBaseUrl') || '').trim().replace(/\/+$/, '');
    return u || fallback;
  }
  if (providerId === 'openai') {
    const env = (process.env.OPENAI_BASE_URL || '').trim().replace(/\/+$/, '');
    if (env) return env;
  }
  return fallback;
}

// Re-export PROVIDERS for convenience
export { PROVIDERS } from './providers';

// Generate unique session ID
function generateSessionId(): string {
  const date = new Date().toISOString().split('T')[0];
  return `session-${date}-${randomUUID().slice(0, 8)}`;
}

// Get or create current session ID
export function getCurrentSessionId(): string {
  let sessionId = config.get('currentSessionId');
  if (!sessionId) {
    sessionId = generateSessionId();
    config.set('currentSessionId', sessionId);
  }
  return sessionId;
}

// Start new session
export function startNewSession(): string {
  const sessionId = generateSessionId();
  config.set('currentSessionId', sessionId);
  return sessionId;
}

// Auto-save debounce state
let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingAutoSave: { history: Message[]; projectPath?: string } | null = null;

// Auto-save current session (debounced - saves max every 5 seconds)
export function autoSaveSession(history: Message[], projectPath?: string): boolean {
  if (!config.get('autoSave') || history.length === 0) {
    return false;
  }
  
  // Store pending save data
  pendingAutoSave = { history, projectPath };
  
  // If already scheduled, don't reschedule
  if (autoSaveTimeout) {
    return true;
  }
  
  // Schedule save after 5 seconds
  autoSaveTimeout = setTimeout(() => {
    if (pendingAutoSave) {
      const sessionId = getCurrentSessionId();
      saveSession(sessionId, pendingAutoSave.history, pendingAutoSave.projectPath);
      pendingAutoSave = null;
    }
    autoSaveTimeout = null;
  }, 5000);
  
  return true;
}

// Force immediate save (for explicit save commands)
export function flushAutoSave(): boolean {
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = null;
  }
  if (pendingAutoSave) {
    const sessionId = getCurrentSessionId();
    const result = saveSession(sessionId, pendingAutoSave.history, pendingAutoSave.projectPath);
    pendingAutoSave = null;
    return result;
  }
  return false;
}

// Session management
export function saveSession(name: string, history: Message[], projectPath?: string): boolean {
  try {
    // Derive a human-readable title from the first user message
    const firstUserMsg = history.find(m => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.replace(/\n/g, ' ').trim().slice(0, 60)
      : name;
    const sessionsDir = getSessionsDir(projectPath);
    const filePath = join(sessionsDir, `${name}.json`);
    // Preserve an existing aiTitle across re-saves so we don't regenerate.
    let existingAiTitle: string | undefined;
    if (existsSync(filePath)) {
      try {
        const prev = JSON.parse(readFileSync(filePath, 'utf-8')) as Session;
        existingAiTitle = prev.aiTitle;
      } catch { /* ignore corrupt prior file */ }
    }
    const session: Session = {
      name,
      title,
      aiTitle: existingAiTitle,
      history,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(filePath, JSON.stringify(session, null, 2));
    logSession('save', name, true);

    // Fire-and-forget: generate an AI title once the session has enough
    // content. The orchestrator early-returns if one already exists, so
    // this is a no-op on every save after the first successful generation.
    // Gated by autoSessionTitle so privacy/cost-conscious users can opt out
    // of the (small, background) API call entirely.
    if (config.get('autoSessionTitle') !== false
        && !existingAiTitle
        && history.filter(m => m.role !== 'system').length >= 3) {
      void maybeGenerateSessionTitle(name, projectPath).catch(() => {});
    }

    // Fire-and-forget: when the user opted into profile learning, observe the
    // session and merge durable facts into ~/.codeep/profile.learned.md.
    // Throttled + single-flight inside maybeLearnUserProfile, so the 5s
    // autosave cadence doesn't spawn an LLM call every tick. Default off.
    if (config.get('autoLearnProfile') === true
        && history.filter(m => m.role !== 'system').length >= 4) {
      void import('../utils/userProfile.js')
        .then(({ maybeLearnUserProfile }) => maybeLearnUserProfile(name, history, projectPath))
        .catch(() => {});
    }
    return true;
  } catch (error) {
    logSession('save', name, false);
    return false;
  }
}

// Guard against concurrent title generation for the same session during
// the 5s autosave cadence — only one in-flight call per session name.
const titlesInFlight = new Set<string>();

/**
 * Generate and persist an AI title for a session, if it doesn't have
 * one yet. Safe to call repeatedly — early-returns when aiTitle exists
 * or a generation is already in flight.
 */
export async function maybeGenerateSessionTitle(name: string, projectPath?: string): Promise<void> {
  if (titlesInFlight.has(name)) return;
  const sessionsDir = getSessionsDir(projectPath);
  const filePath = join(sessionsDir, `${name}.json`);
  if (!existsSync(filePath)) return;

  let data: Session;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as Session;
  } catch {
    return;
  }
  if (data.aiTitle) return;

  titlesInFlight.add(name);
  try {
    const { generateSessionTitle } = await import('../utils/sessionTitles.js');
    const aiTitle = await generateSessionTitle(data.history);
    if (aiTitle) {
      // Re-read in case the session was re-saved while we were generating,
      // so we don't clobber newer history with our stale copy.
      try {
        const fresh = JSON.parse(readFileSync(filePath, 'utf-8')) as Session;
        fresh.aiTitle = aiTitle;
        writeFileSync(filePath, JSON.stringify(fresh, null, 2));
      } catch { /* ignore */ }
    }
  } finally {
    titlesInFlight.delete(name);
  }
}

export function loadSession(name: string, projectPath?: string): Message[] | null {
  try {
    const sessionsDir = getSessionsDir(projectPath);
    const filePath = join(sessionsDir, `${name}.json`);
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Session;
      logSession('load', name, true);
      return data.history;
    }
    logSession('load', name, false);
    return null;
  } catch (error) {
    logSession('load', name, false);
    return null;
  }
}

export function listSessions(projectPath?: string): string[] {
  try {
    const sessionsDir = getSessionsDir(projectPath);
    return readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}

export function deleteSession(name: string, projectPath?: string): boolean {
  try {
    const sessionsDir = getSessionsDir(projectPath);
    const filePath = join(sessionsDir, `${name}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      logSession('delete', name, true);
      return true;
    }
    logSession('delete', name, false);
    return false;
  } catch (error) {
    logSession('delete', name, false);
    return false;
  }
}

export function renameSession(oldName: string, newName: string, projectPath?: string): boolean {
  try {
    const sessionsDir = getSessionsDir(projectPath);
    const oldPath = join(sessionsDir, `${oldName}.json`);
    const newPath = join(sessionsDir, `${newName}.json`);
    
    if (!existsSync(oldPath)) {
      logSession('rename', `${oldName} -> ${newName}`, false);
      return false;
    }
    
    // Read existing session
    const data = JSON.parse(readFileSync(oldPath, 'utf-8')) as Session;
    
    // Update name and save to new path
    data.name = newName;
    writeFileSync(newPath, JSON.stringify(data, null, 2));
    
    // Delete old file
    unlinkSync(oldPath);
    
    // Update current session ID if it was the renamed one
    if (config.get('currentSessionId') === oldName) {
      config.set('currentSessionId', newName);
    }
    
    logSession('rename', `${oldName} -> ${newName}`, true);
    return true;
  } catch (error) {
    logSession('rename', `${oldName} -> ${newName}`, false);
    return false;
  }
}

export function getSessionInfo(name: string, projectPath?: string): { name: string; createdAt: string; messageCount: number } | null {
  try {
    const sessionsDir = getSessionsDir(projectPath);
    const filePath = join(sessionsDir, `${name}.json`);
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Session;
      return {
        name: data.name,
        createdAt: data.createdAt,
        messageCount: data.history.length,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface SessionInfo {
  name: string;
  title: string;
  createdAt: string;
  messageCount: number;
  fileSize: number;
}

/**
 * List all sessions with metadata, sorted by date (newest first)
 */
export function listSessionsWithInfo(projectPath?: string): SessionInfo[] {
  try {
    const sessionsDir = getSessionsDir(projectPath);
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    
    const sessions: SessionInfo[] = [];
    
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        const stat = statSync(filePath);
        const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Session;
        const sessionName = data.name || file.replace('.json', '');
        // Title priority: AI-generated one-liner > stored title > first
        // user message > session name. aiTitle reads far better in
        // /sessions + /recall ("OAuth2 migration" vs "help me with the…").
        const firstUserMsg = data.history?.find(m => m.role === 'user');
        const title = data.aiTitle
          || data.title
          || (firstUserMsg ? firstUserMsg.content.replace(/\n/g, ' ').trim().slice(0, 60) : null)
          || sessionName;
        sessions.push({
          name: sessionName,
          title,
          createdAt: data.createdAt || stat.mtime.toISOString(),
          messageCount: data.history?.length || 0,
          fileSize: stat.size,
        });
      } catch {
        // Skip invalid session files
      }
    }
    
    // Sort by date, newest first
    return sessions.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  } catch {
    return [];
  }
}

// Project permission management
/**
 * Get project permission from local .codeep/config.json or global config
 */
export function getProjectPermission(projectPath: string): ProjectPermission | null {
  // First try local .codeep/config.json (for recognized projects)
  const configPath = getLocalConfigPath(projectPath);
  if (configPath && existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, 'utf-8')) as LocalProjectConfig;
      if (data.permission && typeof data.permission === 'object') return data.permission;
    } catch {
      // Fall through to global config
    }
  }
  
  // Fallback to global config for non-project folders
  const permissions = config.get('projectPermissions') || [];
  return permissions.find((p: ProjectPermission) => p.path === projectPath) || null;
}

/**
 * Set project permission in local .codeep/config.json or global config
 */
export function setProjectPermission(projectPath: string, read: boolean, write: boolean): void {
  const permission: ProjectPermission = {
    path: projectPath,
    readPermission: read,
    writePermission: write,
    grantedAt: new Date().toISOString(),
  };
  
  // Try to save to local .codeep/config.json (for recognized projects)
  const configPath = getLocalConfigPath(projectPath);
  if (configPath) {
    let data: LocalProjectConfig = {};
    if (existsSync(configPath)) {
      try {
        data = JSON.parse(readFileSync(configPath, 'utf-8')) as LocalProjectConfig;
      } catch {
        // Invalid JSON, start fresh
      }
    }

    data.permission = permission;
    writeFileSync(configPath, JSON.stringify(data, null, 2));
    return;
  }
  
  // Fallback to global config for non-project folders
  const permissions = config.get('projectPermissions') || [];
  const existingIndex = permissions.findIndex((p: ProjectPermission) => p.path === projectPath);
  
  if (existingIndex >= 0) {
    permissions[existingIndex] = permission;
  } else {
    permissions.push(permission);
  }
  
  config.set('projectPermissions', permissions);
}

/**
 * Remove project permission from local .codeep/config.json or global config
 */
export function removeProjectPermission(projectPath: string): boolean {
  // Try to remove from local .codeep/config.json
  const configPath = getLocalConfigPath(projectPath);
  if (configPath && existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, 'utf-8')) as LocalProjectConfig;
      if (data.permission) {
        delete data.permission;
        writeFileSync(configPath, JSON.stringify(data, null, 2));
        return true;
      }
    } catch {
      // Fall through to global config
    }
  }
  
  // Try to remove from global config
  const permissions = config.get('projectPermissions') || [];
  const existingIndex = permissions.findIndex((p: ProjectPermission) => p.path === projectPath);
  
  if (existingIndex >= 0) {
    permissions.splice(existingIndex, 1);
    config.set('projectPermissions', permissions);
    return true;
  }
  
  return false;
}

export function hasReadPermission(projectPath: string): boolean {
  const perm = getProjectPermission(projectPath);
  return perm?.readPermission === true;
}

export function hasWritePermission(projectPath: string): boolean {
  const perm = getProjectPermission(projectPath);
  return perm?.writePermission === true;
}

export function getGithubId(): string {
  return config.get('githubId') || '';
}

export function setGithubAccount(githubId: string, username: string): void {
  config.set('githubId', githubId);
  config.set('githubUsername', username);
}

export function getSyncToken(): string {
  return config.get('syncToken') || '';
}

export function setSyncToken(token: string): void {
  config.set('syncToken', token);
}

export function getDeviceId(): string {
  let id = config.get('deviceId') || '';
  if (!id) {
    id = randomUUID().replace(/-/g, '');
    config.set('deviceId', id);
  }
  return id;
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

function getProfilesDir(): string {
  const dir = join(GLOBAL_BASE_DIR, 'profiles');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export interface Profile {
  name: string;
  createdAt: string;
  provider: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  temperature: number;
  maxTokens: number;
  language: string;
  agentMode: AgentMode;
  agentConfirmation: 'always' | 'dangerous' | 'never';
  agentAutoCommit: boolean;
}

export function saveProfile(name: string): boolean {
  try {
    const profile: Profile = {
      name,
      createdAt: new Date().toISOString(),
      provider: config.get('provider'),
      model: config.get('model'),
      protocol: config.get('protocol'),
      temperature: config.get('temperature'),
      maxTokens: config.get('maxTokens'),
      language: config.get('language'),
      agentMode: config.get('agentMode'),
      agentConfirmation: config.get('agentConfirmation'),
      agentAutoCommit: config.get('agentAutoCommit'),
    };
    writeFileSync(join(getProfilesDir(), `${name}.json`), JSON.stringify(profile, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function loadProfile(name: string): Profile | null {
  try {
    const filePath = join(getProfilesDir(), `${name}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Profile;
  } catch {
    return null;
  }
}

export function applyProfile(profile: Profile): void {
  config.set('provider', profile.provider);
  config.set('model', profile.model);
  config.set('protocol', profile.protocol);
  config.set('temperature', profile.temperature);
  config.set('maxTokens', profile.maxTokens);
  config.set('language', profile.language);
  config.set('agentMode', profile.agentMode);
  config.set('agentConfirmation', profile.agentConfirmation);
  config.set('agentAutoCommit', profile.agentAutoCommit);
}

export function listProfiles(): string[] {
  try {
    return readdirSync(getProfilesDir())
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}

export function deleteProfile(name: string): boolean {
  try {
    const filePath = join(getProfilesDir(), `${name}.json`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
