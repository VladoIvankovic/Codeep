/**
 * Command dispatch for all /command handlers.
 *
 * Extracted from main.ts. Receives an AppCommandContext so it remains
 * decoupled from global state. Import-heavy commands use dynamic imports
 * to keep startup time low.
 */

import { Message } from './App';
import {
  config,
  getCurrentProvider,
  getModelsForCurrentProvider,
  PROTOCOLS,
  LANGUAGES,
  setProvider,
  setApiKey,
  clearApiKey,
  getApiKey,
  isTelemetryEnabled,
  telemetryForcedOffByEnv,
  isKeySyncEnabled,
  keySyncForcedOffByEnv,
  saveSession,
  startNewSession,
  loadSession,
  listSessionsWithInfo,
  deleteSession,
  renameSession,
  setProjectPermission,
  saveProfile,
  loadProfile,
  applyProfile,
  listProfiles,
  deleteProfile,
  initializeAsProject,
  isManuallyInitializedProject,
} from '../config/index';
import { getProjectContext } from '../utils/project';
import { getCurrentVersion } from '../utils/update';
import { getProviderList, getProvider, modelSupportsReasoningEffort, reasoningParamsFor, availableReasoningTiers, resolveReasoningTier, REASONING_TIERS, type ReasoningTier } from '../config/providers';
import { setProjectContext } from '../api/index';
import { AppExecutionContext, runSkill, runCommandChain } from './agentExecution';
import { loadProjectIntelligence, saveProjectIntelligence } from '../utils/projectIntelligence';
import { ollamaModelHint } from './ollamaHint';
import { buildSearchSnippets, parseKeepRecent, joinSessionName, parseTaskAddArgs, formatTaskList, formatProfileList, formatMemoryList, formatStatsReport, extractCodeBlocks, resolveBlockIndex, extractFileChanges, formatApplyDiffLine, parsePromptArgs, formatMcpReloadReport, formatMcpResourcesList, formatMcpResourceRead, formatMcpPromptsList, formatMcpPromptResult, formatMcpServerList, parseInsightsDays, formatCloudSessionLabel, formatMeSyncReport, formatMeLearnResult, formatMeInitResult, formatSkillsShow, formatSkillsBrowseEmpty, formatSkillsPublishResult } from './commands/helpers';
import { resolveCommand } from './commands/registry';

// ─── Extended context for command handlers ────────────────────────────────────

