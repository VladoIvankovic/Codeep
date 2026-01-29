import Conf from 'conf';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PROVIDERS, getProvider } from './providers';
import { logSession } from '../utils/logger';
import { createSecureStorage, type SecureStorage } from '../utils/keychain';

interface Session {
  name: string;
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

interface ProviderApiKey {
  providerId: string;
  apiKey: string;
}

type AgentMode = 'auto' | 'manual';

interface ConfigSchema {
  apiKey: string; // Legacy, kept for backwards compatibility
  provider: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  plan: 'lite' | 'pro' | 'max';
  language: LanguageCode;
  autoSave: boolean;
  currentSessionId: string;
  temperature: number;
  maxTokens: number;
  apiTimeout: number;
  rateLimitApi: number; // API requests per minute
  rateLimitCommands: number; // Commands per minute
  agentMode: AgentMode; // auto = always use agent, manual = use /agent command
  agentConfirmation: 'always' | 'dangerous' | 'never'; // Confirmation mode for agent actions
  agentAutoCommit: boolean; // Auto-commit after agent completes
  agentAutoCommitBranch: boolean; // Create new branch for commits
  agentAutoVerify: boolean; // Auto-run build/test after changes
  agentMaxFixAttempts: number; // Max attempts to fix errors (default: 3)
  agentMaxIterations: number; // Max agent iterations (default: 100)
  agentMaxDuration: number; // Max agent duration in minutes (default: 20)
  agentApiTimeout: number; // Base API timeout for agent in ms (default: 90000, dynamically adjusted)
  projectPermissions: ProjectPermission[];
  providerApiKeys: ProviderApiKey[];
}

export type { AgentMode };

export type { LanguageCode };

// Global sessions directory (fallback when not in a project)
const GLOBAL_SESSIONS_DIR = join(homedir(), '.codeep', 'sessions');

// Ensure global sessions directory exists
if (!existsSync(GLOBAL_SESSIONS_DIR)) {
  mkdirSync(GLOBAL_SESSIONS_DIR, { recursive: true });
}

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
 */
function isProjectDirectory(path: string): boolean {
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

export const config = new Conf<ConfigSchema>({
  projectName: 'codeep',
  defaults: {
    apiKey: '',
    provider: 'z.ai',
    model: 'glm-4.7',
    agentMode: 'auto',
    agentConfirmation: 'dangerous', // Confirm only dangerous actions by default
    agentAutoCommit: false,
    agentAutoCommitBranch: false,
    agentAutoVerify: true, // Auto-verify by default
    agentMaxFixAttempts: 3,
    agentMaxIterations: 100,
    agentMaxDuration: 20, // minutes
    agentApiTimeout: 180000, // 180 seconds base timeout for agent (dynamically adjusted)
    protocol: 'openai',
    plan: 'lite',
    language: 'en',
    autoSave: true,
    currentSessionId: '',
    temperature: 0.7,
    maxTokens: 8192,
    apiTimeout: 60000,
    rateLimitApi: 30, // 30 requests per minute
    rateLimitCommands: 100, // 100 commands per minute
    projectPermissions: [],
    providerApiKeys: [],
  },
});

// In-memory cache for API keys (populated on first access)
const apiKeyCache = new Map<string, string>();

export const LANGUAGES: Record<string, string> = {
  'auto': 'Auto-detect',
  'en': 'English',
  'zh': 'Chinese (中文)',
  'es': 'Spanish (Español)',
  'hi': 'Hindi (हिन्दी)',
  'ar': 'Arabic (العربية)',
  'pt': 'Portuguese (Português)',
  'fr': 'French (Français)',
  'de': 'German (Deutsch)',
  'ja': 'Japanese (日本語)',
  'ru': 'Russian (Русский)',
  'hr': 'Croatian (Hrvatski)',
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
  
  // Check config file
  const providerKeys = config.get('providerApiKeys') || [];
  
  const stored = providerKeys.find(k => k.providerId === provider);
  if (stored?.apiKey) {
    apiKeyCache.set(provider, stored.apiKey);
    return stored.apiKey;
  }
  
  // Fallback to legacy apiKey field (for z.ai)
  if (provider === 'z.ai') {
    const legacyKey = config.get('apiKey') || '';
    if (legacyKey) {
      apiKeyCache.set(provider, legacyKey);
      return legacyKey;
    }
  }
  
  return '';
}

/**
 * Load API keys for ALL providers into cache
 * Should be called at app startup
 */
export async function loadAllApiKeys(): Promise<void> {
  // Load keys for all configured providers from providerApiKeys
  const providerKeys = config.get('providerApiKeys') || [];
  for (const { providerId, apiKey } of providerKeys) {
    if (apiKey) {
      apiKeyCache.set(providerId, apiKey);
    }
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
  
  // Legacy env vars for z.ai
  if (!apiKeyCache.get('z.ai')) {
    if (process.env.ZAI_API_KEY) {
      apiKeyCache.set('z.ai', process.env.ZAI_API_KEY);
    } else if (process.env.ZHIPUAI_API_KEY) {
      apiKeyCache.set('z.ai', process.env.ZHIPUAI_API_KEY);
    } else {
      // Fallback to legacy apiKey field
      const legacyKey = config.get('apiKey') || '';
      if (legacyKey) {
        apiKeyCache.set('z.ai', legacyKey);
      }
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
 * Set API key - stores in config file
 */
export function setApiKey(key: string, providerId?: string): void {
  const provider = providerId || config.get('provider');
  
  // Update cache immediately
  apiKeyCache.set(provider, key);
  
  // Store in config
  const providerKeys = config.get('providerApiKeys') || [];
  const existing = providerKeys.findIndex(k => k.providerId === provider);
  
  if (existing >= 0) {
    providerKeys[existing].apiKey = key;
  } else {
    providerKeys.push({ providerId: provider, apiKey: key });
  }
  
  config.set('providerApiKeys', providerKeys);
  
  // Also set legacy field for backwards compatibility (z.ai only)
  if (provider === 'z.ai') {
    config.set('apiKey', key);
  }
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
  const providerKeys = config.get('providerApiKeys') || [];
  const configured: { id: string; name: string }[] = [];
  
  for (const pk of providerKeys) {
    if (pk.apiKey && pk.apiKey.length > 0) {
      const provider = getProvider(pk.providerId);
      configured.push({
        id: pk.providerId,
        name: provider?.name || pk.providerId,
      });
    }
  }
  
  return configured;
}

/**
 * Clear API key for a specific provider
 */
export function clearApiKey(providerId: string): void {
  // Clear from cache
  apiKeyCache.delete(providerId);
  
  // Clear from config
  const providerKeys = config.get('providerApiKeys') || [];
  const filtered = providerKeys.filter(k => k.providerId !== providerId);
  config.set('providerApiKeys', filtered);
  
  // Clear legacy field if z.ai
  if (providerId === 'z.ai') {
    config.set('apiKey', '');
  }
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
  const providerId = config.get('provider');
  const provider = getProvider(providerId);
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
  loadApiKey(providerId);
  
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

// Re-export PROVIDERS for convenience
export { PROVIDERS } from './providers';

// Generate unique session ID
function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `session-${date}-${time}`;
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
    const session: Session = {
      name,
      history,
      createdAt: new Date().toISOString(),
    };
    const sessionsDir = getSessionsDir(projectPath);
    const filePath = join(sessionsDir, `${name}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2));
    logSession('save', name, true);
    return true;
  } catch (error) {
    logSession('save', name, false);
    return false;
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
        sessions.push({
          name: data.name || file.replace('.json', ''),
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
 * Get project permission from local .codeep/config.json
 */
export function getProjectPermission(projectPath: string): ProjectPermission | null {
  const configPath = getLocalConfigPath(projectPath);
  if (!configPath || !existsSync(configPath)) {
    return null;
  }
  
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    return data.permission || null;
  } catch {
    return null;
  }
}

/**
 * Set project permission in local .codeep/config.json
 */
export function setProjectPermission(projectPath: string, read: boolean, write: boolean): void {
  const configPath = getLocalConfigPath(projectPath);
  if (!configPath) return;
  
  const permission: ProjectPermission = {
    path: projectPath,
    readPermission: read,
    writePermission: write,
    grantedAt: new Date().toISOString(),
  };
  
  let data: any = {};
  if (existsSync(configPath)) {
    try {
      data = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Invalid JSON, start fresh
    }
  }
  
  data.permission = permission;
  writeFileSync(configPath, JSON.stringify(data, null, 2));
}

/**
 * Remove project permission from local .codeep/config.json
 */
export function removeProjectPermission(projectPath: string): boolean {
  const configPath = getLocalConfigPath(projectPath);
  if (!configPath || !existsSync(configPath)) {
    return false;
  }
  
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (data.permission) {
      delete data.permission;
      writeFileSync(configPath, JSON.stringify(data, null, 2));
      return true;
    }
  } catch {
    // Ignore errors
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
