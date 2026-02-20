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
  saveSession,
  startNewSession,
  loadSession,
  listSessionsWithInfo,
  deleteSession,
  renameSession,
  setProjectPermission,
} from '../config/index';
import { getProjectContext } from '../utils/project';
import { getCurrentVersion } from '../utils/update';
import { getProviderList, getProvider } from '../config/providers';
import { setProjectContext } from '../api/index';
import { AppExecutionContext, runSkill, runCommandChain } from './agentExecution';

// ─── Extended context for command handlers ────────────────────────────────────

export interface AppCommandContext extends AppExecutionContext {
  sessionId: string;
  setSessionId: (id: string) => void;
  setProjectContext: (ctx: ReturnType<typeof getProjectContext>) => void;
  setHasWriteAccess: (v: boolean) => void;
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

export async function handleCommand(
  command: string,
  args: string[],
  ctx: AppCommandContext,
): Promise<void> {
  // Handle skill chaining (e.g., /commit+push)
  if (command.includes('+')) {
    const commands = command.split('+').filter(c => c.trim());
    runCommandChain(commands, 0, ctx);
    return;
  }

  switch (command) {
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
      ctx.app.showList('Load Session', sessions.map(s => s.name), (index) => {
        const selected = sessions[index];
        const loaded = loadSession(selected.name, ctx.projectPath);
        if (loaded) {
          ctx.app.setMessages(loaded as Message[]);
          ctx.setSessionId(selected.name);
          ctx.app.notify(`Loaded: ${selected.name}`);
        } else {
          ctx.app.notify('Failed to load session');
        }
      });
      break;
    }

    case 'new': {
      ctx.app.clearMessages();
      ctx.setSessionId(startNewSession());
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
      import('../utils/codeReview').then(({ performCodeReview, formatReviewResult }) => {
        const reviewFiles = args.length > 0 ? args : undefined;
        const result = performCodeReview(ctx.projectContext!, reviewFiles);
        ctx.app.addMessage({ role: 'assistant', content: formatReviewResult(result) });
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
      const newName = args.join('-');
      const messages = ctx.app.getMessages();
      if (messages.length === 0) { ctx.app.notify('No messages to save. Start a conversation first.'); return; }
      saveSession(ctx.sessionId, messages, ctx.projectPath);
      if (renameSession(ctx.sessionId, newName, ctx.projectPath)) {
        ctx.setSessionId(newName);
        ctx.app.notify(`Session renamed to: ${newName}`);
      } else {
        ctx.app.notify('Failed to rename session');
      }
      break;
    }

    case 'search': {
      if (!args.length) { ctx.app.notify('Usage: /search <term>'); return; }
      const searchTerm = args.join(' ').toLowerCase();
      const messages = ctx.app.getMessages();
      const searchResults: Array<{ role: string; messageIndex: number; matchedText: string }> = [];
      messages.forEach((m, index) => {
        if (m.content.toLowerCase().includes(searchTerm)) {
          const lowerContent = m.content.toLowerCase();
          const matchStart = Math.max(0, lowerContent.indexOf(searchTerm) - 30);
          const matchEnd = Math.min(m.content.length, lowerContent.indexOf(searchTerm) + searchTerm.length + 50);
          const matchedText = (matchStart > 0 ? '...' : '') +
            m.content.slice(matchStart, matchEnd).replace(/\n/g, ' ') +
            (matchEnd < m.content.length ? '...' : '');
          searchResults.push({ role: m.role, messageIndex: index, matchedText });
        }
      });
      if (searchResults.length === 0) {
        ctx.app.notify(`No matches for "${searchTerm}"`);
      } else {
        ctx.app.showSearch(searchTerm, searchResults, (messageIndex) => ctx.app.scrollToMessage(messageIndex));
      }
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
      ctx.app.showLogin(providers.map(p => ({ id: p.id, name: p.name, subscribeUrl: p.subscribeUrl })), async (result) => {
        if (result) {
          setProvider(result.providerId);
          await setApiKey(result.apiKey);
          ctx.app.notify('Logged in successfully');
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
          for (const p of configuredProviders) clearApiKey(p.id);
          ctx.app.notify('Logged out from all providers. Use /login to sign in.');
        } else {
          clearApiKey(result);
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
      const codeBlocks: string[] = [];
      for (const msg of messages) {
        for (const match of msg.content.matchAll(/```[\w]*\n([\s\S]*?)```/g)) {
          codeBlocks.push(match[1]);
        }
      }
      if (codeBlocks.length === 0) { ctx.app.notify('No code blocks found'); return; }
      const index = blockNum === -1 ? codeBlocks.length - 1 : blockNum - 1;
      if (index < 0 || index >= codeBlocks.length) {
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
      const changes: Array<{ path: string; content: string }> = [];
      const fenceFilePattern = /```\w*\s+([\w./\\-]+(?:\.\w+))\n([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      while ((match = fenceFilePattern.exec(lastAssistant.content)) !== null) {
        const p = match[1].trim();
        if (p.includes('.') && !p.includes(' ')) changes.push({ path: p, content: match[2] });
      }
      if (changes.length === 0) {
        const commentPattern = /```(\w+)?\s*\n(?:\/\/|#|--|\/\*)\s*(?:File|Path|file|path):\s*([^\n*]+)\n([\s\S]*?)```/g;
        while ((match = commentPattern.exec(lastAssistant.content)) !== null) {
          changes.push({ path: match[2].trim(), content: match[3] });
        }
      }
      if (changes.length === 0) { ctx.app.notify('No file changes found in response'); return; }
      if (!ctx.hasWriteAccess) { ctx.app.notify('Write access required. Use /grant first.'); return; }
      import('fs').then(async (fs) => {
        import('path').then(async (pathModule) => {
          const diffLines: string[] = [];
          for (const change of changes) {
            const fullPath = pathModule.isAbsolute(change.path)
              ? change.path
              : pathModule.join(ctx.projectPath, change.path);
            const shortPath = change.path.length > 40 ? '...' + change.path.slice(-37) : change.path;
            let existingContent = '';
            try { existingContent = await fs.promises.readFile(fullPath, 'utf-8'); } catch {}
            if (!existingContent) {
              diffLines.push(`+ CREATE: ${shortPath}`);
              diffLines.push(`  (${change.content.split('\n').length} lines)`);
            } else {
              const oldLines = existingContent.split('\n').length;
              const newLines = change.content.split('\n').length;
              const lineDiff = newLines - oldLines;
              diffLines.push(`~ MODIFY: ${shortPath}`);
              diffLines.push(`  ${oldLines} → ${newLines} lines (${lineDiff >= 0 ? '+' : ''}${lineDiff})`);
            }
          }
          ctx.app.showConfirm({
            title: '📝 Apply Changes',
            message: [
              `Found ${changes.length} file(s) to apply:`,
              '',
              ...diffLines.slice(0, 10),
              ...(diffLines.length > 10 ? [`  ...and ${diffLines.length - 10} more`] : []),
              '',
              'Apply these changes?',
            ],
            confirmLabel: 'Apply',
            cancelLabel: 'Cancel',
            onConfirm: () => {
              (async () => {
                let applied = 0;
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
                ctx.app.notify(`Applied ${applied}/${changes.length} file(s)`);
              })();
            },
            onCancel: () => ctx.app.notify('Apply cancelled'),
          });
        });
      });
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
    case 'd':
    case 'docs':
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

    default:
      runSkill(command, args, ctx).then(handled => {
        if (!handled) ctx.app.notify(`Unknown command: /${command}`);
      });
  }
}