export interface AppCommandContext extends AppExecutionContext {
  sessionId: string;
  setSessionId: (id: string) => void;
  setProjectContext: (ctx: ReturnType<typeof getProjectContext>) => void;
  setHasWriteAccess: (v: boolean) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a hint for an Ollama model name based on parameter count.
 * Models ≥7B are suitable for agent mode; smaller ones are chat-only.
 */
// ─── Main dispatch ────────────────────────────────────────────────────────────

export async function handleCommand(
  command: string,
  args: string[],
  ctx: AppCommandContext,
): Promise<void> {
  // Resolve command aliases (e.g. `webcache` → `web-cache`) to their
  // canonical name before dispatching.
  const resolved = resolveCommand(command);
  const canonical = resolved?.name ?? command;
  // Handle skill chaining (e.g., /commit+push)
  if (canonical.includes('+')) {
    const commands = canonical.split('+').filter(c => c.trim());
    runCommandChain(commands, 0, ctx);
    return;
  }

  switch (canonical) {
    case 'version': {
      const version = getCurrentVersion();
      const provider = getCurrentProvider();
      const providers = getProviderList();
      const providerInfo = providers.find(p => p.id === provider.id);
      ctx.app.notify(`Codeep v${version} • ${providerInfo?.name} • ${config.get('model')}`);
      break;
    }

    case 'provider': {
      const providers = getProviderList();
      const providerItems = providers.map(p => ({
        key: p.id,
        label: p.name,
        description: p.description || '',
      }));
      const currentProvider = getCurrentProvider();
      ctx.app.showSelect('Select Provider', providerItems, currentProvider.id, (item) => {
        if (setProvider(item.key)) {
          ctx.app.notify(`Provider: ${item.label}`);
        }
      });
      break;
    }

    case 'model': {
      // /model <profile-name> — load a saved profile as a shortcut
      if (args[0] && args[0] !== 'pull') {
        const profileMatch = loadProfile(args[0]);
        if (profileMatch) {
          applyProfile(profileMatch);
          ctx.app.notify(`${profileMatch.name}: ${profileMatch.provider} / ${profileMatch.model}`);
          break;
        }
      }

      // /model pull <name> — pull an Ollama model (local only)
      if (args[0] === 'pull') {
        const modelName = args[1];
        if (!modelName) { ctx.app.notify('Usage: /model pull <model-name>'); break; }
        const ollamaUrl = (config.get('ollamaUrl') || 'http://localhost:11434').toLowerCase();
        const isLocal = ollamaUrl.includes('localhost') || ollamaUrl.includes('127.0.0.1') || ollamaUrl.includes('[::1]');
        if (!isLocal) {
          ctx.app.notify(`Ollama is on a remote server (${config.get('ollamaUrl')}).\nSSH into that machine and run: ollama pull ${modelName}`);
          break;
        }
        ctx.app.notify(`Pulling ${modelName}... (this may take a while)`);
        const { execFile } = await import('child_process');
        execFile('ollama', ['pull', modelName], { timeout: 600_000 }, (err) => {
          if (err) ctx.app.notify(`Pull failed: ${err.message}`);
          else ctx.app.notify(`✓ ${modelName} ready — use /model to select it`);
        });
        break;
      }

      // /model browse — curated catalog of recommended local coding models.
      if (args[0] === 'browse') {
        const ollamaUrl = (config.get('ollamaUrl') || 'http://localhost:11434').toLowerCase();
        const isLocal = ollamaUrl.includes('localhost') || ollamaUrl.includes('127.0.0.1') || ollamaUrl.includes('[::1]');
        const { OLLAMA_CODING_MODELS, catalogAgentHint } = await import('../utils/ollamaCatalog');
        const items = OLLAMA_CODING_MODELS.map(m => ({
          key: m.pull,
          label: m.name,
          description: `${m.pull} · ${m.vram} · ${catalogAgentHint(m.params)} — ${m.description}`,
        }));
        ctx.app.showSelect('Recommended coding models (pull)', items, '', (item) => {
          if (!isLocal) {
            ctx.app.notify(`Ollama is on a remote server. SSH in and run: ollama pull ${item.key}`);
            return;
          }
          ctx.app.notify(`Pulling ${item.key}... (this may take a while)`);
          import('child_process').then(({ execFile }) => {
            execFile('ollama', ['pull', item.key], { timeout: 1_200_000 }, (err) => {
              if (err) ctx.app.notify(`Pull failed: ${err.message}`);
              else ctx.app.notify(`✓ ${item.key} ready — use /model to select it`);
            });
          });
        });
        break;
      }

      // /model rm <name> — delete a locally-installed Ollama model.
      if (args[0] === 'rm' || args[0] === 'remove' || args[0] === 'delete') {
        const modelName = args[1];
        if (!modelName) { ctx.app.notify('Usage: /model rm <model-name>'); break; }
        const ollamaUrl = (config.get('ollamaUrl') || 'http://localhost:11434').toLowerCase();
        const isLocal = ollamaUrl.includes('localhost') || ollamaUrl.includes('127.0.0.1') || ollamaUrl.includes('[::1]');
        if (!isLocal) {
          ctx.app.notify(`Ollama is on a remote server. SSH in and run: ollama rm ${modelName}`);
          break;
        }
        ctx.app.notify(`Removing ${modelName}…`);
        const { execFile } = await import('child_process');
        execFile('ollama', ['rm', modelName], { timeout: 60_000 }, (err) => {
          if (err) ctx.app.notify(`Remove failed: ${err.message}`);
          else ctx.app.notify(`✓ Removed ${modelName}`);
        });
        break;
      }

      const providerId = config.get('provider');
      const { isDynamicModelsProvider, isNoApiKeyProvider: _noKey } = await import('../config/providers');
      if (isDynamicModelsProvider(providerId)) {
        if (providerId === 'openrouter') {
          ctx.app.notify('Fetching OpenRouter catalog…');
          const { fetchOpenRouterModels } = await import('../config/index');
          const apiKey = (await import('../config/index')).getApiKey('openrouter');
          const models = await fetchOpenRouterModels(apiKey || undefined);
          if (!models || models.length === 0) {
            ctx.app.notify('Could not fetch OpenRouter models (network? key?). Using built-in shortlist.');
            const fallback = getModelsForCurrentProvider();
            const currentModel = config.get('model');
            const modelItems = Object.keys(fallback).map(id => ({ key: id, label: fallback[id], description: '' }));
            ctx.app.showSelect('Select OpenRouter Model', modelItems, currentModel, (item) => {
              config.set('model', item.key);
              ctx.app.notify(`Model: ${item.key}`);
            });
            break;
          }
          const modelItems = models.map(m => ({ key: m.id, label: m.id, description: m.description }));
          const currentModel = config.get('model');
          ctx.app.showSelect(`Select OpenRouter Model (${models.length})`, modelItems, currentModel, (item) => {
            config.set('model', item.key);
            ctx.app.notify(`Model: ${item.key}`);
          });
          break;
        }
        if (providerId === 'custom') {
          const base = config.get('customBaseUrl') || 'http://localhost:8000/v1';
          ctx.app.notify(`Fetching models from ${base}…`);
          const { fetchOpenAiCompatibleModels, getApiKey: _getKey } = await import('../config/index');
          const models = await fetchOpenAiCompatibleModels(base, _getKey('custom') || undefined);
          if (!models || models.length === 0) {
            ctx.app.notify(`Could not list models from ${base}. Set the base URL in /settings, or set the model directly (config key "model").`);
            break;
          }
          const modelItems = models.map(m => ({ key: m.id, label: m.name, description: '' }));
          const currentModel = config.get('model');
          ctx.app.showSelect(`Select Model (${models.length})`, modelItems, currentModel, (item) => {
            config.set('model', item.key);
            ctx.app.notify(`Model: ${item.key}`);
          });
          break;
        }
        const { fetchOllamaModels } = await import('../config/index');
        ctx.app.notify('Fetching models from Ollama...');
        const ollamaModels = await fetchOllamaModels();
        if (!ollamaModels || ollamaModels.length === 0) {
          const ollamaUrl = config.get('ollamaUrl') || 'http://localhost:11434';
          ctx.app.notify(`Could not reach Ollama at ${ollamaUrl}. Is it running?`);
          break;
        }
        const modelItems = ollamaModels.map(m => ({
          key: m.id,
          label: m.name,
          description: ollamaModelHint(m.id),
        }));
        const currentModel = config.get('model');
        ctx.app.showSelect('Select Ollama Model', modelItems, currentModel, (item) => {
          config.set('model', item.key);
          ctx.app.notify(`Model: ${item.label}`);
        });
      } else {
        const models = getModelsForCurrentProvider();
        const modelItems = Object.entries(models).map(([name, info]) => ({
          key: name,
          label: name,
          description: typeof info === 'object' && info !== null ? (info as { description?: string }).description || '' : '',
        }));
        const currentModel = config.get('model');
        ctx.app.showSelect('Select Model', modelItems, currentModel, (item) => {
          config.set('model', item.key);
          ctx.app.notify(`Model: ${item.label}`);
        });
      }
      break;
    }

    case 'status': {
      const { getGithubId } = await import('../config/index.js');
      const provider = getCurrentProvider();
      const providers = getProviderList();
      const providerInfo = providers.find(p => p.id === provider.id);
      const model = config.get('model') as string;
      const githubId = getGithubId();
      const lines: string[] = ['## Status', ''];
      lines.push(`**Provider**   ${providerInfo?.name ?? provider.id}  ·  ${model}`);
      if (ctx.projectContext) {
        lines.push(`**Project**    ${ctx.projectContext.name}  (${ctx.projectContext.type})`);
        lines.push(`**Access**     ${ctx.hasWriteAccess ? 'Read & Write' : 'Read only'}`);
      } else {
        lines.push(`**Project**    none  ·  chat only`);
      }
      if (ctx.addedFiles.size > 0) {
        lines.push(`**Context**    ${ctx.addedFiles.size} file${ctx.addedFiles.size !== 1 ? 's' : ''} added`);
      }
      lines.push(`**Account**    ${githubId ? `linked (${githubId})` : 'not linked — run: codeep account'}`);
      lines.push(`**Session**    ${ctx.sessionId}`);
      ctx.app.addMessage({ role: 'system', content: lines.join('\n') } as Message);
      break;
    }

    case 'telemetry': {
      const sub = args[0]?.toLowerCase();
      const envOff = telemetryForcedOffByEnv();
      if (sub === 'on' || sub === 'off') {
        if (envOff) {
          ctx.app.notify('Telemetry is forced OFF by CODEEP_NO_TELEMETRY / DO_NOT_TRACK — unset that env var to change it.');
          break;
        }
        config.set('telemetry', sub === 'on');
        ctx.app.notify(sub === 'on'
          ? 'Telemetry on — usage stats, transcripts, progress & notes sync to codeep.dev.'
          : 'Telemetry off — no automatic cloud uploads.');
        break;
      }
      if (sub && sub !== 'status') {
        ctx.app.notify('Usage: /telemetry · /telemetry on · /telemetry off');
        break;
      }
      const flag = config.get('telemetry') !== false;
      const tLines: string[] = ['## Telemetry', ''];
      tLines.push(`**State**      ${isTelemetryEnabled() ? 'on' : 'off'}`);
      tLines.push(`**Flag**       telemetry = ${flag}`);
      if (envOff) tLines.push('**Env**        forced off by CODEEP_NO_TELEMETRY / DO_NOT_TRACK (overrides the flag)');
      tLines.push('');
      tLines.push('Toggle with `/telemetry on` or `/telemetry off`. Controls automatic uploads of usage stats, session transcripts, progress, and memory notes.');
      ctx.app.addMessage({ role: 'system', content: tLines.join('\n') } as Message);
      break;
    }

    case 'keysync': {
      const sub = args[0]?.toLowerCase();
      const envOff = keySyncForcedOffByEnv();
      if (sub === 'on' || sub === 'off') {
        if (envOff) {
          ctx.app.notify('Cloud key sync is forced OFF by CODEEP_NO_KEY_SYNC — unset that env var to change it.');
          break;
        }
        config.set('syncKeysToCloud', sub === 'on');
        ctx.app.notify(sub === 'on'
          ? 'Cloud key sync on — `codeep account push/sync` will now upload/download API keys. Note: synced keys are stored server-readable on codeep.dev.'
          : 'Cloud key sync off — API keys stay in your OS keychain only. (Run `codeep account purge-keys` to also wipe any keys already on the server.)');
        break;
      }
      if (sub && sub !== 'status') {
        ctx.app.notify('Usage: /keysync · /keysync on · /keysync off');
        break;
      }
      const flag = config.get('syncKeysToCloud') === true;
      const kLines: string[] = ['## Cloud key sync', ''];
      kLines.push(`**State**      ${isKeySyncEnabled() ? 'on' : 'off'}`);
      kLines.push(`**Flag**       syncKeysToCloud = ${flag}`);
      if (envOff) kLines.push('**Env**        forced off by CODEEP_NO_KEY_SYNC (overrides the flag)');
      kLines.push('');
      kLines.push('OFF by default. API keys live only in your OS keychain unless you turn this on. When on, `codeep account push`/`sync` upload/download keys, which are stored **server-readable** on codeep.dev. Toggle with `/keysync on` or `/keysync off`; wipe server copies with `codeep account purge-keys`.');
      ctx.app.addMessage({ role: 'system', content: kLines.join('\n') } as Message);
      break;
    }

    case 'effort':
    case 'thinking': {
      const providerId = config.get('provider');
      const model = config.get('model');
      const supported = modelSupportsReasoningEffort(providerId, model);
      // Tiers THIS model actually distinguishes (e.g. GLM-5.2 → auto/high/max).
      const available = availableReasoningTiers(providerId, model);
      const sub = args[0]?.toLowerCase();

      if (sub && REASONING_TIERS.includes(sub as ReasoningTier)) {
        config.set('reasoningEffort', sub as ReasoningTier);
        if (sub === 'auto') {
          ctx.app.notify('Thinking effort: auto — each model uses its own default.');
        } else if (!supported) {
          ctx.app.notify(`Thinking effort set to "${sub}", but ${model} has no graded thinking control — it will be ignored until you switch to a model that does (e.g. Opus 5, GPT-5.x, Gemini 3, DeepSeek V4, GLM-5.2).`);
        } else {
          // Tell the user what THIS model will actually run (the tier may
          // collapse onto a level the model distinguishes, e.g. low→high on GLM).
          const resolved = resolveReasoningTier(providerId, model, sub as ReasoningTier);
          const note = resolved === sub ? '' : ` (${model} runs this as "${resolved}")`;
          ctx.app.notify(`Thinking effort: ${sub}${note} — sending ${JSON.stringify(reasoningParamsFor(providerId, model, sub as ReasoningTier))}.`);
        }
        break;
      }
      if (sub && sub !== 'status') {
        const offer = available.length > 0 ? available : REASONING_TIERS;
        ctx.app.notify(`Usage: /thinking ${offer.join(' · /thinking ')}`);
        break;
      }

      const tier = (config.get('reasoningEffort') ?? 'auto') as ReasoningTier;
      const resolved = resolveReasoningTier(providerId, model, tier);
      const tLines: string[] = ['## Thinking effort', ''];
      tLines.push(`**Tier**       ${tier}${resolved !== tier && tier !== 'auto' ? ` → ${resolved} on this model` : ''}`);
      tLines.push(`**Model**      ${model} (${providerId})`);
      if (!supported) {
        tLines.push('**Effective**  not sent — this model has no graded thinking control');
      } else if (tier === 'auto') {
        tLines.push('**Effective**  model default (no param sent)');
      } else {
        tLines.push(`**Effective**  ${JSON.stringify(reasoningParamsFor(providerId, model, tier))}`);
      }
      if (supported) tLines.push(`**Available**  ${available.join(' · ')}`);
      tLines.push('');
      tLines.push('Sets how hard the model reasons. Each model offers only the levels it distinguishes (GLM-5.2 / DeepSeek → high · max; Gemini → low · high; Opus/Sonnet & GPT-5.x → the full set). The setting is global and clamps to the active model, so it never sends a value the API rejects. `/effort` is an alias.');
      ctx.app.addMessage({ role: 'system', content: tLines.join('\n') } as Message);
      break;
    }

    case 'grant': {
      setProjectPermission(ctx.projectPath, true, true);
      ctx.setHasWriteAccess(true);
      const newCtx = getProjectContext(ctx.projectPath);
      if (newCtx) {
        newCtx.hasWriteAccess = true;
        setProjectContext(newCtx);
      }
      ctx.setProjectContext(newCtx);
      ctx.app.notify('Write access granted');
      break;
    }

    case 'agent': {
      if (!args.length) { ctx.app.notify('Usage: /agent <task>'); return; }
      if (ctx.isAgentRunning()) { ctx.app.notify('Agent already running. Use /stop to cancel.'); return; }
      const { runAgentTask } = await import('./agentExecution');
      runAgentTask(args.join(' '), false, ctx, () => null, () => {});
      break;
    }

    case 'agent-dry': {
      if (!args.length) { ctx.app.notify('Usage: /agent-dry <task>'); return; }
      if (ctx.isAgentRunning()) { ctx.app.notify('Agent already running. Use /stop to cancel.'); return; }
      const { runAgentTask } = await import('./agentExecution');
      runAgentTask(args.join(' '), true, ctx, () => null, () => {});
      break;
    }

    case 'd':
    case 'docs': {
      // Open per-command web docs in the system browser. Lets the inline
      // /help stay terse (single-line entries) while users who want the
      // long story get one keystroke away from a real page. `/d` is the
      // short alias.
      const cmd = (args[0] ?? '').toLowerCase().replace(/^\//, '');
      const KNOWN: Record<string, string> = {
        personality: 'https://codeep.dev/docs/agent#personalities',
        personalities: 'https://codeep.dev/docs/agent#personalities',
        insights: 'https://codeep.dev/docs/agent#insights',
        plan: 'https://codeep.dev/docs/agent#plan-mode',
        go: 'https://codeep.dev/docs/agent#plan-mode',
        mcp: 'https://codeep.dev/docs/mcp',
        skills: 'https://codeep.dev/docs/skills',
        checkpoint: 'https://codeep.dev/docs/commands#checkpoints',
        rewind: 'https://codeep.dev/docs/commands#checkpoints',
        hooks: 'https://codeep.dev/docs/commands#hooks',
        commands: 'https://codeep.dev/docs/commands#custom-commands',
        openrouter: 'https://codeep.dev/docs/providers#openrouter',
        memory: 'https://codeep.dev/docs/commands#intelligence',
        me: 'https://codeep.dev/docs/agent#user-profile',
        agents: 'https://codeep.dev/docs/agent#sub-agents',
        delegate: 'https://codeep.dev/docs/agent#sub-agents',
        profile: 'https://codeep.dev/docs/commands#settings',
        compact: 'https://codeep.dev/docs/commands#session',
        cost: 'https://codeep.dev/docs/dashboard',
      };
      const url = cmd ? (KNOWN[cmd] ?? `https://codeep.dev/docs/commands?q=${encodeURIComponent(cmd)}`) : 'https://codeep.dev/docs';
      try {
        const { default: open } = await import('open');
        await open(url);
        ctx.app.notify(`Opening ${url}`);
      } catch {
        ctx.app.notify(`Couldn't open browser. Visit: ${url}`);
      }
      break;
    }

    case 'insights': {
      const { formatInsights } = await import('../utils/insights');
      const days = parseInsightsDays(args);
      ctx.app.addMessage({ role: 'system', content: formatInsights({ days }) });
      break;
    }

    case 'personality': {
      const { formatPersonalityList, findPersonality } = await import('../utils/personalities');
      const sub = args[0]?.toLowerCase();

      if (!sub) {
        ctx.app.addMessage({ role: 'system', content: formatPersonalityList(ctx.projectPath) });
        break;
      }
      if (sub === 'off' || sub === 'none' || sub === 'clear') {
        config.set('activePersonality', null);
        ctx.app.notify('Personality cleared — agent uses default tone.');
        break;
      }
      const personality = findPersonality(sub, ctx.projectPath);
      if (!personality) {
        ctx.app.notify(`No personality named "${sub}". Run /personality to see available.`);
        break;
      }
      config.set('activePersonality', personality.name);
      ctx.app.addMessage({
        role: 'system',
        content: `Active personality: **${personality.displayName}** (\`${personality.name}\`, ${personality.scope})\n\n_${personality.description}_\n\nClear with \`/personality off\`.`,
      });
      break;
    }

    case 'agents': {
      // List sub-agents the agent can `delegate` to (built-in + .codeep/agents/).
      const { formatAgentList } = await import('../utils/agents');
      ctx.app.addMessage({ role: 'system', content: formatAgentList(ctx.projectPath) });
      break;
    }

    case 'me': {
      // User profile (global ~/.codeep/profile.md + project .codeep/profile.md)
      // injected into the agent's context. NOT the provider-profile feature
      // (that's `/profile`). See src/utils/userProfile.ts.
      const { formatProfileView, scaffoldProfile, updateLearnedProfile, clearLearnedProfile } = await import('../utils/userProfile');
      const sub = args[0]?.toLowerCase();

      if (sub === 'on' || sub === 'off') {
        config.set('userProfile', sub === 'on');
        ctx.app.notify(sub === 'on'
          ? "Profile injection on — your profile is added to the agent's context."
          : 'Profile injection off — profile is saved but not used.');
        break;
      }
      if (sub === 'learn') {
        const arg = args[1]?.toLowerCase();
        if (arg === 'on' || arg === 'off') {
          config.set('autoLearnProfile', arg === 'on');
          ctx.app.notify(arg === 'on'
            ? 'Auto-learn on — Codeep quietly updates your learned profile (global + project) from sessions.'
            : 'Auto-learn off — Codeep stops updating the learned profile.');
          break;
        }
        // Manual one-off. `/me learn project` targets this repo; otherwise global.
        const scope = arg === 'project' ? 'project' : 'global';
        if (scope === 'project' && !ctx.projectPath) {
          ctx.app.notify('No project detected here — open a project, or run /me learn for your global profile.');
          break;
        }
        const { loadSession } = await import('../config/index');
        const history = loadSession(ctx.sessionId, ctx.projectPath) || [];
        if (history.filter((m: Message) => m.role !== 'system').length < 2) {
          ctx.app.notify('Not enough conversation yet to learn from — chat a bit, then run /me learn.');
          break;
        }
        ctx.app.notify(`Learning ${scope} preferences from this session…`);
        const res = await updateLearnedProfile(history, scope, ctx.projectPath);
        if (!res) {
          ctx.app.notify('Nothing durable to learn right now (or the model call failed).');
          break;
        }
        const file = scope === 'global' ? '~/.codeep/profile.learned.md' : '.codeep/profile.learned.md';
        ctx.app.addMessage({ role: 'system', content: formatMeLearnResult(scope, file, res) });
        break;
      }
      if (sub === 'forget') {
        ctx.app.notify(clearLearnedProfile(ctx.projectPath)
          ? 'Cleared the auto-learned profile(s).'
          : 'No learned profile to clear.');
        break;
      }
      if (sub === 'sync') {
        const { getSyncToken } = await import('../config/index');
        if (!getSyncToken()) { ctx.app.notify('Not linked to codeep.dev. Run: codeep account'); break; }
        const { pushUserProfile, pullUserProfile } = await import('../utils/codeepCloud');
        ctx.app.notify('Syncing your profile with codeep.dev…');
        const pushed = await pushUserProfile();
        const pulled = await pullUserProfile();
        ctx.app.addMessage({ role: 'system', content: formatMeSyncReport(pushed, pulled) });
        break;
      }
      if (sub === 'init') {
        const scope = args[1]?.toLowerCase() === 'project' ? 'project' : 'global';
        if (scope === 'project' && !ctx.projectPath) {
          ctx.app.notify('No project detected here. Use /me init for a global profile, or open a project first.');
          break;
        }
        const res = scaffoldProfile(scope, ctx.projectPath);
        if (!res) { ctx.app.notify('Could not create the profile file.'); break; }
        ctx.app.addMessage({ role: 'system', content: formatMeInitResult(scope, res) });
        break;
      }
      // Default: show the profile view.
      ctx.app.addMessage({ role: 'system', content: formatProfileView(ctx.projectPath) });
      break;
    }

    case 'plan': {
      // Plan mode: ask the model for a plan, surface it, hold as pending.
      // The user runs /go to execute or /plan <revised> to revise. See
      // src/utils/planMode.ts for the rationale + system prompt.
      if (!args.length) {
        const { getPendingPlan } = await import('../utils/planMode');
        const cur = getPendingPlan();
        if (cur) {
          ctx.app.addMessage({
            role: 'system',
            content: `**Pending plan for:** _${cur.task}_\n\n${cur.plan}\n\n---\nRun \`/go\` to execute, or \`/plan <revised task>\` to revise.`,
          });
        } else {
          ctx.app.notify('Usage: /plan <task> — generates a plan you can review, then /go to execute.');
        }
        return;
      }
      if (ctx.isAgentRunning()) { ctx.app.notify('Agent already running. Use /stop first.'); return; }
      const task = args.join(' ');
      ctx.app.addMessage({ role: 'user', content: `/plan ${task}` });
      ctx.app.notify('Generating plan…');
      try {
        const { generatePlan } = await import('../utils/planMode');
        const plan = await generatePlan(task);
        ctx.app.addMessage({
          role: 'assistant',
          content: `${plan}\n\n---\nRun \`/go\` to execute this plan, or \`/plan <revised task>\` to refine it.`,
        });
      } catch (err) {
        ctx.app.notify(`Plan generation failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'go': {
      // Execute the pending plan from /plan. The agent loop sees the
      // task + plan as a single prompt, so MCP tools, hooks, permissions,
      // and verification all apply unchanged.
      const { getPendingPlan, composeExecutionPrompt, clearPendingPlan } = await import('../utils/planMode');
      const cur = getPendingPlan();
      if (!cur) {
        ctx.app.notify('No pending plan. Run `/plan <task>` first.');
        return;
      }
      if (ctx.isAgentRunning()) { ctx.app.notify('Agent already running. Use /stop first.'); return; }
      const prompt = composeExecutionPrompt(cur);
      clearPendingPlan();
      ctx.app.notify(`Executing plan for: ${cur.task.slice(0, 80)}${cur.task.length > 80 ? '…' : ''}`);
      const { runAgentTask } = await import('./agentExecution');
      runAgentTask(prompt, false, ctx, () => null, () => {});
      break;
    }

    case 'stop': {
      if (ctx.isAgentRunning() && ctx.abortController) {
        ctx.abortController.abort();
        ctx.app.notify('Stopping agent...');
      } else {
        ctx.app.notify('No agent running');
      }
      break;
    }

    case 'sessions': {
      const sessions = listSessionsWithInfo(ctx.projectPath);
      if (sessions.length === 0) { ctx.app.notify('No saved sessions'); return; }
      // Show the readable title (AI-generated > stored > first-message >
      // name) with a short date for disambiguation, instead of the raw
      // session id. Loading still keys off the index → session mapping.
      const labels = sessions.map(s => {
        const date = new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const title = s.title && s.title !== s.name ? s.title : s.name;
        return `${title}  ·  ${date} · ${s.messageCount} msg`;
      });
      ctx.app.showList('Load Session', labels, (index) => {
        const selected = sessions[index];
        const loaded = loadSession(selected.name, ctx.projectPath);
        if (loaded) {
          ctx.app.setMessages(loaded as Message[]);
          ctx.setSessionId(selected.name);
          ctx.app.notify(`Loaded: ${selected.title || selected.name}`);
        } else {
          ctx.app.notify('Failed to load session');
        }
      });
      break;
    }

    case 'cloud': {
      // Cross-device resume: list sessions synced from other devices/Mac app
      // and pull the selected one into the local store, then load it.
      //
      // Not linked → friendly prompt to run `codeep account`.
      // Network/empty → notify (no crash).
      //
      // We scope to the current project when one is open, so a user on their
      // laptop sees the sessions they ran on the desktop for the same repo.
      // BUT: project identity is a hash of the LOCAL absolute path, so the
      // same repo cloned at a different path (the normal cross-device case)
      // has a different projectId. When the scoped list comes back empty we
      // fall back to listing everything, and a non-empty scoped list still
      // offers a "show all" escape hatch — otherwise cross-device resume
      // only works when both machines use identical directory layouts.
      const { listCloudSessions, pullCloudSession, generateProjectId } = await import('../utils/codeepCloud');
      const projectId = ctx.projectPath ? generateProjectId(ctx.projectPath) : undefined;
      ctx.app.notify('Fetching cloud sessions…');
      let summaries = await listCloudSessions(projectId);
      if (summaries === null) {
        ctx.app.notify('Not linked — run `codeep account` to enable cloud sync.');
        break;
      }
      let scopedToProject = Boolean(projectId);
      if (summaries.length === 0 && projectId) {
        // Nothing under this project's path-hash — try the unscoped list so
        // sessions synced from a machine with a different path still show up.
        const all = await listCloudSessions();
        if (all && all.length > 0) {
          summaries = all;
          scopedToProject = false;
          ctx.app.notify('No sessions matched this project — showing all cloud sessions.');
        }
      }
      if (summaries.length === 0) {
        ctx.app.notify(projectId
          ? 'No cloud sessions for this project yet.'
          : 'No cloud sessions yet.');
        break;
      }
      // Non-null binding for the picker closure — TS can't carry the null
      // narrowing of a reassigned `let` into the callback.
      let sessionList = summaries;
      const SHOW_ALL = 'Show all cloud sessions…';
      const labels = summaries.map(formatCloudSessionLabel);
      if (scopedToProject) labels.push(SHOW_ALL);
      // Named so the "Show all" branch can re-present the picker with the
      // same handler (a const arrow can reference itself; the binding is
      // initialized long before the callback can fire).
      const onPickCloudSession = async (index: number): Promise<void> => {
        if (scopedToProject && index === sessionList.length) {
          // "Show all" — re-list unscoped. Re-dispatching /cloud would
          // re-scope to the project, so fetch + present inline instead.
          const all = await listCloudSessions();
          if (!all || all.length === 0) {
            ctx.app.notify('No other cloud sessions.');
            return;
          }
          sessionList = all;
          scopedToProject = false;
          const allLabels = all.map(s => {
            const date = new Date(s.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const title = s.sessionName || s.sessionId.slice(0, 8);
            const projectTag = s.projectName ? ` · ${s.projectName}` : '';
            return `${title}  ·  ${date} · ${s.messageCount} msg${projectTag}`;
          });
          ctx.app.showList('Cloud Sessions (all)', allLabels, onPickCloudSession);
          return;
        }
        const selected = sessionList[index];
        // The cloud id becomes a local FILENAME (saveSession joins it into
        // .codeep/sessions/<name>.json) — whitelist it so a hostile or
        // corrupted server response can't traverse outside the sessions dir.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selected.sessionId)) {
          ctx.app.notify('Cloud session has an unexpected id format — refusing to save it locally.');
          return;
        }
        ctx.app.notify(`Pulling ${selected.sessionName || selected.sessionId.slice(0, 8)}…`);
        const full = await pullCloudSession(selected.sessionId);
        if (!full) {
          ctx.app.notify('Failed to pull session (network or not found).');
          return;
        }
        // Cloud messages are {role, content}; local Message is the same shape
        // plus 'system'. Filter to user/assistant (the server already does,
        // but be defensive) and coerce.
        const history = full.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
        if (history.length === 0) {
          ctx.app.notify('Cloud session has no loadable messages.');
          return;
        }
        // Persist locally so the resumed session is first-class: it appears
        // in /sessions, autosaves on next change, and re-syncs on next turn.
        // We reuse the cloud sessionId as the local name so a subsequent
        // push updates the same cloud record (ON DUPLICATE KEY UPDATE).
        const localName = selected.sessionId;
        // If a local copy of this session exists and is NEWER than the cloud
        // record (continued locally since the last sync), load it instead of
        // clobbering the newer history with the older cloud copy.
        try {
          const { statSync, existsSync } = await import('fs');
          const { join } = await import('path');
          const { getSessionsDir } = await import('../config/index');
          const localPath = join(getSessionsDir(ctx.projectPath), `${localName}.json`);
          const cloudUpdatedAt = Date.parse(selected.updatedAt);
          if (existsSync(localPath) && Number.isFinite(cloudUpdatedAt)
              && statSync(localPath).mtimeMs > cloudUpdatedAt) {
            const local = loadSession(localName, ctx.projectPath);
            if (local && local.length > 0) {
              ctx.app.setMessages(local);
              ctx.setSessionId(localName);
              config.set('currentSessionId', localName);
              ctx.setSessionDisplayName?.(selected.sessionName ?? null);
              ctx.app.notify('Local copy is newer than the cloud record — loaded the local session instead.');
              return;
            }
          }
        } catch { /* mtime probe is best-effort — fall through to cloud copy */ }
        saveSession(localName, history, ctx.projectPath);
        ctx.app.setMessages(history);
        // Keep ALL session-identity state in step, not just the renderer's
        // copy: autosave + agent-mode sync read config.currentSessionId, and
        // the next syncSession reads the display name — leaving either stale
        // writes/renames the pulled history under the PREVIOUS session.
        ctx.setSessionId(localName);
        config.set('currentSessionId', localName);
        ctx.setSessionDisplayName?.(selected.sessionName ?? null);
        ctx.app.notify(`Resumed from cloud: ${selected.sessionName || localName}`);
      };
      ctx.app.showList('Cloud Sessions', labels, onPickCloudSession);
      break;
    }

    case 'new': {
      ctx.app.clearMessages();
      ctx.setSessionId(startNewSession());
      // Clear the derived display name so the next chat re-derives it — else
      // the new session syncs/reports under the PREVIOUS session's name.
      ctx.setSessionDisplayName?.(null);
      ctx.app.notify('New session started');
      break;
    }

    case 'settings': {
      ctx.app.showSettings();
      break;
    }

    case 'diff': {
      if (!ctx.projectContext) { ctx.app.notify('No project context'); return; }
      const staged = args.includes('--staged') || args.includes('-s');
      ctx.app.notify(staged ? 'Getting staged diff...' : 'Getting diff...');
      import('../utils/git').then(({ getGitDiff, formatDiffForDisplay }) => {
        const result = getGitDiff(staged, ctx.projectPath);
        if (!result.success || !result.diff) { ctx.app.notify(result.error || 'No changes'); return; }
        const preview = formatDiffForDisplay(result.diff, 50);
        ctx.app.addMessage({ role: 'user', content: `/diff ${staged ? '--staged' : ''}` });
        import('../api/index').then(({ chat }) => {
          ctx.app.startStreaming();
          const history = ctx.app.getChatHistory();
          chat(
            `Review this git diff and provide feedback:\n\n\`\`\`diff\n${preview}\n\`\`\``,
            history,
            (chunk) => ctx.app.addStreamChunk(chunk),
            undefined,
            ctx.projectContext,
            undefined,
          ).then(() => ctx.app.endStreaming()).catch(() => ctx.app.endStreaming());
        });
      });
      break;
    }

    case 'undo': {
      import('../utils/agent').then(({ undoLastAction }) => {
        const result = undoLastAction();
        ctx.app.notify(result.success ? `Undo: ${result.message}` : `Cannot undo: ${result.message}`);
      });
      break;
    }

    case 'undo-all': {
      import('../utils/agent').then(({ undoAllActions }) => {
        const result = undoAllActions();
        ctx.app.notify(result.success ? `Undone ${result.results.length} action(s)` : 'Nothing to undo');
      });
      break;
    }

    case 'init': {
      const initPath = ctx.projectPath || process.cwd();
      if (isManuallyInitializedProject(initPath)) {
        ctx.app.notify('Already initialized. Use /scan to refresh project intelligence.');
        break;
      }
      const ok = initializeAsProject(initPath);
      if (!ok) { ctx.app.notify('Failed to create .codeep/ directory.'); break; }
      ctx.app.notify('✓ Project initialized (.codeep/ created)\nRun /scan to analyze the project and build AI context.');
      break;
    }

    case 'scan': {
      if (!ctx.projectContext) { ctx.app.notify('No project context'); return; }
      ctx.app.notify('Scanning project...');
      import('../utils/projectIntelligence').then(({ scanProject, saveProjectIntelligence, generateContextFromIntelligence }) => {
        scanProject(ctx.projectContext!.root).then(intelligence => {
          saveProjectIntelligence(ctx.projectContext!.root, intelligence);
          const context = generateContextFromIntelligence(intelligence);
          ctx.app.addMessage({ role: 'assistant', content: `# Project Scan Complete\n\n${context}` });
          ctx.app.notify(`Scanned: ${intelligence.structure.totalFiles} files`);
        }).catch(err => {
          ctx.app.notify(`Scan failed: ${err.message}`);
        });
      });
      break;
    }

    case 'review': {
      if (!ctx.projectContext) { ctx.app.notify('No project context'); return; }
      const staged = args.includes('--staged') || args.includes('-s');
      const staticOnly = args.includes('--static');

      if (staticOnly) {
        // Static regex analysis
        import('../utils/codeReview').then(({ performCodeReview, formatReviewResult }) => {
          const reviewFiles = args.filter(a => !a.startsWith('-'));
          const result = performCodeReview(ctx.projectContext!, reviewFiles.length ? reviewFiles : undefined);
          ctx.app.addMessage({ role: 'system', content: `/review --static` });
          ctx.app.addMessage({ role: 'assistant', content: formatReviewResult(result) });
        });
        break;
      }

      // AI-powered review of git diff
      ctx.app.notify(staged ? 'Reviewing staged changes...' : 'Reviewing changes...');
      import('../utils/git').then(({ getGitDiff }) => {
        const diffResult = getGitDiff(staged, ctx.projectPath);

        if (!diffResult.success || !diffResult.diff) {
          // No diff — fall back to static analysis
          ctx.app.notify('No git changes found, running static review...');
          import('../utils/codeReview').then(({ performCodeReview, formatReviewResult }) => {
            const result = performCodeReview(ctx.projectContext!);
            ctx.app.addMessage({ role: 'assistant', content: formatReviewResult(result) });
          });
          return;
        }

        const diffText = diffResult.diff.length > 12000
          ? diffResult.diff.slice(0, 12000) + '\n\n[diff truncated]'
          : diffResult.diff;

        const prompt = `You are doing a code review. Analyze this git diff and give structured feedback.

\`\`\`diff
${diffText}
\`\`\`

Review for:
1. **Bugs** — logic errors, off-by-one, null/undefined issues
2. **Security** — injection, auth issues, exposed secrets, unsafe operations
3. **Performance** — unnecessary loops, missing indexes, memory leaks
4. **Edge cases** — unhandled inputs, missing error handling
5. **Code quality** — readability, naming, duplication

Format: use headers per category, only include categories where you found issues. End with a short overall verdict (1-2 sentences). Be concise and specific — reference file names and line numbers from the diff where possible.`;

        ctx.app.addMessage({ role: 'user', content: `/review${staged ? ' --staged' : ''}` });
        import('../api/index').then(({ chat }) => {
          ctx.app.startStreaming();
          chat(
            prompt,
            [],
            (chunk) => ctx.app.addStreamChunk(chunk),
            undefined,
            ctx.projectContext,
            undefined,
          ).then(() => ctx.app.endStreaming()).catch(() => ctx.app.endStreaming());
        });
      });
      break;
    }

    case 'update': {
      ctx.app.notify('Checking for updates...');
      import('../utils/update').then(({ checkForUpdates, formatVersionInfo }) => {
        checkForUpdates().then(info => {
          ctx.app.notify(formatVersionInfo(info).split('\n')[0], 5000);
        }).catch(() => {
          ctx.app.notify('Failed to check for updates');
        });
      });
      break;
    }

    case 'rename': {
      if (!args.length) { ctx.app.notify('Usage: /rename <new-name>'); return; }
      const newName = joinSessionName(args);
      const messages = ctx.app.getMessages();
      if (messages.length === 0) { ctx.app.notify('No messages to save. Start a conversation first.'); return; }
      saveSession(ctx.sessionId, messages, ctx.projectPath);
      if (renameSession(ctx.sessionId, newName, ctx.projectPath)) {
        const oldId = ctx.sessionId;
        ctx.setSessionId(newName);
        if (ctx.setSessionDisplayName) ctx.setSessionDisplayName(newName);
        ctx.app.notify(`Session renamed to: ${newName}`);
        // Sync new name to dashboard
        import('../utils/codeepCloud.js').then(({ syncSession, generateProjectId: gpi }) => {
          syncSession({
            sessionId: oldId,
            sessionName: newName,
            projectName: ctx.projectContext?.name,
            projectId: ctx.projectPath ? gpi(ctx.projectPath) : undefined,
            messages: ctx.app.getMessages(),
          });
        }).catch(() => {});
      } else {
        ctx.app.notify('Failed to rename session');
      }
      break;
    }

    case 'search': {
      if (!args.length) { ctx.app.notify('Usage: /search <term>'); return; }
      const searchTerm = args.join(' ').toLowerCase();
      const messages = ctx.app.getMessages();
      const searchResults = buildSearchSnippets(messages, searchTerm);
      if (searchResults.length === 0) {
        ctx.app.notify(`No matches for "${searchTerm}"`);
      } else {
        ctx.app.showSearch(searchTerm, searchResults, (messageIndex) => ctx.app.scrollToMessage(messageIndex));
      }
      break;
    }

    case 'recall': {
      // Cross-session search (vs /search which is current-session only).
      // Flags: --resume (load top match), --summarize (LLM recap).
      const wantResume = args.includes('--resume');
      const wantSummarize = args.includes('--summarize');
      const query = args.filter(a => a !== '--resume' && a !== '--summarize').join(' ');
      if (!query) {
        ctx.app.notify('Usage: /recall <query> [--resume | --summarize]');
        return;
      }
      const { recallSessions, formatRecall, summarizeRecall } = await import('../utils/recall');
      const matches = recallSessions(query, ctx.projectPath);

      if (matches.length === 0) {
        ctx.app.addMessage({ role: 'system', content: formatRecall(query, matches) });
        break;
      }

      if (wantResume) {
        // Load the top match directly — skip the list + /sessions dance.
        const top = matches[0];
        const loaded = loadSession(top.session.name, ctx.projectPath);
        if (loaded) {
          ctx.app.setMessages(loaded as Message[]);
          ctx.setSessionId(top.session.name);
          ctx.app.notify(`Resumed: ${top.session.title} (${top.session.name})`);
        } else {
          ctx.app.notify(`Couldn't load ${top.session.name}.`);
        }
        break;
      }

      if (wantSummarize) {
        ctx.app.notify('Summarizing matching sessions…');
        const summary = await summarizeRecall(query, matches, ctx.projectPath);
        const header = formatRecall(query, matches);
        const block = summary
          ? `${header}\n\n---\n\n### Summary\n\n${summary}`
          : header;
        ctx.app.addMessage({ role: 'system', content: block });
        break;
      }

      ctx.app.addMessage({ role: 'system', content: formatRecall(query, matches) });
      break;
    }

    case 'export': {
      const messages = ctx.app.getMessages();
      if (messages.length === 0) { ctx.app.notify('No messages to export'); return; }
      ctx.app.showExport((format) => {
        import('fs').then(fs => {
          import('path').then(path => {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            let filename: string;
            let content: string;
            if (format === 'json') {
              filename = `codeep-export-${timestamp}.json`;
              content = JSON.stringify(messages, null, 2);
            } else if (format === 'txt') {
              filename = `codeep-export-${timestamp}.txt`;
              content = messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}\n`).join('\n---\n\n');
            } else {
              filename = `codeep-export-${timestamp}.md`;
              content = `# Codeep Chat Export\n\n${messages.map(m =>
                `## ${m.role === 'user' ? '👤 User' : m.role === 'assistant' ? '🤖 Assistant' : '⚙️ System'}\n\n${m.content}\n`
              ).join('\n---\n\n')}`;
            }
            const exportPath = path.join(ctx.projectPath, filename);
            fs.promises.writeFile(exportPath, content).then(() => {
              ctx.app.notify(`Exported to ${filename}`);
            }).catch((err: Error) => {
              ctx.app.notify(`Export failed: ${err.message}`);
            });
          });
        });
      });
      break;
    }

    case 'protocol': {
      const currentProvider = getCurrentProvider();
      const providerConfig = getProvider(currentProvider.id);
      const protocols = Object.entries(PROTOCOLS)
        .filter(([key]) => providerConfig?.protocols[key as 'openai' | 'anthropic'])
        .map(([key, name]) => ({ key, label: name }));
      if (protocols.length <= 1) {
        ctx.app.notify(`${currentProvider.name} only supports ${protocols[0]?.label || 'one'} protocol`);
        break;
      }
      const currentProtocol = config.get('protocol') || 'openai';
      ctx.app.showSelect('Select Protocol', protocols, currentProtocol, (item) => {
        config.set('protocol', item.key as 'openai' | 'anthropic');
        ctx.app.notify(`Protocol: ${item.label}`);
      });
      break;
    }

    case 'lang': {
      const languages = Object.entries(LANGUAGES).map(([key, name]) => ({ key, label: name }));
      const currentLang = config.get('language') || 'auto';
      ctx.app.showSelect('Select Language', languages, currentLang, (item) => {
        config.set('language', item.key as string);
        ctx.app.notify(`Language: ${item.label}`);
      });
      break;
    }

    case 'login': {
      const providers = getProviderList();
      ctx.app.showLogin(providers.map(p => ({ id: p.id, name: p.name, description: p.description, subscribeUrl: p.subscribeUrl, noApiKey: p.noApiKey })), async (result) => {
        if (result) {
          setProvider(result.providerId);
          try {
            await setApiKey(result.apiKey);
            ctx.app.notify('Logged in successfully');
          } catch {
            ctx.app.notify('Could not save the API key (secure storage unavailable).');
          }
        }
      });
      break;
    }

    case 'logout': {
      const providers = getProviderList();
      const currentProvider = getCurrentProvider();
      const configuredProviders = providers
        .filter(p => !!getApiKey(p.id))
        .map(p => ({ id: p.id, name: p.name, isCurrent: p.id === currentProvider.id }));
      if (configuredProviders.length === 0) { ctx.app.notify('No providers configured'); return; }
      ctx.app.showLogoutPicker(configuredProviders, (result) => {
        if (result === null) return;
        if (result === 'all') {
          for (const p of configuredProviders) void clearApiKey(p.id);
          ctx.app.notify('Logged out from all providers. Use /login to sign in.');
        } else {
          void clearApiKey(result);
          const provider = configuredProviders.find(p => p.id === result);
          ctx.app.notify(`Logged out from ${provider?.name || result}`);
          if (result === currentProvider.id) {
            const remaining = configuredProviders.filter(p => p.id !== result);
            if (remaining.length > 0) {
              setProvider(remaining[0].id);
              ctx.app.notify(`Switched to ${remaining[0].name}`);
            } else {
              ctx.app.notify('No providers configured. Use /login to sign in.');
            }
          }
        }
      });
      break;
    }

    case 'git-commit': {
      const message = args.join(' ');
      if (!message) { ctx.app.notify('Usage: /git-commit <message>'); return; }
      // Use execFile to avoid shell injection — pass commit message as a direct argument
      import('child_process').then(({ execFile }) => {
        execFile('git', ['commit', '-m', message], { cwd: ctx.projectPath, encoding: 'utf-8' }, (err) => {
          if (err) {
            ctx.app.notify(`Commit failed: ${err.message}`);
          } else {
            ctx.app.notify('Committed successfully');
          }
        });
      });
      break;
    }

    case 'copy': {
      const blockNum = args[0] ? parseInt(args[0], 10) : -1;
      const messages = ctx.app.getMessages();
      const codeBlocks = messages.flatMap(m => extractCodeBlocks(m.content));
      if (codeBlocks.length === 0) { ctx.app.notify('No code blocks found'); return; }
      const index = resolveBlockIndex(blockNum, codeBlocks.length);
      if (index === null) {
        ctx.app.notify(`Invalid block number. Available: 1-${codeBlocks.length}`);
        return;
      }
      import('../utils/clipboard').then(({ copyToClipboard }) => {
        if (copyToClipboard(codeBlocks[index])) {
          ctx.app.notify(`Copied block ${index + 1} to clipboard`);
        } else {
          ctx.app.notify('Failed to copy to clipboard');
        }
      }).catch(() => ctx.app.notify('Clipboard not available'));
      break;
    }

    case 'paste': {
      import('clipboardy').then((clipboardy) => {
        try {
          const content = clipboardy.default.readSync();
          if (content && content.trim()) {
            ctx.app.handlePaste(content.trim());
          } else {
            ctx.app.notify('Clipboard is empty');
          }
        } catch { ctx.app.notify('Could not read clipboard'); }
      }).catch(() => ctx.app.notify('Clipboard not available'));
      break;
    }

    case 'apply': {
      const messages = ctx.app.getMessages();
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      if (!lastAssistant) { ctx.app.notify('No assistant response to apply'); return; }
      const changes = extractFileChanges(lastAssistant.content);
      if (changes.length === 0) { ctx.app.notify('No file changes found in response'); return; }
      if (!ctx.hasWriteAccess) { ctx.app.notify('Write access required. Use /grant first.'); return; }
      // Parse optional selective hunk spec: /apply --only file.ts:0,1 other.ts:2
      // Without --only, all hunks are applied (existing behavior).
      const selective = args.includes('--only') || args.includes('-o');
      const interactive = args.includes('--interactive') || args.includes('-i');
      const hunkSpecs = new Map<string, Set<number>>();
      if (selective) {
        for (const a of args) {
          if (a === '--only' || a === '-o') continue;
          const m = a.match(/^(.+):([\d,]+)$/);
          if (m) {
            const [, file, idxStr] = m;
            const idxs = new Set(idxStr.split(',').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)));
            hunkSpecs.set(file, idxs);
          }
        }
        // A spec that parsed to nothing must NOT fall through to the
        // apply-everything branch below — the user asked to restrict the
        // apply, so writing every change is the opposite of the request.
        if (hunkSpecs.size === 0) {
          ctx.app.notify('Invalid --only spec. Expected `--only <file>:<hunk>[,<hunk>]` (e.g. --only src/a.ts:0,2). Nothing applied.');
          return;
        }
      }
      import('fs').then(async (fs) => {
        import('path').then(async (pathModule) => {
          const { createFileDiff, applyHunksToFiles, countChangeHunks } =
            await import('../utils/diffPreview');
          type FileDiff = import('../utils/diffPreview').FileDiff;
          const diffLines: string[] = [];
          const fileDiffs: FileDiff[] = [];
          for (const change of changes) {
            const fullPath = pathModule.isAbsolute(change.path)
              ? change.path
              : pathModule.join(ctx.projectPath, change.path);
            let existingContent = '';
            try { existingContent = await fs.promises.readFile(fullPath, 'utf-8'); } catch {}
            const fd = createFileDiff(change.path, change.content, ctx.projectPath);
            fileDiffs.push(fd);
            const hunkCount = countChangeHunks(fd);
            diffLines.push(...formatApplyDiffLine(change, existingContent));
            if (hunkCount > 0) {
              diffLines.push(`  ↳ ${hunkCount} hunk(s) — use /apply --only ${change.path}:0,1 to select`);
            }
          }
          // Interactive mode: open the hunk picker (`git add -p` style).
          if (interactive) {
            type HunkPickerItem = import('./App').HunkPickerItem;
            const items: HunkPickerItem[] = [];
            for (const fd of fileDiffs) {
              for (let hi = 0; hi < fd.hunks.length; hi++) {
                const hunk = fd.hunks[hi];
                // Skip pure-context hunks (no add/remove).
                if (!hunk.lines.some((l) => l.type === 'add' || l.type === 'remove')) continue;
                const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
                const lines = hunk.lines.map((l) => {
                  if (l.type === 'add') return `+${l.content}`;
                  if (l.type === 'remove') return `-${l.content}`;
                  return ` ${l.content}`;
                });
                items.push({ path: fd.path, hunkIndex: hi, header, lines });
              }
            }
            if (items.length === 0) {
              ctx.app.notify('No change hunks to review');
              return;
            }
            ctx.app.showHunkPicker({
              title: '🎯 Review hunks',
              items,
              onComplete: (accepted) => {
                if (accepted.length === 0) {
                  ctx.app.notify('No hunks applied');
                  return;
                }
                (async () => {
                  // Group accepted hunk indices by file path.
                  const byPath = new Map<string, Set<number>>();
                  for (const a of accepted) {
                    let set = byPath.get(a.path);
                    if (!set) { set = new Set(); byPath.set(a.path, set); }
                    set.add(a.hunkIndex);
                  }
                  const results = applyHunksToFiles(fileDiffs, byPath);
                  let applied = 0;
                  for (const r of results) {
                    try {
                      const fullPath = pathModule.isAbsolute(r.path)
                        ? r.path
                        : pathModule.join(ctx.projectPath, r.path);
                      await fs.promises.mkdir(pathModule.dirname(fullPath), { recursive: true });
                      await fs.promises.writeFile(fullPath, r.content);
                      applied++;
                    } catch {}
                  }
                  ctx.app.notify(`Applied ${accepted.length} hunk(s) across ${applied} file(s)`);
                })().catch((e) => ctx.app.notify(`Apply failed: ${e instanceof Error ? e.message : String(e)}`));
              },
            });
            return;
          }

          const summary = selective && hunkSpecs.size > 0
            ? `Selective apply (${hunkSpecs.size} file(s) with chosen hunks)`
            : `Found ${changes.length} file(s) to apply`;
          ctx.app.showConfirm({
            title: '📝 Apply Changes',
            message: [
              summary,
              '',
              ...diffLines.slice(0, 12),
              ...(diffLines.length > 12 ? [`  ...and ${diffLines.length - 12} more`] : []),
              '',
              selective && hunkSpecs.size > 0 ? 'Apply selected hunks?' : 'Apply these changes?',
            ],
            confirmLabel: 'Apply',
            cancelLabel: 'Cancel',
            onConfirm: () => {
              (async () => {
                let applied = 0;
                if (selective && hunkSpecs.size > 0) {
                  // Per-hunk selective apply.
                  const results = applyHunksToFiles(fileDiffs, hunkSpecs);
                  for (const r of results) {
                    try {
                      const fullPath = pathModule.isAbsolute(r.path)
                        ? r.path
                        : pathModule.join(ctx.projectPath, r.path);
                      await fs.promises.mkdir(pathModule.dirname(fullPath), { recursive: true });
                      await fs.promises.writeFile(fullPath, r.content);
                      applied++;
                    } catch {}
                  }
                } else {
                  // All-or-nothing apply (original behavior).
                  for (const change of changes) {
                    try {
                      const fullPath = pathModule.isAbsolute(change.path)
                        ? change.path
                        : pathModule.join(ctx.projectPath, change.path);
                      await fs.promises.mkdir(pathModule.dirname(fullPath), { recursive: true });
                      await fs.promises.writeFile(fullPath, change.content);
                      applied++;
                    } catch {}
                  }
                }
                ctx.app.notify(`Applied ${applied}/${selective ? hunkSpecs.size : changes.length} file(s)`);
              })().catch((e) => ctx.app.notify(`Apply failed: ${e instanceof Error ? e.message : String(e)}`));
            },
            onCancel: () => ctx.app.notify('Apply cancelled'),
          });
        });
      }).catch((e) => ctx.app.notify(`Apply failed: ${e instanceof Error ? e.message : String(e)}`));
      break;
    }

    case 'add': {
      if (!args.length) {
        if (ctx.addedFiles.size === 0) {
          ctx.app.notify('Usage: /add <file-path> [file2] ... | No files added');
        } else {
          const fileList = Array.from(ctx.addedFiles.values()).map(f => f.relativePath).join(', ');
          ctx.app.notify(`Added files (${ctx.addedFiles.size}): ${fileList}`);
        }
        return;
      }
      const pathMod = await import('path');
      const fsMod = await import('fs');
      const root = ctx.projectContext?.root || ctx.projectPath;
      let added = 0;
      const errors: string[] = [];
      for (const filePath of args) {
        const fullPath = pathMod.isAbsolute(filePath) ? filePath : pathMod.join(root, filePath);
        const relativePath = pathMod.isAbsolute(filePath) ? pathMod.relative(root, filePath) : filePath;
        try {
          const stat = await fsMod.promises.stat(fullPath);
          if (!stat.isFile()) { errors.push(`${filePath}: not a file`); continue; }
          if (stat.size > 100000) {
            errors.push(`${filePath}: too large (${Math.round(stat.size / 1024)}KB, max 100KB)`);
            continue;
          }
          const content = await fsMod.promises.readFile(fullPath, 'utf-8');
          ctx.addedFiles.set(fullPath, { relativePath, content });
          added++;
        } catch {
          errors.push(`${filePath}: file not found`);
        }
      }
      if (added > 0) ctx.app.notify(`Added ${added} file(s) to context (${ctx.addedFiles.size} total)`);
      if (errors.length > 0) ctx.app.notify(errors.join(', '));
      break;
    }

    case 'drop': {
      if (!args.length) {
        if (ctx.addedFiles.size === 0) {
          ctx.app.notify('No files in context');
        } else {
          const count = ctx.addedFiles.size;
          ctx.addedFiles.clear();
          ctx.app.notify(`Dropped all ${count} file(s) from context`);
        }
        return;
      }
      const pathMod = await import('path');
      const root = ctx.projectContext?.root || ctx.projectPath;
      let dropped = 0;
      for (const filePath of args) {
        const fullPath = pathMod.isAbsolute(filePath) ? filePath : pathMod.join(root, filePath);
        if (ctx.addedFiles.delete(fullPath)) dropped++;
      }
      if (dropped > 0) {
        ctx.app.notify(`Dropped ${dropped} file(s) (${ctx.addedFiles.size} remaining)`);
      } else {
        ctx.app.notify('File not found in context. Use /add to see added files.');
      }
      break;
    }

    case 'history': {
      import('../utils/agent').then(({ getAgentHistory }) => {
        const history = getAgentHistory();
        if (history.length === 0) { ctx.app.notify('No agent history'); return; }
        const items = history.slice(0, 10).map(h =>
          `${new Date(h.timestamp).toLocaleString()} - ${h.task.slice(0, 30)}...`
        );
        ctx.app.showList('Agent History', items, (index) => {
          const selected = history[index];
          ctx.app.addMessage({
            role: 'system',
            content: `# Agent Session\n\n**Task:** ${selected.task}\n**Actions:** ${selected.actions.length}\n**Status:** ${selected.success ? '✓ Success' : '✗ Failed'}`,
          });
        });
      }).catch(() => ctx.app.notify('No agent history available'));
      break;
    }

    case 'changes': {
      import('../utils/agent').then(({ getCurrentSessionActions }) => {
        const actions = getCurrentSessionActions();
        if (actions.length === 0) { ctx.app.notify('No changes in current session'); return; }
        const summary = actions.map(a => `• ${a.type}: ${a.target} (${a.result})`).join('\n');
        ctx.app.addMessage({ role: 'system', content: `# Session Changes\n\n${summary}` });
      }).catch(() => ctx.app.notify('No changes tracked'));
      break;
    }

    case 'cost': {
      const { formatCostReport } = await import('../utils/tokenTracker');
      ctx.app.addMessage({ role: 'system', content: formatCostReport() });
      break;
    }

    case 'compact': {
      const messages = ctx.app.getMessages();
      const keepRecent = parseKeepRecent(args[0]);
      if (messages.length <= keepRecent + 2) {
        ctx.app.notify(`Nothing to compact — only ${messages.length} message(s) in this session.`);
        break;
      }
      ctx.app.notify(`Compacting ${messages.length - keepRecent} older message(s)…`);
      const { compactHistory } = await import('../utils/context');
      try {
        const result = await compactHistory(messages, { keepRecent, projectContext: ctx.projectContext });
        if (result.replaced === 0) {
          ctx.app.notify('Nothing to compact');
          break;
        }
        ctx.app.setMessages(result.compacted);
        // Persist so the compacted history survives a restart.
        saveSession(ctx.sessionId, result.compacted, ctx.projectPath);
        ctx.app.addMessage({
          role: 'system',
          content: `# Conversation Compacted\n\nReplaced ${result.replaced} earlier message${result.replaced === 1 ? '' : 's'} with a summary. Kept the last ${keepRecent} message${keepRecent === 1 ? '' : 's'} verbatim.\n\n**Summary:**\n\n${result.summary}`,
        });
      } catch (err) {
        ctx.app.notify(`Compaction failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'checkpoint': {
      const sub = args[0]?.toLowerCase();
      const { createCheckpoint, deleteCheckpoint, listCheckpoints, formatCheckpointList } = await import('../utils/checkpoints');
      const { getCurrentSessionActions } = await import('../utils/agent');

      if (sub === 'delete') {
        const id = args[1];
        if (!id) { ctx.app.notify('Usage: /checkpoint delete <id>'); break; }
        ctx.app.notify(deleteCheckpoint(ctx.projectPath, id) ? `Deleted checkpoint ${id}` : `Checkpoint not found: ${id}`);
        break;
      }
      if (sub === 'list') {
        ctx.app.addMessage({ role: 'system', content: formatCheckpointList(listCheckpoints(ctx.projectPath)) });
        break;
      }

      const name = args.join(' ').trim() || undefined;
      const provider = getCurrentProvider();
      const filesTouched = Array.from(new Set(
        getCurrentSessionActions()
          .filter(a => a.target && (a.type === 'write' || a.type === 'edit' || a.type === 'delete' || a.type === 'mkdir'))
          .map(a => a.target),
      ));
      const cp = createCheckpoint({
        workspaceRoot: ctx.projectPath,
        sessionId: ctx.sessionId,
        provider: provider.id,
        model: config.get('model') as string,
        messages: ctx.app.getMessages(),
        filesTouched,
        name,
      });
      ctx.app.addMessage({
        role: 'system',
        content: `# Checkpoint created\n\n\`${cp.id}\`${cp.name ? ` — **${cp.name}**` : ''}\n\nCaptured ${cp.messages.length} message${cp.messages.length === 1 ? '' : 's'}, ${cp.filesTouched.length} file${cp.filesTouched.length === 1 ? '' : 's'} touched${cp.gitHead ? `, git \`${cp.gitHead}\`` : ''}.\n\nUse \`/rewind ${cp.id}\` to restore.`,
      });
      break;
    }

    case 'checkpoints': {
      const { listCheckpoints, formatCheckpointList } = await import('../utils/checkpoints');
      ctx.app.addMessage({ role: 'system', content: formatCheckpointList(listCheckpoints(ctx.projectPath)) });
      break;
    }

    case 'openrouter': {
      const { readOpenRouterPreferences, writeOpenRouterPreferences, formatOpenRouterPreferences } = await import('../utils/openrouterPrefs');
      const sub = args[0]?.toLowerCase();
      const current = readOpenRouterPreferences();

      if (!sub || sub === 'show') {
        ctx.app.addMessage({ role: 'system', content: formatOpenRouterPreferences(current) });
        break;
      }
      if (sub === 'clear') {
        writeOpenRouterPreferences(null);
        ctx.app.notify('OpenRouter preferences cleared');
        break;
      }
      if (sub === 'prefer') {
        const list = args.slice(1).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        if (list.length === 0) { ctx.app.notify('Usage: /openrouter prefer <p1>[,<p2>...]'); break; }
        writeOpenRouterPreferences({ ...current, order: list });
        ctx.app.notify(`OpenRouter preference: ${list.join(' → ')}`);
        break;
      }
      if (sub === 'ignore') {
        const list = args.slice(1).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        if (list.length === 0) { ctx.app.notify('Usage: /openrouter ignore <p1>[,<p2>...]'); break; }
        writeOpenRouterPreferences({ ...current, ignore: list });
        ctx.app.notify(`OpenRouter ignoring: ${list.join(', ')}`);
        break;
      }
      if (sub === 'fallbacks') {
        const val = args[1]?.toLowerCase();
        if (val !== 'on' && val !== 'off') { ctx.app.notify('Usage: /openrouter fallbacks on|off'); break; }
        writeOpenRouterPreferences({ ...current, allow_fallbacks: val === 'on' });
        ctx.app.notify(`Fallbacks ${val}`);
        break;
      }
      if (sub === 'privacy') {
        const val = args[1]?.toLowerCase();
        if (val !== 'strict' && val !== 'allow') { ctx.app.notify('Usage: /openrouter privacy strict|allow'); break; }
        writeOpenRouterPreferences({ ...current, data_collection: val === 'strict' ? 'deny' : 'allow' });
        ctx.app.notify(`Privacy: ${val}`);
        break;
      }
      ctx.app.notify(`Unknown subcommand: ${sub}`);
      break;
    }

    case 'hooks': {
      const { listInstalledHooks, formatHookList, formatHookTrust, trustWorkspaceHooks, untrustWorkspaceHooks } = await import('../utils/hooks');
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'trust') {
        trustWorkspaceHooks(ctx.projectPath);
        ctx.app.notify('Hooks trusted for this workspace — they will now run.');
        break;
      }
      if (sub === 'untrust') {
        untrustWorkspaceHooks(ctx.projectPath);
        ctx.app.notify('Hooks untrusted — they will be skipped until you trust again.');
        break;
      }
      const trust = formatHookTrust(ctx.projectPath);
      const body = formatHookList(listInstalledHooks(ctx.projectPath)) + (trust ? `\n\n${trust}` : '');
      ctx.app.addMessage({ role: 'system', content: body });
      break;
    }

    case 'rewind': {
      const id = args[0];
      if (!id) { ctx.app.notify('Usage: /rewind <id> — run /checkpoints to see ids'); break; }
      const { loadCheckpoint, buildRewindGitHint } = await import('../utils/checkpoints');
      const cp = loadCheckpoint(ctx.projectPath, id);
      if (!cp) { ctx.app.notify(`Checkpoint not found: ${id}`); break; }

      const replacedCount = ctx.app.getMessages().length;
      ctx.app.setMessages(cp.messages);
      saveSession(ctx.sessionId, cp.messages, ctx.projectPath);

      // Switch provider/model back to checkpoint state if different.
      if (cp.provider && cp.provider !== getCurrentProvider().id) setProvider(cp.provider);
      if (cp.model && cp.model !== (config.get('model') as string)) config.set('model', cp.model);

      ctx.app.addMessage({
        role: 'system',
        content: `# Rewound to ${cp.name ? `**${cp.name}**` : `\`${cp.id}\``}\n\nRestored ${cp.messages.length} message${cp.messages.length === 1 ? '' : 's'} (was ${replacedCount}). Provider: \`${cp.provider}\` · Model: \`${cp.model}\`\n\n${buildRewindGitHint(cp)}`,
      });
      break;
    }

    case 'context-save': {
      const messages = ctx.app.getMessages();
      if (saveSession(`context-${ctx.sessionId}`, messages, ctx.projectPath)) {
        ctx.app.notify('Context saved');
      } else {
        ctx.app.notify('Failed to save context');
      }
      break;
    }

    case 'context-load': {
      const loaded = loadSession(`context-${ctx.sessionId}`, ctx.projectPath);
      if (loaded) {
        ctx.app.setMessages(loaded as Message[]);
        ctx.app.notify('Context loaded');
      } else {
        ctx.app.notify('No saved context found');
      }
      break;
    }

    case 'context-clear': {
      deleteSession(`context-${ctx.sessionId}`, ctx.projectPath);
      ctx.app.notify('Context cleared');
      break;
    }

    case 'learn': {
      if (args[0] === 'status') {
        import('../utils/learning').then(({ getLearningStatus }) => {
          const status = getLearningStatus(ctx.projectPath);
          ctx.app.addMessage({ role: 'system', content: `# Learning Status\n\n${status}` });
        }).catch(() => ctx.app.notify('Learning module not available'));
        return;
      }
      if (args[0] === 'rule' && args.length > 1) {
        import('../utils/learning').then(({ addCustomRule }) => {
          addCustomRule(ctx.projectPath, args.slice(1).join(' '));
          ctx.app.notify('Custom rule added');
        }).catch(() => ctx.app.notify('Learning module not available'));
        return;
      }
      if (!ctx.projectContext) { ctx.app.notify('No project context'); return; }
      ctx.app.notify('Learning from project...');
      import('../utils/learning').then(({ learnFromProject, formatPreferencesForPrompt }) => {
        import('fs').then(async (fs) => {
          import('path').then(async (path) => {
            const files: string[] = [];
            const extensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs'];
            const walkDir = async (dir: string, depth = 0): Promise<void> => {
              if (depth > 3 || files.length >= 20) return;
              try {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                  const fullPath = path.join(dir, entry.name);
                  if (entry.isDirectory()) await walkDir(fullPath, depth + 1);
                  else if (extensions.some(ext => entry.name.endsWith(ext))) {
                    files.push(path.relative(ctx.projectContext!.root, fullPath));
                  }
                  if (files.length >= 20) break;
                }
              } catch {}
            };
            await walkDir(ctx.projectContext!.root);
            if (files.length === 0) { ctx.app.notify('No source files found to learn from'); return; }
            const prefs = learnFromProject(ctx.projectContext!.root, files);
            const formatted = formatPreferencesForPrompt(prefs);
            ctx.app.addMessage({ role: 'system', content: `# Learned Preferences\n\n${formatted}` });
            ctx.app.notify(`Learned from ${files.length} files`);
          });
        });
      }).catch(() => ctx.app.notify('Learning module not available'));
      break;
    }

    // Built-in skill shortcuts
    case 'c':
    case 'commit':
    case 't':
    case 'test':
    case 'r':
    case 'refactor':
    case 'f':
    case 'fix':
    case 'e':
    case 'explain':
    case 'o':
    case 'optimize':
    case 'b':
    case 'debug':
    case 'p':
    case 'push':
    case 'pull':
    case 'amend':
    case 'pr':
    case 'changelog':
    case 'branch':
    case 'stash':
    case 'unstash':
    case 'build':
    case 'deploy':
    case 'release':
    case 'publish': {
      runSkill(command, args, ctx).catch((err: Error) => {
        ctx.app.notify(`Skill error: ${err.message}`);
      });
      break;
    }

    case 'skills': {
      const sub = args[0]?.toLowerCase();

      // Structured skill bundles (separate from the JSON skills in skills.ts).
      if (sub === 'bundles' || sub === 'list-bundles') {
        const { loadSkillBundles, formatBundleList } = await import('../utils/skillBundles');
        ctx.app.addMessage({ role: 'system', content: formatBundleList(loadSkillBundles(ctx.projectPath)) });
        break;
      }

      if (sub === 'create-bundle') {
        const name = (args[1] ?? '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          ctx.app.notify('Usage: /skills create-bundle <name> — lowercase letters/digits/hyphens');
          break;
        }
        const { mkdirSync, writeFileSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const dir = join(ctx.projectPath, '.codeep', 'skills', name);
        if (existsSync(dir)) {
          ctx.app.notify(`Skill ${name} already exists`);
          break;
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: One-sentence summary shown in the agent's catalog.
triggers:
  - keyword
  - phrase
---

# ${name}

Describe what this skill does. The agent reads this body verbatim when it invokes the skill.

## Steps

1. First step
2. Second step
3. …
`);
        ctx.app.addMessage({
          role: 'system',
          content: `Created skill bundle at \`.codeep/skills/${name}/SKILL.md\`. Edit it, then \`/skills bundles\` to confirm.`,
        });
        break;
      }

      if (sub === 'show' || sub === 'detail') {
        const name = args[1];
        if (!name) { ctx.app.notify('Usage: /skills show <name>'); break; }
        const { findSkillBundle } = await import('../utils/skillBundles');
        const bundle = findSkillBundle(name, ctx.projectPath);
        if (!bundle) { ctx.app.notify(`Skill ${name} not found`); break; }
        ctx.app.addMessage({ role: 'system', content: formatSkillsShow(bundle) });
        break;
      }

      // Marketplace operations against codeep.dev.
      if (sub === 'publish') {
        const slug = args[1];
        if (!slug) { ctx.app.notify('Usage: /skills publish <slug> [--public]'); break; }
        const isPublic = args.includes('--public');
        ctx.app.notify(`Publishing ${slug} to codeep.dev…`);
        const { publishBundle } = await import('../utils/skillBundlesCloud');
        const result = await publishBundle(ctx.projectPath, slug, { isPublic });
        if (!result.ok) { ctx.app.notify(`Publish failed: ${result.error}`); break; }
        ctx.app.addMessage({ role: 'system', content: formatSkillsPublishResult(slug, isPublic, result.skill?.owner_username) });
        break;
      }

      if (sub === 'install') {
        const target = args[1];
        if (!target) { ctx.app.notify('Usage: /skills install <owner>/<slug>'); break; }
        const { installBundle } = await import('../utils/skillBundlesCloud');
        ctx.app.notify(`Fetching ${target}…`);
        const result = await installBundle(ctx.projectPath, target);
        if (!result.ok) { ctx.app.notify(`Install failed: ${result.error}`); break; }
        ctx.app.notify(`Installed ${result.name} to .codeep/skills/${result.name}/`);
        break;
      }

      if (sub === 'browse') {
        const query = args.slice(1).join(' ').trim();
        const { browseSkills } = await import('../utils/skillBundlesCloud');
        ctx.app.notify('Fetching marketplace…');
        const result = await browseSkills({ query });
        if (!result.ok) { ctx.app.notify(`Browse failed: ${result.error}`); break; }
        const skills = result.skills ?? [];
        if (skills.length === 0) {
          ctx.app.addMessage({ role: 'system', content: formatSkillsBrowseEmpty(query) });
          break;
        }
        const lines = [`# ${query ? `Skills matching "${query}"` : 'Public skills'}`, ''];
        for (const s of skills.slice(0, 30)) {
          const owner = s.owner_username ?? s.github_id;
          const ver = s.version ? ` v${s.version}` : '';
          lines.push(`- **${s.name}** \`${owner}/${s.slug}\`${ver} — ${s.description} _(${s.install_count} installs)_`);
        }
        if (skills.length > 30) lines.push('', `_(showing first 30 of ${skills.length})_`);
        lines.push('', 'Install with `/skills install <owner>/<slug>`.');
        ctx.app.addMessage({ role: 'system', content: lines.join('\n') });
        break;
      }

      if (sub === 'unpublish') {
        const target = args[1];
        if (!target) { ctx.app.notify('Usage: /skills unpublish <owner>/<slug>'); break; }
        const { unpublishBundle } = await import('../utils/skillBundlesCloud');
        const result = await unpublishBundle(target);
        if (!result.ok) { ctx.app.notify(`Unpublish failed: ${result.error}`); break; }
        ctx.app.notify(`Unpublished ${target} from codeep.dev`);
        break;
      }

      // Default: built-in JSON skills (legacy behaviour).
      import('../utils/skills').then(({ getAllSkills, searchSkills, formatSkillsList, getSkillStats }) => {
        const query = args.join(' ').toLowerCase();
        if (query === 'stats') {
          const stats = getSkillStats();
          ctx.app.addMessage({
            role: 'system',
            content: `# Skill Statistics\n\n- Total usage: ${stats.totalUsage}\n- Unique skills used: ${stats.uniqueSkills}\n- Success rate: ${stats.successRate}%`,
          });
          return;
        }
        const skills = query ? searchSkills(query) : getAllSkills();
        if (skills.length === 0) { ctx.app.notify(`No skills matching "${query}"`); return; }
        ctx.app.addMessage({ role: 'system', content: formatSkillsList(skills) });
      });
      break;
    }

    case 'skill': {
      import('../utils/skills').then(({
        findSkill, formatSkillHelp, createSkillTemplate, saveCustomSkill, deleteCustomSkill,
      }) => {
        const subCommand = args[0]?.toLowerCase();
        const skillName = args[1];
        if (!subCommand) { ctx.app.notify('Usage: /skill <help|create|delete> <name>'); return; }
        switch (subCommand) {
          case 'help': {
            if (!skillName) { ctx.app.notify('Usage: /skill help <skill-name>'); return; }
            const skill = findSkill(skillName);
            if (!skill) { ctx.app.notify(`Skill not found: ${skillName}`); return; }
            ctx.app.addMessage({ role: 'system', content: formatSkillHelp(skill) });
            break;
          }
          case 'create': {
            if (!skillName) { ctx.app.notify('Usage: /skill create <name>'); return; }
            if (findSkill(skillName)) { ctx.app.notify(`Skill "${skillName}" already exists`); return; }
            const template = createSkillTemplate(skillName);
            saveCustomSkill(template);
            ctx.app.addMessage({
              role: 'system',
              content: `# Custom Skill Created: ${skillName}\n\nEdit the skill file at:\n~/.codeep/skills/${skillName}.json\n\nTemplate:\n\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\``,
            });
            break;
          }
          case 'delete': {
            if (!skillName) { ctx.app.notify('Usage: /skill delete <name>'); return; }
            if (deleteCustomSkill(skillName)) {
              ctx.app.notify(`Deleted skill: ${skillName}`);
            } else {
              ctx.app.notify(`Could not delete skill: ${skillName}`);
            }
            break;
          }
          default: {
            const skill = findSkill(subCommand);
            if (skill) {
              ctx.app.notify(`Running skill: ${skill.name}`);
              ctx.app.addMessage({ role: 'system', content: `**/${skill.name}**: ${skill.description}` });
            } else {
              ctx.app.notify(`Unknown skill command: ${subCommand}`);
            }
          }
        }
      });
      break;
    }

    case 'tasks': {
      const { fetchTasks, markTaskDone, generateProjectId } = await import('../utils/codeepCloud');
      const { setTaskContext, clearTaskContext } = await import('../utils/taskContext');
      const subCmd = args[0]?.toLowerCase();

      // /tasks done <n>  — mark task #n as done (1-based index from last /tasks list)
      if (subCmd === 'done') {
        const idx = parseInt(args[1] ?? '', 10);
        if (isNaN(idx) || idx < 1) { ctx.app.notify('Usage: /tasks done <number>'); break; }
        const projectName = ctx.projectContext?.name;
        const projectId = ctx.projectContext?.root ? generateProjectId(ctx.projectContext.root) : undefined;
        const tasks = await fetchTasks(projectName, projectId);
        if (tasks === null) { ctx.app.notify('Not linked to codeep.dev. Run: codeep account'); break; }
        const task = tasks[idx - 1];
        if (!task) { ctx.app.notify(`No task #${idx}. Run /tasks to see the list.`); break; }
        const ok = await markTaskDone(task.id);
        if (ok) {
          ctx.app.notify(`✓ Done: ${task.title}`);
          clearTaskContext();
        } else {
          ctx.app.notify('Failed to mark task as done');
        }
        break;
      }

      // /tasks delete <n>  — delete task #n permanently
      if (subCmd === 'delete') {
        const idx = parseInt(args[1] ?? '', 10);
        if (isNaN(idx) || idx < 1) { ctx.app.notify('Usage: /tasks delete <number>'); break; }
        const projectName = ctx.projectContext?.name;
        const projectId = ctx.projectContext?.root ? generateProjectId(ctx.projectContext.root) : undefined;
        const tasks = await fetchTasks(projectName, projectId);
        if (tasks === null) { ctx.app.notify('Not linked to codeep.dev. Run: codeep account'); break; }
        const task = tasks[idx - 1];
        if (!task) { ctx.app.notify(`No task #${idx}. Run /tasks to see the list.`); break; }
        const { getSyncToken } = await import('../config/index.js');
        const syncToken = getSyncToken();
        if (!syncToken) { ctx.app.notify('Not linked to codeep.dev. Run: codeep account'); break; }
        try {
          const res = await fetch('https://codeep.dev/api/tasks', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
            body: JSON.stringify({ id: task.id }),
          });
          ctx.app.notify(res.ok ? `✗ Deleted: ${task.title}` : 'Failed to delete task');
        } catch {
          ctx.app.notify('Failed to delete task (network error)');
        }
        break;
      }

      // /tasks add <title> [--bug | --feature] [--desc <text>]  — create a task
      // on the dashboard. Type matches the dashboard picker (task | bug |
      // feature); a --bug/--feature/--task flag anywhere sets it (default task).
      // --desc/--description captures the following words (until the next flag)
      // as the description — the same field the dashboard + macOS app set, and
      // which the list view and the agent task-context prompt already render.
      if (subCmd === 'add') {
        const { title, description, type } = parseTaskAddArgs(args.slice(1));
        if (!title) { ctx.app.notify('Usage: /tasks add <title> [--bug | --feature] [--desc <text>]'); break; }
        const projectName = ctx.projectContext?.name;
        const projectId = ctx.projectContext?.root ? generateProjectId(ctx.projectContext.root) : undefined;
        const { getSyncToken } = await import('../config/index.js');
        const syncToken = getSyncToken();
        if (!syncToken) { ctx.app.notify('Not linked to codeep.dev. Run: codeep account'); break; }
        try {
          const res = await fetch('https://codeep.dev/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sync-token': syncToken },
            body: JSON.stringify({ projectName: projectName || '', projectId: projectId ?? null, title, type, ...(description ? { description } : {}) }),
          });
          if (res.ok) {
            ctx.app.notify(`+ ${type[0].toUpperCase()}${type.slice(1)} added: ${title}`);
          } else {
            ctx.app.notify('Failed to add task');
          }
        } catch {
          ctx.app.notify('Failed to add task (network error)');
        }
        break;
      }

      // /tasks  — list pending tasks and load into agent context
      const projectName = ctx.projectContext?.name;
      const projectId = ctx.projectContext?.root ? generateProjectId(ctx.projectContext.root) : undefined;
      const tasks = await fetchTasks(projectName, projectId);

      if (tasks === null) {
        ctx.app.notify('Not linked to codeep.dev. Run: codeep account');
        break;
      }
      if (tasks.length === 0) {
        clearTaskContext();
        ctx.app.notify(projectName ? `No pending tasks for "${projectName}"` : 'No pending tasks');
        break;
      }

      setTaskContext(tasks);
      ctx.app.addMessage({ role: 'system', content: formatTaskList(tasks, projectName) } as Message);
      break;
    }

    case 'profile': {
      const subCmd = args[0]?.toLowerCase();
      const profileName = args[1] || args[0]; // /profile save name OR /profile name

      if (!subCmd || subCmd === 'list') {
        const profiles = listProfiles();
        if (profiles.length === 0) {
          ctx.app.notify('No profiles saved. Use /profile save <name>');
        } else {
        ctx.app.addMessage({ role: 'system', content: formatProfileList(profiles) } as Message);
        }
        break;
      }

      if (subCmd === 'save') {
        const name = args[1];
        if (!name) { ctx.app.notify('Usage: /profile save <name>'); break; }
        if (saveProfile(name)) ctx.app.notify(`Profile saved: ${name}`);
        else ctx.app.notify('Failed to save profile');
        break;
      }

      if (subCmd === 'load') {
        const name = args[1];
        if (!name) { ctx.app.notify('Usage: /profile load <name>'); break; }
        const profile = loadProfile(name);
        if (!profile) { ctx.app.notify(`Profile not found: ${name}`); break; }
        applyProfile(profile);
        ctx.app.notify(`Profile loaded: ${profile.name} (${profile.provider} / ${profile.model})`);
        break;
      }

      if (subCmd === 'delete') {
        const name = args[1];
        if (!name) { ctx.app.notify('Usage: /profile delete <name>'); break; }
        if (deleteProfile(name)) ctx.app.notify(`Profile deleted: ${name}`);
        else ctx.app.notify(`Profile not found: ${name}`);
        break;
      }

      // /profile <name> — shorthand for load
      const profile = loadProfile(subCmd);
      if (profile) {
        applyProfile(profile);
        ctx.app.notify(`Profile loaded: ${profile.name} (${profile.provider} / ${profile.model})`);
      } else {
        ctx.app.notify(`Unknown profile subcommand: ${subCmd}. Use save / load / delete / list`);
      }
      break;
    }

    case 'sync': {
      const subCmd = args[0]?.toLowerCase() || 'all';
      const { pushLearning, pullLearning, pushProfiles, pullProfiles } = await import('../utils/codeepCloud');
      const { getSyncToken } = await import('../config/index');
      const { loadGlobalPreferences, saveGlobalPreferences } = await import('../utils/learning');

      if (!getSyncToken()) {
        ctx.app.notify('Not linked to codeep.dev. Run: codeep account');
        break;
      }

      const results: string[] = [];

      // Sync learning preferences
      if (subCmd === 'all' || subCmd === 'learning') {
        // Push local → cloud
        const prefs = loadGlobalPreferences();
        const pushed = await pushLearning(prefs);
        if (pushed) {
          results.push('✓ Learning preferences pushed');
        } else {
          results.push('✗ Failed to push learning preferences');
        }
      }

      // Sync profiles
      if (subCmd === 'all' || subCmd === 'profiles') {
        // Push all local profiles → cloud
        const profileNames = listProfiles();
        if (profileNames.length > 0) {
          const profileMap: Record<string, object> = {};
          for (const name of profileNames) {
            const p = loadProfile(name);
            if (p) profileMap[name] = p;
          }
          const pushed = await pushProfiles(profileMap);
          if (pushed) {
            results.push(`✓ ${profileNames.length} profile(s) pushed`);
          } else {
            results.push('✗ Failed to push profiles');
          }
        } else {
          results.push('No local profiles to push');
        }

        // Pull cloud profiles → local (merge)
        const cloudProfiles = await pullProfiles();
        if (cloudProfiles) {
          let pulled = 0;
          for (const [name, data] of Object.entries(cloudProfiles)) {
            const existing = loadProfile(name);
            if (!existing) {
              const { writeFileSync, mkdirSync, existsSync } = await import('fs');
              const { join } = await import('path');
              const { homedir } = await import('os');
              const dir = join(homedir(), '.codeep', 'profiles');
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
              pulled++;
            }
          }
          if (pulled > 0) results.push(`✓ ${pulled} new profile(s) pulled`);
        }
      }

      // Sync the hand-written user profile (~/.codeep/profile.md). Push sends
      // the local file; pull is additive (writes only if no local profile).
      if (subCmd === 'all' || subCmd === 'profile') {
        const { pushUserProfile, pullUserProfile } = await import('../utils/codeepCloud');
        if (await pushUserProfile()) results.push('✓ Your profile (about you) pushed');
        if ((await pullUserProfile()) === 1) results.push('✓ Your profile pulled to this machine');
      }

      ctx.app.addMessage({
        role: 'system',
        content: `## Sync\n\n${results.map(r => `- ${r}`).join('\n')}`,
      } as Message);
      break;
    }

    // /stats — detailed session view: per-model breakdown, total, prompt-cache
    // summary, and the per-1M pricing reference. `/cost` is the concise sibling
    // (formatCostReport, above); the two are intentionally distinct, so this
    // case no longer also claims 'cost' (which always hit the handler above).
    case 'stats': {
      const { getCostBreakdown, getSessionStats, formatTokenCount, getPricingTable, getCacheStats } = await import('../utils/tokenTracker');
      const stats = getSessionStats();
      const content = formatStatsReport({
        totals: stats,
        breakdown: getCostBreakdown(),
        cache: getCacheStats(),
        pricing: getPricingTable(),
        currentProvider: config.get('provider'),
        fmt: formatTokenCount,
      });
      ctx.app.addMessage({ role: 'system', content } as Message);
      break;
    }

    case 'memory': {
      const sub = args[0]?.toLowerCase();
      const projectCtx = getProjectContext(ctx.projectPath);
      const projectRoot = projectCtx?.root || ctx.projectPath;
      const intelligence = loadProjectIntelligence(projectRoot);

      if (!intelligence) {
        ctx.app.notify('No project intelligence found. Run /scan first.');
        break;
      }
      intelligence.notes = intelligence.notes || [];

      if (sub === 'list') {
        if (intelligence.notes.length === 0) {
          ctx.app.notify('No memory notes. Add one with: /memory <note>');
        } else {
          ctx.app.addMessage({ role: 'assistant', content: formatMemoryList(intelligence.notes) });
        }
        break;
      }

      if (sub === 'remove') {
        const idx = parseInt(args[1], 10);
        if (isNaN(idx) || idx < 1 || idx > intelligence.notes.length) {
          ctx.app.notify(`Usage: /memory remove <n>  — run /memory list to see indices`);
          break;
        }
        const removed = intelligence.notes.splice(idx - 1, 1)[0];
        saveProjectIntelligence(projectRoot, intelligence);
        import('../utils/codeepCloud.js').then(({ syncMemoryNotes }) => syncMemoryNotes(projectCtx?.name || '', intelligence.notes)).catch(() => {});
        ctx.app.notify(`Removed: "${removed}"`);
        break;
      }

      if (sub === 'clear') {
        const count = intelligence.notes.length;
        intelligence.notes = [];
        saveProjectIntelligence(projectRoot, intelligence);
        import('../utils/codeepCloud.js').then(({ syncMemoryNotes }) => syncMemoryNotes(projectCtx?.name || '', [])).catch(() => {});
        ctx.app.notify(`Cleared ${count} memory note${count !== 1 ? 's' : ''}.`);
        break;
      }

      // Default: add note
      const note = args.join(' ').trim();
      if (!note) {
        ctx.app.notify('Usage: /memory <note> · /memory list · /memory remove <n> · /memory clear');
        break;
      }
      intelligence.notes.push(note);
      saveProjectIntelligence(projectRoot, intelligence);
      import('../utils/codeepCloud.js').then(({ syncMemoryNotes }) => syncMemoryNotes(projectCtx?.name || '', intelligence.notes)).catch(() => {});
      ctx.app.notify(`Memory saved (${intelligence.notes.length} total): "${note}"`);
      break;
    }

    case 'commands': {
      const { loadCustomCommands, formatCommandList } = await import('../utils/customCommands');
      ctx.app.addMessage({ role: 'system', content: formatCommandList(loadCustomCommands(ctx.projectPath)) });
      break;
    }

    case 'web-cache': {
      const sub = args[0]?.toLowerCase();
      const { clearWebCache, webCacheStats } = await import('../utils/webFetch');
      if (sub === 'clear' || sub === 'reset' || sub === 'flush') {
        clearWebCache();
        ctx.app.notify('Web cache cleared');
      } else {
        const stats = webCacheStats();
        ctx.app.addMessage({
          role: 'system',
          content: [
            '🌐 Web fetch cache',
            '',
            `  Entries: ${stats.entries}/${stats.maxEntries}`,
            `  TTL:     ${stats.ttlMinutes} min`,
            '',
            'Usage: /web-cache clear',
          ].join('\n'),
        });
      }
      break;
    }

    case 'mcp': {
      // Mirrors the ACP `/mcp` handler in src/acp/commands.ts. In TUI the
      // session id is the constant `codeep-tui` (the same one main.ts uses
      // when it spawns project MCP servers in the background) and the
      // workspace root is ctx.projectPath. Without a project we can still
      // browse the marketplace, but anything that mutates project config
      // refuses with a clear message.
      const sub = args[0]?.toLowerCase();
      const TUI_SESSION = 'codeep-tui';
      const projectPath = ctx.projectPath;

      const requireProject = (): boolean => {
        if (!projectPath) {
          ctx.app.notify('Open a project (cd into it before running codeep) to add or modify MCP servers.');
          return false;
        }
        return true;
      };

      const { addProjectMcpServer, removeProjectMcpServer, loadMcpServerConfig, loadMcpServerConfigSplit, isWorkspaceMcpTrusted, trustWorkspaceMcp, untrustWorkspaceMcp } = await import('../utils/mcpConfig');
      const { registerSessionServers } = await import('../utils/mcpRegistry');

      if (sub === 'trust') {
        if (!requireProject()) break;
        if (isWorkspaceMcpTrusted(projectPath!)) {
          ctx.app.notify('Workspace MCP servers are already trusted here.');
          break;
        }
        trustWorkspaceMcp(projectPath!);
        const { workspace } = loadMcpServerConfigSplit(projectPath!);
        if (workspace.length === 0) {
          ctx.app.notify('Workspace trusted — no workspace MCP servers defined yet.');
          break;
        }
        ctx.app.notify(`Workspace trusted. Spawning ${workspace.length} MCP server(s)…`);
        const { registered, errors } = await registerSessionServers(TUI_SESSION, workspace, { workspaceRoot: projectPath });
        if (registered.length > 0) ctx.app.notify(`MCP: ${registered.length} tool(s) ready. Type /mcp.`);
        for (const e of errors) ctx.app.notifyWarn(`MCP server "${e.server}" failed: ${e.error}`);
        break;
      }

      if (sub === 'untrust') {
        if (!requireProject()) break;
        untrustWorkspaceMcp(projectPath!);
        ctx.app.notify('Workspace MCP trust revoked — workspace servers won\'t spawn on next start. (Running servers stop when you exit.)');
        break;
      }

      if (sub === 'add') {
        if (!requireProject()) break;
        const name = args[1];
        const command = args[2];
        if (!name || !command) {
          ctx.app.addMessage({ role: 'system', content: 'Usage: `/mcp add <name> <command> [args...]` — e.g. `/mcp add fs npx @modelcontextprotocol/server-filesystem /path`' });
          break;
        }
        const extraArgs = args.slice(3);
        addProjectMcpServer(projectPath!, { name, command, args: extraArgs });
        ctx.app.notify(`Saved MCP server ${name} to .codeep/mcp_servers.json. Spawning…`);
        const merged = loadMcpServerConfig(projectPath!);
        const { registered, errors } = await registerSessionServers(TUI_SESSION, merged, { workspaceRoot: projectPath });
        const ok = registered.filter(t => t.serverName === name);
        const failed = errors.find(e => e.server === name);
        ctx.app.addMessage({
          role: 'system',
          content: failed
            ? `Saved \`${name}\` but spawn failed: \`${failed.error}\``
            : `Added \`${name}\` (${ok.length} tool${ok.length === 1 ? '' : 's'} available).`,
        });
        break;
      }

      if (sub === 'remove') {
        if (!requireProject()) break;
        const name = args[1];
        if (!name) { ctx.app.addMessage({ role: 'system', content: 'Usage: `/mcp remove <name>`' }); break; }
        const removed = removeProjectMcpServer(projectPath!, name);
        if (!removed) {
          ctx.app.addMessage({ role: 'system', content: `No project-scoped MCP server named \`${name}\`.` });
          break;
        }
        const merged = loadMcpServerConfig(projectPath!);
        await registerSessionServers(TUI_SESSION, merged, { workspaceRoot: projectPath });
        ctx.app.addMessage({ role: 'system', content: `Removed \`${name}\` from project config and stopped its process.` });
        break;
      }

      if (sub === 'browse') {
        const { formatMarketplaceList, findMarketplaceEntry, formatMarketplaceEntry, MCP_MARKETPLACE } = await import('../utils/mcpMarketplace');
        const detail = args[1];
        if (detail) {
          const entry = findMarketplaceEntry(detail);
          if (!entry) {
            ctx.app.addMessage({ role: 'system', content: `Marketplace id not found: \`${detail}\`. Run \`/mcp browse\` for the list.` });
          } else {
            const argHints = entry.argHints?.map(h => `<${h.placeholder ?? 'arg'}>`).join(' ') ?? '';
            ctx.app.addMessage({ role: 'system', content: formatMarketplaceEntry(entry) + `\n\nInstall with \`/mcp install ${entry.id} ${argHints}\`` });
          }
          break;
        }
        ctx.app.addMessage({ role: 'system', content: formatMarketplaceList() + `\n\nRun \`/mcp browse <id>\` for details or \`/mcp install <id> [args]\` to install. Total: ${MCP_MARKETPLACE.length}.` });
        break;
      }

      if (sub === 'install') {
        if (!requireProject()) break;
        const id = args[1];
        if (!id) {
          ctx.app.addMessage({ role: 'system', content: 'Usage: `/mcp install <id> [extra args...]` — run `/mcp browse` to see ids.' });
          break;
        }
        const { findMarketplaceEntry } = await import('../utils/mcpMarketplace');
        const entry = findMarketplaceEntry(id);
        if (!entry) {
          ctx.app.addMessage({ role: 'system', content: `Marketplace id not found: \`${id}\`. Run \`/mcp browse\` for the list.` });
          break;
        }
        const extraArgs = args.slice(2);
        const fullArgs = [...(entry.server.args ?? []), ...extraArgs];
        addProjectMcpServer(projectPath!, {
          name: entry.id,
          command: entry.server.command,
          args: fullArgs,
          env: entry.server.env,
          url: entry.server.url,
          headers: entry.server.headers,
        });
        ctx.app.notify(`Saved ${entry.id} to project config. Spawning…`);
        const merged = loadMcpServerConfig(projectPath!);
        const { registered, errors } = await registerSessionServers(TUI_SESSION, merged, { workspaceRoot: projectPath });
        const failed = errors.find(e => e.server === entry.id);
        const lines: string[] = [];
        if (failed) {
          lines.push(`Saved \`${entry.id}\` but spawn failed: \`${failed.error}\``);
        } else {
          const ok = registered.filter(t => t.serverName === entry.id);
          lines.push(`Installed **${entry.name}** (\`${entry.id}\`) — ${ok.length} tool${ok.length === 1 ? '' : 's'} available.`);
        }
        if (entry.envNotes?.length) {
          lines.push('', '**Environment variables you may need:**');
          for (const e of entry.envNotes) {
            const req = e.required ? ' (required)' : '';
            lines.push(`- \`${e.name}\`${req} — ${e.description}`);
          }
        }
        ctx.app.addMessage({ role: 'system', content: lines.join('\n') });
        break;
      }

      if (sub === 'reload') {
        if (!requireProject()) break;
        ctx.app.notify('Reloading MCP server config…');
        const merged = loadMcpServerConfig(projectPath!);
        const { registered, errors } = await registerSessionServers(TUI_SESSION, merged, { workspaceRoot: projectPath });
        ctx.app.addMessage({ role: 'system', content: formatMcpReloadReport(registered.length, merged.length, errors) });
        break;
      }

      if (sub === 'resources') {
        const { getSessionResources, awaitSessionReady } = await import('../utils/mcpRegistry');
        await awaitSessionReady(TUI_SESSION);
        const groups = await getSessionResources(TUI_SESSION);
        ctx.app.addMessage({ role: 'system', content: formatMcpResourcesList(groups) });
        break;
      }

      if (sub === 'read') {
        const uri = args[1];
        if (!uri) { ctx.app.addMessage({ role: 'system', content: 'Usage: `/mcp read <uri>` — run `/mcp resources` to see available URIs.' }); break; }
        const { readSessionResource } = await import('../utils/mcpRegistry');
        try {
          const contents = await readSessionResource(TUI_SESSION, uri);
          ctx.app.addMessage({ role: 'system', content: formatMcpResourceRead(uri, contents) });
        } catch (err) {
          ctx.app.addMessage({ role: 'system', content: `Failed to read \`${uri}\`: ${(err as Error).message}` });
        }
        break;
      }

      if (sub === 'prompts') {
        const { getSessionPrompts, awaitSessionReady } = await import('../utils/mcpRegistry');
        await awaitSessionReady(TUI_SESSION);
        const groups = await getSessionPrompts(TUI_SESSION);
        ctx.app.addMessage({ role: 'system', content: formatMcpPromptsList(groups) });
        break;
      }

      if (sub === 'prompt') {
        const serverName = args[1];
        const name = args[2];
        if (!serverName || !name) {
          ctx.app.addMessage({ role: 'system', content: 'Usage: `/mcp prompt <server> <name> [key=value ...]`' });
          break;
        }
        const promptArgs = parsePromptArgs(args.slice(3));
        const { getSessionPrompt } = await import('../utils/mcpRegistry');
        try {
          const { description, messages } = await getSessionPrompt(TUI_SESSION, serverName, name, promptArgs);
          ctx.app.addMessage({ role: 'system', content: formatMcpPromptResult(serverName, name, description, messages) });
        } catch (err) {
          ctx.app.addMessage({ role: 'system', content: `Failed to materialise prompt: ${(err as Error).message}` });
        }
        break;
      }

      // Default: list servers + tools for the current session.
      const { getSessionTools, getSessionRegistrationErrors, awaitSessionReady } = await import('../utils/mcpRegistry');
      await awaitSessionReady(TUI_SESSION);
      const tools = await getSessionTools(TUI_SESSION);
      const mcpErrors = getSessionRegistrationErrors(TUI_SESSION);
      ctx.app.addMessage({ role: 'system', content: formatMcpServerList(tools, mcpErrors) });
      break;
    }

    default: {
      // 1. Try custom user command (project + global Markdown templates).
      const { findCustomCommand, expandCommand } = await import('../utils/customCommands');
      const custom = findCustomCommand(command, ctx.projectPath);
      if (custom) {
        const expandedPrompt = expandCommand(custom, args);
        ctx.app.notify(`Running custom command /${command} (${custom.scope})`);
        ctx.app.addMessage({ role: 'user', content: expandedPrompt });
        const { runAgentTask } = await import('./agentExecution');
        runAgentTask(expandedPrompt, false, ctx, () => null, () => {});
        break;
      }
      // 2. Fall through to skill registry.
      runSkill(command, args, ctx).then(handled => {
        if (!handled) ctx.app.notify(`Unknown command: /${command}`);
      });
    }
  }
}
