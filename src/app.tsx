import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import clipboardy from 'clipboardy';
import { logger } from './utils/logger';
import { Logo, IntroAnimation } from './components/Logo';
import { Loading } from './components/Loading';
import { MessageView, getCodeBlock, clearCodeBlocks } from './components/Message';
import { ChatInput } from './components/Input';
import { Help } from './components/Help';
import { Status } from './components/Status';
import { Login } from './components/Login';
import { Sessions } from './components/Sessions';
import { SessionPicker } from './components/SessionPicker';
import { LogoutPicker } from './components/LogoutPicker';
import { Settings } from './components/Settings';
import { ProjectPermission } from './components/ProjectPermission';
import { Search } from './components/Search';
import { Export } from './components/Export';
import { MessageList } from './components/MessageList';
import { chat } from './api/index';
import { 
  Message, 
  config, 
  isConfigured,
  isConfiguredAsync,
  loadApiKey,
  loadAllApiKeys,
  setApiKey,
  PROTOCOLS,
  LANGUAGES,
  LanguageCode,
  autoSaveSession,
  startNewSession,
  getCurrentSessionId,
  loadSession,
  renameSession,
  deleteSession,
  hasReadPermission,
  hasWritePermission,
  setProjectPermission,
  setProvider,
  getCurrentProvider,
  getModelsForCurrentProvider,
  PROVIDERS
} from './config/index';
import { getProviderList } from './config/providers';
import { 
  isProjectDirectory, 
  getProjectContext, 
  detectFilePaths, 
  readProjectFile,
  parseFileChanges,
  writeProjectFile,
  deleteProjectFile,
  getProjectTip,
  ProjectContext
} from './utils/project';
import { logStartup, logAppError, setLogProjectPath } from './utils/logger';
import { searchMessages, SearchResult } from './utils/search';
import { exportMessages, saveExport, ExportFormat } from './utils/export';
import { checkForUpdates, formatVersionInfo, getCurrentVersion, VersionInfo } from './utils/update';
import { getGitDiff, getGitStatus, getChangedFiles, suggestCommitMessage, createCommit, formatDiffForDisplay } from './utils/git';
import { validateInput } from './utils/validation';
import { checkApiRateLimit, checkCommandRateLimit } from './utils/ratelimit';
import { runAgent, formatAgentResult, AgentResult, undoLastAction, undoAllActions, getRecentSessions } from './utils/agent';
import { autoCommitAgentChanges } from './utils/git';
import { saveContext, loadContext, clearContext, mergeContext } from './utils/context';
import { performCodeReview, formatReviewResult } from './utils/codeReview';
import { loadProjectPreferences, learnFromProject, formatPreferencesForPrompt, addCustomRule, getLearningStatus } from './utils/learning';
import { getAllSkills, findSkill, formatSkillsList, formatSkillHelp, generateSkillPrompt, saveCustomSkill, deleteCustomSkill, parseSkillDefinition, parseSkillChain, parseSkillArgs, searchSkills, trackSkillUsage, getSkillStats, Skill } from './utils/skills';
import { ChangesList, AgentStatusBar } from './components/AgentProgress';
import { ActionLog, ToolCall, ToolResult, createActionLog } from './utils/tools';
import { scanProject, saveProjectIntelligence, loadProjectIntelligence, generateContextFromIntelligence, isIntelligenceFresh, ProjectIntelligence } from './utils/projectIntelligence';

type Screen = 'chat' | 'login' | 'help' | 'status' | 'sessions' | 'sessions-delete' | 'model' | 'protocol' | 'language' | 'settings' | 'permission' | 'provider' | 'search' | 'export' | 'session-picker' | 'logout';
export const App: React.FC = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  
  // Start with 'chat' screen, will switch to login if needed after loading API key
  const [screen, setScreen] = useState<Screen>('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [notification, setNotification] = useState('');
  const [notificationDuration, setNotificationDuration] = useState(3000);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [sessionId, setSessionId] = useState(getCurrentSessionId());
  const [showIntro, setShowIntro] = useState(true);
  const [clearInputTrigger, setClearInputTrigger] = useState(0);

  // Project context
  const [projectPath] = useState(process.cwd());
  
  // Log application startup and set project path for logging
  useEffect(() => {
    logStartup('1.0.0');
    setLogProjectPath(projectPath);
  }, [projectPath]);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [hasProjectAccess, setHasProjectAccess] = useState(false);
  const [hasWriteAccess, setHasWriteAccess] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [isInProject, setIsInProject] = useState(false);

  // Load previous session on startup (after intro)
  const [sessionLoaded, setSessionLoaded] = useState(false);


  // Search state
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('md');
  
  // Removed pagination state - terminal handles scrolling natively
  
  // Update check state
  const [updateInfo, setUpdateInfo] = useState<VersionInfo | null>(null);
  
  // File changes prompt state
  const [pendingFileChanges, setPendingFileChanges] = useState<Array<{ path: string; content: string; action?: 'create' | 'edit' | 'delete' }>>([]);
  
  // Agent mode state
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [agentIteration, setAgentIteration] = useState(0);
  const [agentActions, setAgentActions] = useState<ActionLog[]>([]);
  const [agentThinking, setAgentThinking] = useState('');
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentDryRun, setAgentDryRun] = useState(false);
  const [agentStreamingContent, setAgentStreamingContent] = useState(''); // Live action log in chat
  
  // Load API keys for ALL providers on startup and check if current provider is configured
  useEffect(() => {
    loadAllApiKeys().then(() => {
      // After loading all keys, check if current provider has an API key
      return loadApiKey();
    }).then(key => {
      if (!key || key.length === 0) {
        setScreen('login');
      }
      // else: stay on chat screen (default)
    }).catch(() => {
      setScreen('login');
    });
  }, []);
  
  // Check folder permission after intro
  useEffect(() => {
    if (!showIntro && !permissionChecked && screen !== 'login') {
      const isProject = isProjectDirectory(projectPath);
      setIsInProject(isProject);
      
      const hasRead = hasReadPermission(projectPath);
      if (hasRead) {
        // Already has permission, load context
        setHasProjectAccess(true);
        const hasWrite = hasWritePermission(projectPath);
        setHasWriteAccess(hasWrite);
        
        const ctx = getProjectContext(projectPath);
        if (ctx) {
          ctx.hasWriteAccess = hasWrite;
        }
        setProjectContext(ctx);
        setPermissionChecked(true);
        
        // Warn user if Agent Mode is ON but only read permission exists
        const agentMode = config.get('agentMode');
        if (agentMode === 'on' && !hasWrite) {
          setTimeout(() => {
            setNotificationDuration(8000);
            setNotification('⚠️  Agent Mode ON: Needs write permission. Use /grant to enable or /agent for manual mode.');
          }, 500);
        }
      } else {
        // Need to ask for permission
        setScreen('permission');
        setPermissionChecked(true);
      }
    }
  }, [showIntro, permissionChecked, projectPath, screen]);

  // Show session picker after permission is handled (instead of auto-loading)
  useEffect(() => {
    if (!showIntro && permissionChecked && !sessionLoaded && screen !== 'permission' && screen !== 'login') {
      // If we already have messages (e.g., from a previous action), skip picker
      if (messages.length > 0) {
        setSessionLoaded(true);
        return;
      }
      
      // Show session picker instead of auto-loading
      setScreen('session-picker');
    }
  }, [showIntro, permissionChecked, sessionLoaded, screen, messages.length]);

  // Check for updates on startup (once per session, after intro)
  useEffect(() => {
    if (!showIntro && sessionLoaded && !updateInfo) {
      checkForUpdates()
        .then((info) => {
          setUpdateInfo(info);
          if (info.hasUpdate) {
            setNotification(`Update available: ${info.current} → ${info.latest}. Type /update for info.`);
          }
        })
        .catch(() => {
          // Silent fail - update check is non-critical
        });
    }
  }, [showIntro, sessionLoaded, updateInfo]);

  // Clear notification after delay
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(''), notificationDuration);
      return () => clearTimeout(timer);
    }
  }, [notification, notificationDuration]);


  // Handle keyboard shortcuts
  useInput((input, key) => {
    // Ctrl+L to clear chat (F5 doesn't work reliably in all terminals)
    if (key.ctrl && input === 'l') {
      if (!isLoading && screen === 'chat') {
        // Clear terminal screen
        stdout?.write('\x1b[2J\x1b[H');
        setMessages([]);
        clearCodeBlocks();
        setAgentResult(null);
        setAgentActions([]);
        const newSessId = startNewSession();
        setSessionId(newSessId);
        setClearInputTrigger(prev => prev + 1); // Trigger input clear
        notify('Chat cleared, new session started');
      }
      return; // Prevent further processing
    }
    
    // Escape to cancel agent or request
    if (key.escape && isAgentRunning) {
      abortController?.abort();
      return;
    }
    
    // Escape to cancel request
    if (key.escape && isLoading) {
      abortController?.abort();
      setIsLoading(false);
      setAbortController(null);
      setClearInputTrigger(prev => prev + 1); // Clear input after cancel
      
      // Save partial response if there is any
      if (streamingContent && streamingContent.trim().length > 0) {
        const partialMessage: Message = {
          role: 'assistant',
          content: streamingContent.trim() + '\n\n*(Response cancelled - partial)*',
        };
        setMessages(prev => [...prev, partialMessage]);
        setStreamingContent('');
        notify('Request cancelled - partial response saved');
      } else {
        // No content yet, remove the user message
        setMessages(prev => prev.slice(0, -1));
        setStreamingContent('');
        notify('Request cancelled');
      }
    }
    
    // Escape to close modals
    if (key.escape && screen !== 'chat' && screen !== 'login') {
      setScreen('chat');
    }
    
    // Handle file changes prompt (Y/n)
    if (pendingFileChanges.length > 0 && !isLoading) {
      if (input.toLowerCase() === 'y' || key.return) {
        // Apply changes
        let applied = 0;
        for (const change of pendingFileChanges) {
          let result;
          if (change.action === 'delete') {
            result = deleteProjectFile(change.path);
          } else {
            result = writeProjectFile(change.path, change.content);
          }
          
          if (result.success) {
            applied++;
          } else {
            notify(`Error: ${result.error || 'Failed to apply change'}`);
          }
        }
        notify(`Applied ${applied}/${pendingFileChanges.length} file change(s)`);
        setPendingFileChanges([]);
        return;
      }
      if (input.toLowerCase() === 'n' || key.escape) {
        // Reject changes
        notify('File changes rejected');
        setPendingFileChanges([]);
        return;
      }
    }
  });

  const notify = useCallback((msg: string, duration: number = 3000) => {
    setNotificationDuration(duration);
    setNotification(msg);
  }, []);

  // Start agent execution
  const startAgent = useCallback(async (prompt: string, dryRun: boolean = false) => {
    if (!projectContext) {
      notify('Agent mode requires project context. Run in a project directory.');
      return;
    }
    
    if (!hasWriteAccess && !dryRun) {
      notify('Agent mode requires write access. Grant permission first or use /agent-dry');
      return;
    }
    
    // Reset agent state
    setIsAgentRunning(true);
    setAgentIteration(0);
    setAgentActions([]);
    setAgentThinking('');
    setAgentResult(null);
    setAgentDryRun(dryRun);
    setAgentStreamingContent(''); // Reset streaming content
    
    // Add user message
    const userMessage: Message = { 
      role: 'user', 
      content: dryRun ? `[DRY RUN] ${prompt}` : `[AGENT] ${prompt}` 
    };
    setMessages(prev => [...prev, userMessage]);
    
    const controller = new AbortController();
    setAbortController(controller);
    
    try {
      const result = await runAgent(prompt, projectContext, {
        // Use config values - no hardcoded limits
        dryRun,
        onIteration: (iteration, message) => {
          setAgentIteration(iteration);
        },
        onToolCall: (tool: ToolCall) => {
          // Create action log with content for live code preview
          // For write/edit actions, include content immediately so it shows while agent works
          const toolName = tool.tool.toLowerCase().replace(/-/g, '_');
          let details: string | undefined;
          
          if (toolName === 'write_file' && tool.parameters.content) {
            details = tool.parameters.content as string;
          } else if (toolName === 'edit_file' && tool.parameters.new_text) {
            details = tool.parameters.new_text as string;
          }
          
          const actionLog: ActionLog = {
            type: toolName === 'write_file' ? 'write' : 
                  toolName === 'edit_file' ? 'edit' : 
                  toolName === 'read_file' ? 'read' :
                  toolName === 'delete_file' ? 'delete' :
                  toolName === 'execute_command' ? 'command' :
                  toolName === 'search_code' ? 'search' :
                  toolName === 'list_files' ? 'list' :
                  toolName === 'create_directory' ? 'mkdir' :
                  toolName === 'fetch_url' ? 'fetch' : 'command',
            target: (tool.parameters.path as string) || 
                    (tool.parameters.command as string) ||
                    (tool.parameters.pattern as string) ||
                    (tool.parameters.url as string) || 'unknown',
            result: 'success', // Will be updated by onToolResult
            details,
            timestamp: Date.now(),
          };
          setAgentActions(prev => [...prev, actionLog]);
        },
        onToolResult: (result: ToolResult, toolCall: ToolCall) => {
          // Replace the last action with the complete one
          const actionLog = createActionLog(toolCall, result);
          setAgentActions(prev => {
            const updated = [...prev];
            if (updated.length > 0) {
              updated[updated.length - 1] = actionLog;
            }
            return updated;
          });
          
          // Add formatted action to streaming content (stays in chat)
          // NO CODE DISPLAY - just clean action lines to prevent terminal jumping
          const actionType = actionLog.type;
          const target = actionLog.target.split('/').pop() || actionLog.target; // Just filename
          const status = actionLog.result === 'success' ? '✓' : '✗';
          const failedText = actionLog.result === 'error' ? ' ✗' : '';
          
          // Count lines in content
          const lineCount = actionLog.details ? actionLog.details.split('\n').length : 0;
          
          let actionLine = '';
          if (actionType === 'write') {
            actionLine = `${status} Created **${target}**${lineCount > 0 ? ` (${lineCount} lines)` : ''}${failedText}`;
          } else if (actionType === 'edit') {
            actionLine = `${status} Edited **${target}**${lineCount > 0 ? ` (${lineCount} lines)` : ''}${failedText}`;
          } else if (actionType === 'read') {
            actionLine = `→ Reading **${target}**`;
          } else if (actionType === 'delete') {
            actionLine = `${status} Deleted **${target}**${failedText}`;
          } else if (actionType === 'command') {
            const cmd = actionLog.target.length > 40 ? actionLog.target.slice(0, 40) + '...' : actionLog.target;
            actionLine = `${status} Ran \`${cmd}\`${failedText}`;
          } else if (actionType === 'search') {
            actionLine = `→ Searching **${target}**`;
          } else if (actionType === 'mkdir') {
            actionLine = `${status} Created dir **${target}**`;
          } else if (actionType === 'fetch') {
            actionLine = `→ Fetching **${target}**`;
          } else if (actionType === 'list') {
            actionLine = `→ Listing **${target}**`;
          }
          
          if (actionLine) {
            setAgentStreamingContent(prev => prev + (prev ? '\n' : '') + actionLine);
          }
        },
        onThinking: (text: string) => {
          // Strip <think> and <tool_call> tags from thinking text
          const cleanText = text
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
            .replace(/<toolcall>[\s\S]*?<\/toolcall>/gi, '')
            .trim();
          if (cleanText) {
            setAgentThinking(prev => prev + cleanText);
          }
        },
        abortSignal: controller.signal,
      });
      
      setAgentResult(result);
      
      // Build action statistics
      const stats = {
        created: result.actions.filter(a => a.type === 'write' && a.result === 'success').length,
        edited: result.actions.filter(a => a.type === 'edit' && a.result === 'success').length,
        deleted: result.actions.filter(a => a.type === 'delete' && a.result === 'success').length,
        commands: result.actions.filter(a => a.type === 'command' && a.result === 'success').length,
        reads: result.actions.filter(a => a.type === 'read').length,
        errors: result.actions.filter(a => a.result === 'error').length,
      };
      
      // Format statistics line
      const statParts: string[] = [];
      if (stats.created > 0) statParts.push(`+${stats.created} created`);
      if (stats.edited > 0) statParts.push(`~${stats.edited} edited`);
      if (stats.deleted > 0) statParts.push(`-${stats.deleted} deleted`);
      if (stats.commands > 0) statParts.push(`${stats.commands} commands`);
      if (stats.errors > 0) statParts.push(`${stats.errors} errors`);
      
      const statsLine = statParts.length > 0 
        ? `\n\n---\n**${result.iterations} steps** | ${statParts.join(' | ')}`
        : '';
      
      // Add agent summary as assistant message with stats
      const summaryMessage: Message = {
        role: 'assistant',
        content: (result.finalResponse || formatAgentResult(result)) + statsLine,
      };
      setMessages(prev => [...prev, summaryMessage]);
      
      // Auto-save session
      autoSaveSession([...messages, userMessage, summaryMessage], projectPath);
      
      if (result.success) {
        notify(`Agent completed: ${result.actions.length} action(s)`);
      } else if (result.aborted) {
        notify('Agent stopped by user');
      } else {
        notify(`Agent failed: ${result.error}`);
      }
    } catch (error) {
      const err = error as Error;
      notify(`Agent error: ${err.message}`);
    } finally {
      setIsAgentRunning(false);
      setAbortController(null);
      setAgentThinking('');
    }
  }, [projectContext, hasWriteAccess, messages, projectPath, notify]);

  const handleSubmit = async (input: string) => {
    logger.debug(`[handleSubmit] Called with input, current messages.length: ${messages.length}`);
    
    // Clear previous agent result when user sends new message
    if (agentResult) {
      setAgentResult(null);
      setAgentActions([]);
    }
    
    // Validate input
    const validation = validateInput(input);
    if (!validation.valid) {
      notify(`Invalid input: ${validation.error}`);
      return;
    }
    
    // Use sanitized input
    const sanitizedInput = validation.sanitized || input;
    
    // Add to input history (limit to last 100 entries to prevent memory leak)
    const MAX_HISTORY = 100;
    setInputHistory(h => [...h.slice(-(MAX_HISTORY - 1)), sanitizedInput]);
    
    // Check for commands
    if (sanitizedInput.startsWith('/')) {
      // Rate limit commands
      const commandLimit = checkCommandRateLimit();
      if (!commandLimit.allowed) {
        notify(commandLimit.message || 'Too many commands');
        return;
      }
      
      handleCommand(sanitizedInput);
      return;
    }
    
    // Rate limit API calls
    const apiLimit = checkApiRateLimit();
    if (!apiLimit.allowed) {
      notify(apiLimit.message || 'Rate limit exceeded');
      return;
    }

    // Auto-agent mode: if enabled and we have write access, use agent
    const agentMode = config.get('agentMode');
    logger.debug(`[handleSubmit] agentMode=${agentMode}, hasWriteAccess=${hasWriteAccess}, hasProjectContext=${!!projectContext}, isInProject=${isInProject}`);
    if (agentMode === 'on') {
      if (!hasWriteAccess) {
        notify('⚠️  Agent Mode ON: Needs write permission. Use /grant to enable.', 8000);
      } else if (!projectContext) {
        notify('⚠️  Agent Mode ON: Needs permission. Use /grant to allow folder access.', 8000);
      } else {
        notify('✓ Using agent mode (change in /settings)');
        startAgent(sanitizedInput, false);
        return;
      }
    }

    // Auto-detect file paths and enrich message
    let enrichedInput = sanitizedInput;
    if (hasProjectAccess) {
      const detectedPaths = detectFilePaths(sanitizedInput, projectPath);
      
      if (detectedPaths.length > 0) {
        const fileContents: string[] = [];
        
        for (const filePath of detectedPaths) {
          const file = readProjectFile(filePath);
          if (file) {
            const ext = filePath.split('.').pop() || '';
            fileContents.push(`\n\n--- File: ${filePath} ---\n\`\`\`${ext}\n${file.content}\n\`\`\``);
            if (file.truncated) {
              notify(`Note: ${filePath} was truncated (too large)`);
            }
          }
        }
        
        if (fileContents.length > 0) {
          enrichedInput = input + fileContents.join('');
          notify(`Attached ${fileContents.length} file(s)`);
        }
      }
    }

    // Regular message
    const userMessage: Message = { role: 'user', content: enrichedInput };
    // Display sanitized input to user, but send enriched
    const displayMessage: Message = { role: 'user', content: sanitizedInput };
    
    // Create updated messages array with user message
    const messagesWithUser = [...messages, displayMessage];
    
    logger.debug(`[handleSubmit] Current messages: ${messages.length}`);
    logger.debug(`[handleSubmit] Messages with user: ${messagesWithUser.length}`);
    
    setMessages(messagesWithUser);
    setIsLoading(true);
    setStreamingContent('');

    const controller = new AbortController();
    setAbortController(controller);

    try {
      // Clean agent markers from history to prevent model confusion
      // When switching from agent to manual mode, history may contain [AGENT] prefixes
      const cleanedHistory = messages.map(msg => {
        if (msg.role === 'user' && (msg.content.startsWith('[AGENT] ') || msg.content.startsWith('[DRY RUN] '))) {
          return {
            ...msg,
            content: msg.content.replace(/^\[(AGENT|DRY RUN)\] /, ''),
          };
        }
        return msg;
      });
      
      logger.debug(`[handleSubmit] Calling chat API with messages.length: ${cleanedHistory.length}`);
      const response = await chat(
        enrichedInput,
        cleanedHistory, // Send cleaned conversation history WITHOUT the user message we just added
        (chunk) => {
          // Don't update streaming content if request was aborted
          if (!controller.signal.aborted) {
            setStreamingContent(c => c + chunk);
          }
        },
        undefined,
        projectContext,
        controller.signal
      );

      logger.debug(`[handleSubmit] Response received, length: ${response?.length || 0}`);
      logger.debug(`[handleSubmit] Controller aborted? ${controller.signal.aborted}`);

      // Check if request was aborted before updating messages
      if (!controller.signal.aborted) {
        const finalMessages = [...messagesWithUser, { role: 'assistant' as const, content: response }];
        logger.debug(`[handleSubmit] Final messages array length: ${finalMessages.length}`);
        setMessages(finalMessages);
        
        // Check for file changes in response if write access enabled
        if (hasWriteAccess && response) {
          const fileChanges = parseFileChanges(response);
          if (fileChanges.length > 0) {
            setPendingFileChanges(fileChanges);
          }
        }
        
        // Auto-save session
        autoSaveSession(finalMessages, projectPath);
      } else {
        // Revert to messages without user input on abort
        setMessages(messages);
      }
    } catch (error: unknown) {
      // Revert to messages without user input on error
      setMessages(messages);
      
      // Don't show error if request was aborted by user
      const err = error as Error;
      const isAborted = err.name === 'AbortError' || 
                       err.message?.includes('aborted') || 
                       err.message?.includes('abort') ||
                       controller.signal.aborted;
      
      if (!isAborted) {
        notify(`Error: ${err.message || 'Unknown error'}`);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      setAbortController(null);
    }
  };

  const handleCommand = (cmd: string) => {
    const parts = cmd.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case '/exit':
      case '/quit':
        exit();
        break;

      case '/help':
        setScreen('help');
        break;

      case '/status':
        setScreen('status');
        break;

      case '/version': {
        const version = getCurrentVersion();
        const provider = getCurrentProvider();
        const providers = getProviderList();
        const providerInfo = providers.find(p => p.id === provider.id);
        const providerName = providerInfo?.name || 'Unknown';
        notify(`Codeep v${version} • Provider: ${providerName} • Model: ${config.get('model')}`);
        break;
      }

      case '/update': {
        // Check for updates
        notify('Checking for updates...');
        checkForUpdates()
          .then((info) => {
            setUpdateInfo(info);
            const message = formatVersionInfo(info);
            // Split into multiple notifications for better display
            message.split('\n').forEach((line, i) => {
              setTimeout(() => notify(line), i * 100);
            });
          })
          .catch(() => {
            notify('Failed to check for updates. Please try again later.');
          });
        break;
      }

      case '/clear':
        setMessages([]);
        clearCodeBlocks();
        const newId = startNewSession();
        setSessionId(newId);
        notify('Chat cleared, new session started');
        break;

      case '/model': {
        const models = getModelsForCurrentProvider();
        if (args[0] && models[args[0]]) {
          config.set('model', args[0]);
          notify(`Model: ${args[0]}`);
        } else {
          setScreen('model');
        }
        break;
      }

      case '/provider':
        if (args[0] && PROVIDERS[args[0].toLowerCase()]) {
          if (setProvider(args[0].toLowerCase())) {
            notify(`Provider: ${getCurrentProvider().name}`);
          }
        } else {
          setScreen('provider');
        }
        break;

      case '/protocol':
        if (args[0] && PROTOCOLS[args[0].toLowerCase()]) {
          config.set('protocol', args[0].toLowerCase() as 'openai' | 'anthropic');
          notify(`Protocol: ${args[0]}`);
        } else {
          setScreen('protocol');
        }
        break;

      case '/sessions':
        // Handle /sessions delete
        if (args[0]?.toLowerCase() === 'delete') {
          if (args[1]) {
            // Delete specific session by name
            const sessionName = args.slice(1).join(' ');
            if (deleteSession(sessionName, projectPath)) {
              notify(`Deleted: ${sessionName}`);
            } else {
              notify(`Session not found: ${sessionName}`);
            }
          } else {
            // Open delete picker
            setScreen('sessions-delete');
          }
        } else {
          setScreen('sessions');
        }
        break;

      case '/settings':
        setScreen('settings');
        break;

      case '/grant': {
        // Always open permission dialog to allow users to manage permissions
        setScreen('permission');
        break;
      }

      case '/login':
        setScreen('login');
        break;

      case '/lang':
      case '/language':
        if (args[0] && LANGUAGES[args[0].toLowerCase()]) {
          config.set('language', args[0].toLowerCase() as LanguageCode);
          notify(`Language: ${LANGUAGES[args[0].toLowerCase()]}`);
        } else {
          setScreen('language');
        }
        break;

      case '/logout':
        setScreen('logout');
        break;

      case '/rename': {
        const newName = args.join(' ').trim();
        if (!newName) {
          notify('Usage: /rename <new-name>');
          break;
        }
        // Validate name (no special characters that could cause file issues)
        if (!/^[\w\s-]+$/.test(newName)) {
          notify('Invalid name. Use only letters, numbers, spaces, and hyphens.');
          break;
        }
        const currentId = getCurrentSessionId();
        if (renameSession(currentId, newName, projectPath)) {
          setSessionId(newName);
          notify(`Session renamed to: ${newName}`);
        } else {
          notify('Failed to rename session');
        }
        break;
      }

      case '/apply': {
        // Apply file changes from last AI response
        if (!hasWriteAccess) {
          notify('Write access not granted. Enable it in project permissions.');
          break;
        }
        
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || lastMessage.role !== 'assistant') {
          notify('No AI response to apply changes from.');
          break;
        }
        
        const fileChanges = parseFileChanges(lastMessage.content);
        if (fileChanges.length === 0) {
          notify('No file changes found in last response.');
          break;
        }
        
        // Apply all changes
        let successCount = 0;
        let errorCount = 0;
        
        for (const change of fileChanges) {
          const result = writeProjectFile(change.path, change.content);
          if (result.success) {
            successCount++;
          } else {
            errorCount++;
            notify(`Failed to write ${change.path}: ${result.error}`);
          }
        }
        
        if (successCount > 0) {
          notify(`Applied ${successCount} file change(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
        }
        break;
      }

      case '/search': {
        const term = args.join(' ').trim();
        if (!term) {
          notify('Usage: /search <term>');
          break;
        }
        
        if (messages.length === 0) {
          notify('No messages to search');
          break;
        }
        
        const results = searchMessages(messages, term);
        setSearchResults(results);
        setSearchTerm(term);
        setScreen('search');
        break;
      }

      case '/export': {
        if (messages.length === 0) {
          notify('No messages to export');
          break;
        }
        setScreen('export');
        break;
      }

      case '/diff': {
        const staged = args.includes('--staged') || args.includes('-s');
        const result = getGitDiff(staged, projectPath);
        
        if (!result.success) {
          notify(result.error || 'Failed to get diff');
          break;
        }
        
        if (!result.diff) {
          notify(staged ? 'No staged changes' : 'No unstaged changes');
          break;
        }
        
        // Add a clean user message first
        const userMessage: Message = {
          role: 'user',
          content: `/diff ${staged ? '--staged' : ''}\nRequesting review of ${staged ? 'staged' : 'unstaged'} changes`,
        };
        setMessages(prev => [...prev, userMessage]);
        
        // Format and send to AI with full diff in background
        const diffPreview = formatDiffForDisplay(result.diff, 100);
        const aiPrompt = `Review this git diff:\n\n\`\`\`diff\n${diffPreview}\n\`\`\`\n\nPlease provide feedback and suggestions.`;
        
        // Send to AI without adding another user message
        setIsLoading(true);
        setStreamingContent('');

        const controller = new AbortController();
        setAbortController(controller);

        (async () => {
          try {
            const response = await chat(
              aiPrompt,
              messages,
              (chunk) => {
                if (!controller.signal.aborted) {
                  setStreamingContent(c => c + chunk);
                }
              },
              undefined,
              projectContext,
              controller.signal
            );

            if (!controller.signal.aborted) {
              const finalMessages = [...messages, userMessage, { role: 'assistant' as const, content: response }];
              setMessages(finalMessages);
              autoSaveSession(finalMessages, projectPath);
            }
          } catch (error: unknown) {
            const err = error as Error;
            const isAborted = err.name === 'AbortError' || 
                             err.message?.includes('aborted') || 
                             err.message?.includes('abort') ||
                             controller.signal.aborted;
            
            if (!isAborted) {
              notify(`Error: ${err.message || 'Unknown error'}`);
            }
          } finally {
            setIsLoading(false);
            setStreamingContent('');
            setAbortController(null);
          }
        })();
        break;
      }

      case '/commit': {
        const status = getGitStatus(projectPath);
        
        if (!status.isRepo) {
          notify('Not a git repository');
          break;
        }
        
        const diff = getGitDiff(true, projectPath); // Get staged diff
        
        if (!diff.success || !diff.diff) {
          notify('No staged changes. Use `git add` first.');
          break;
        }
        
        // Ask AI to generate commit message
        const suggestion = suggestCommitMessage(diff.diff);
        const commitPrompt = `Generate a conventional commit message for these changes:\n\n\`\`\`diff\n${formatDiffForDisplay(diff.diff, 50)}\n\`\`\`\n\nSuggested: "${suggestion}"\n\nProvide an improved commit message following conventional commits format.`;
        
        notify('Generating commit message...');
        handleSubmit(commitPrompt);
        break;
      }

      case '/copy': {
        // Copy code block to clipboard
        const blockIndex = args[0] ? parseInt(args[0], 10) : -1;
        const code = getCodeBlock(blockIndex);
        if (code) {
          try {
            clipboardy.writeSync(code);
            notify(`Code block ${blockIndex === -1 ? '(last)' : `[${blockIndex}]`} copied to clipboard`);
          } catch {
            notify('Failed to copy to clipboard');
          }
        } else {
          notify('No code block found');
        }
        break;
      }

      case '/agent': {
        const prompt = args.join(' ').trim();
        if (!prompt) {
          notify('Usage: /agent <task description>');
          break;
        }
        
        if (isAgentRunning) {
          notify('Agent is already running. Press Escape to stop it first.');
          break;
        }
        
        startAgent(prompt, false);
        break;
      }

      case '/agent-dry': {
        const prompt = args.join(' ').trim();
        if (!prompt) {
          notify('Usage: /agent-dry <task description>');
          break;
        }
        
        if (isAgentRunning) {
          notify('Agent is already running. Press Escape to stop it first.');
          break;
        }
        
        startAgent(prompt, true);
        break;
      }

      case '/agent-stop': {
        if (!isAgentRunning) {
          notify('No agent is running');
          break;
        }
        abortController?.abort();
        notify('Stopping agent...');
        break;
      }

      case '/undo': {
        const result = undoLastAction();
        if (result.success) {
          notify(`Undo: ${result.message}`);
        } else {
          notify(`Cannot undo: ${result.message}`);
        }
        break;
      }

      case '/undo-all': {
        const result = undoAllActions();
        if (result.success) {
          notify(`Undone ${result.results.length} action(s)`);
        } else {
          notify(result.results.join('\n'));
        }
        break;
      }

      case '/history': {
        const sessions = getRecentSessions(5);
        if (sessions.length === 0) {
          notify('No agent history');
        } else {
          const formatted = sessions.map(s => {
            const date = new Date(s.startTime).toLocaleString();
            return `${date}: ${s.prompt.slice(0, 40)}... (${s.actions.length} actions)`;
          }).join('\n');
          notify(`Recent agent sessions:\n${formatted}`);
        }
        break;
      }

      case '/changes': {
        // Show all file changes from current agent session
        if (agentActions.length === 0) {
          notify('No changes in current session. Run an agent task first.');
        } else {
          // Filter to only file changes
          const fileChanges = agentActions.filter(a => 
            ['write', 'edit', 'delete', 'mkdir'].includes(a.type) && 
            a.result === 'success'
          );
          
          if (fileChanges.length === 0) {
            notify('No file changes in current session.');
          } else {
            // Format changes for display
            const writes = fileChanges.filter(a => a.type === 'write');
            const edits = fileChanges.filter(a => a.type === 'edit');
            const deletes = fileChanges.filter(a => a.type === 'delete');
            const mkdirs = fileChanges.filter(a => a.type === 'mkdir');
            
            let changesText = '# Session Changes\n\n';
            
            if (writes.length > 0) {
              changesText += `## Created (${writes.length})\n`;
              writes.forEach(w => changesText += `+ ${w.target}\n`);
              changesText += '\n';
            }
            
            if (edits.length > 0) {
              changesText += `## Modified (${edits.length})\n`;
              edits.forEach(e => changesText += `~ ${e.target}\n`);
              changesText += '\n';
            }
            
            if (deletes.length > 0) {
              changesText += `## Deleted (${deletes.length})\n`;
              deletes.forEach(d => changesText += `- ${d.target}\n`);
              changesText += '\n';
            }
            
            if (mkdirs.length > 0) {
              changesText += `## Directories (${mkdirs.length})\n`;
              mkdirs.forEach(m => changesText += `+ ${m.target}/\n`);
            }
            
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: changesText,
            }]);
          }
        }
        break;
      }

      case '/git-commit': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        const commitResult = autoCommitAgentChanges(
          args.join(' ') || 'Agent changes',
          [],
          projectContext.root
        );
        if (commitResult.success) {
          notify(`Committed: ${commitResult.hash}`);
        } else {
          notify(`Commit failed: ${commitResult.error}`);
        }
        break;
      }

      case '/context-save': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        const saved = saveContext(projectContext.root, messages);
        notify(saved ? 'Context saved' : 'Failed to save context');
        break;
      }

      case '/context-load': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        const loaded = loadContext(projectContext.root);
        if (loaded) {
          setMessages(mergeContext(loaded, []));
          notify(`Loaded context with ${loaded.messages.length} messages`);
        } else {
          notify('No saved context for this project');
        }
        break;
      }

      case '/context-clear': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        clearContext(projectContext.root);
        notify('Context cleared');
        break;
      }

      case '/review': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        const reviewFiles = args.length > 0 ? args : undefined;
        const reviewResult = performCodeReview(projectContext, reviewFiles);
        const formatted = formatReviewResult(reviewResult);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: formatted,
        }]);
        break;
      }

      case '/scan': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        
        // Check for subcommands
        if (args[0] === 'status') {
          const intel = loadProjectIntelligence(projectContext.root);
          if (intel) {
            const age = Math.round((Date.now() - new Date(intel.scannedAt).getTime()) / (1000 * 60 * 60));
            notify(`Last scan: ${age}h ago | ${intel.structure.totalFiles} files | ${intel.type}`);
          } else {
            notify('No scan data. Run /scan to analyze project.');
          }
          break;
        }
        
        if (args[0] === 'clear') {
          // Clear cached intelligence
          const intelPath = `${projectContext.root}/.codeep/intelligence.json`;
          try {
            const fs = require('fs');
            if (fs.existsSync(intelPath)) {
              fs.unlinkSync(intelPath);
              notify('Project intelligence cleared');
            } else {
              notify('No cached intelligence to clear');
            }
          } catch {
            notify('Failed to clear intelligence');
          }
          break;
        }
        
        // Run full scan
        notify('Scanning project...');
        scanProject(projectContext.root).then(intelligence => {
          saveProjectIntelligence(projectContext.root, intelligence);
          
          // Generate and display summary
          const context = generateContextFromIntelligence(intelligence);
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `# Project Scan Complete\n\n${context}\n\n---\n*Saved to .codeep/intelligence.json*`,
          }]);
          
          notify(`Scanned: ${intelligence.structure.totalFiles} files, ${intelligence.structure.totalDirectories} dirs`);
        }).catch(error => {
          notify('Scan failed: ' + (error as Error).message);
        });
        break;
      }

      case '/learn': {
        if (!projectContext) {
          notify('No project context');
          break;
        }
        if (args[0] === 'status') {
          const status = getLearningStatus(projectContext.root);
          notify(status);
        } else if (args[0] === 'rule' && args.length > 1) {
          const rule = args.slice(1).join(' ');
          addCustomRule(rule, projectContext.root);
          notify(`Added rule: ${rule}`);
        } else {
          // Trigger learning from project files
          const prefs = learnFromProject(projectContext.root, projectContext.keyFiles);
          notify(`Learned from ${prefs.sampleCount} files. Use /learn status to see preferences.`);
        }
        break;
      }

      case '/skills': {
        // Show all available skills, search, or stats
        if (args[0] === 'stats') {
          // Show skill usage statistics
          const stats = getSkillStats();
          const statsMessage = `# Skill Usage Statistics

- **Total skill executions:** ${stats.totalUsage}
- **Unique skills used:** ${stats.uniqueSkills}
- **Success rate:** ${stats.successRate}%`;
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: statsMessage,
          }]);
        } else if (args.length > 0) {
          // Search skills
          const query = args.join(' ');
          const results = searchSkills(query);
          if (results.length === 0) {
            notify(`No skills found matching: ${query}`);
          } else {
            const formatted = formatSkillsList(results);
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `# Search Results for "${query}"\n\n${formatted}`,
            }]);
          }
        } else {
          const skills = getAllSkills();
          const formatted = formatSkillsList(skills);
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: formatted,
          }]);
        }
        break;
      }

      case '/skill': {
        // Execute or show info about a specific skill
        if (args.length === 0) {
          notify('Usage: /skill <name> [args] or /skills to list all');
          break;
        }
        
        const skillName = args[0];
        const skillArgs = args.slice(1).join(' ');
        
        // Special subcommands
        if (skillName === 'create' && args.length > 1) {
          // Create a new custom skill template
          const newSkillName = args[1];
          const template = {
            name: newSkillName,
            description: 'Add description here',
            shortcut: '',
            category: 'custom',
            steps: [
              { type: 'prompt', content: 'Add your prompt here' },
            ],
          };
          try {
            saveCustomSkill(template as Skill);
            notify(`Created skill template: ~/.codeep/skills/${newSkillName}.json\nEdit it to customize.`);
          } catch (e) {
            notify(`Failed to create skill: ${(e as Error).message}`);
          }
          break;
        }
        
        if (skillName === 'delete' && args.length > 1) {
          const toDelete = args[1];
          if (deleteCustomSkill(toDelete)) {
            notify(`Deleted skill: ${toDelete}`);
          } else {
            notify(`Skill not found or is built-in: ${toDelete}`);
          }
          break;
        }
        
        if (skillName === 'help' && args.length > 1) {
          const helpSkill = findSkill(args[1]);
          if (helpSkill) {
            const help = formatSkillHelp(helpSkill);
            setMessages(prev => [...prev, { role: 'assistant', content: help }]);
          } else {
            notify(`Skill not found: ${args[1]}`);
          }
          break;
        }
        
        // Find and execute skill
        const skill = findSkill(skillName);
        if (!skill) {
          notify(`Skill not found: ${skillName}. Use /skills to list all.`);
          break;
        }
        
        // Parse parameters
        const params = parseSkillArgs(skillArgs, skill);
        
        // Check required parameters
        if (skill.parameters) {
          for (const param of skill.parameters) {
            if (param.required && !params[param.name]) {
              notify(`Missing required parameter: ${param.name}. Usage: /skill ${skill.name} <${param.name}>`);
              break;
            }
          }
        }
        
        // Check requirements
        if (skill.requiresWriteAccess && !hasWriteAccess) {
          notify(`Skill "${skill.name}" requires write access. Grant permission first.`);
          break;
        }
        
        if (skill.requiresGit) {
          const status = getGitStatus(projectPath);
          if (!status.isRepo) {
            notify(`Skill "${skill.name}" requires a git repository.`);
            break;
          }
        }
        
        // Execute skill based on step types
        const hasAgentStep = skill.steps.some(s => s.type === 'agent');
        
        // Track skill usage
        trackSkillUsage(skill.name);
        
        if (hasAgentStep && projectContext) {
          // Use agent mode for skills with agent steps
          const prompt = generateSkillPrompt(skill, projectContext, skillArgs, params);
          startAgent(prompt, false);
        } else if (projectContext) {
          // Use regular chat for prompt-only skills
          const prompt = generateSkillPrompt(skill, projectContext, skillArgs, params);
          handleSubmit(prompt);
        } else {
          notify('Skill requires project context');
        }
        break;
      }

      default: {
        // Check for skill chaining (e.g., /commit+push)
        const commandWithoutSlash = command.slice(1);
        const chain = parseSkillChain(commandWithoutSlash);
        
        if (chain) {
          // Execute skill chain
          if (!projectContext) {
            notify('Skill chain requires project context');
            break;
          }
          
          // Build combined prompt for all skills in chain
          const chainPrompt: string[] = [];
          chainPrompt.push('# Skill Chain');
          chainPrompt.push(`Execute the following skills in order. Stop if any fails.`);
          chainPrompt.push('');
          
          for (const skillName of chain.skills) {
            const skill = findSkill(skillName);
            if (!skill) continue;
            
            // Check requirements
            if (skill.requiresWriteAccess && !hasWriteAccess) {
              notify(`Skill chain requires write access (${skill.name})`);
              break;
            }
            
            if (skill.requiresGit) {
              const status = getGitStatus(projectPath);
              if (!status.isRepo) {
                notify(`Skill chain requires git repository (${skill.name})`);
                break;
              }
            }
            
            chainPrompt.push(`## Step: ${skill.name}`);
            chainPrompt.push(skill.description);
            for (const step of skill.steps) {
              if (step.type === 'prompt' || step.type === 'agent') {
                chainPrompt.push(step.content);
              }
            }
            chainPrompt.push('');
          }
          
          // Track all skills in chain
          for (const skillName of chain.skills) {
            trackSkillUsage(skillName);
          }
          
          // Execute chain as agent
          const fullPrompt = chainPrompt.join('\n');
          startAgent(fullPrompt, false);
          break;
        }
        
        // Check if it's a skill shortcut (e.g., /c for commit)
        const skillByShortcut = findSkill(commandWithoutSlash);
        if (skillByShortcut) {
          const skillArgs = args.join(' ');
          const params = parseSkillArgs(skillArgs, skillByShortcut);
          
          // Check required parameters
          if (skillByShortcut.parameters) {
            let missingParam = false;
            for (const param of skillByShortcut.parameters) {
              if (param.required && !params[param.name]) {
                notify(`Missing required parameter: ${param.name}. Usage: /${skillByShortcut.name} <${param.name}>`);
                missingParam = true;
                break;
              }
            }
            if (missingParam) break;
          }
          
          // Check requirements
          if (skillByShortcut.requiresWriteAccess && !hasWriteAccess) {
            notify(`Skill "${skillByShortcut.name}" requires write access.`);
            break;
          }
          
          if (skillByShortcut.requiresGit) {
            const status = getGitStatus(projectPath);
            if (!status.isRepo) {
              notify(`Skill "${skillByShortcut.name}" requires a git repository.`);
              break;
            }
          }
          
          const hasAgentStep = skillByShortcut.steps.some(s => s.type === 'agent');
          
          // Track skill usage
          trackSkillUsage(skillByShortcut.name);
          
          if (hasAgentStep && projectContext) {
            const prompt = generateSkillPrompt(skillByShortcut, projectContext, skillArgs, params);
            startAgent(prompt, false);
          } else if (projectContext) {
            const prompt = generateSkillPrompt(skillByShortcut, projectContext, skillArgs, params);
            handleSubmit(prompt);
          } else {
            notify('Skill requires project context');
          }
        } else {
          notify(`Unknown command: ${command}`);
        }
      }
    }
  };

  const handleLogin = () => {
    setScreen('chat');
    notify('Logged in successfully!');
  };

  const handleSessionLoad = (history: Message[], name: string) => {
    setMessages(history);
    setScreen('chat');
    notify(`Loaded: ${name}`);
  };

  const handlePermissionComplete = (granted: boolean, permanent: boolean, writeGranted: boolean = false) => {
    if (granted) {
      setHasProjectAccess(true);
      setHasWriteAccess(writeGranted);
      const ctx = getProjectContext(projectPath);
      if (ctx) {
        ctx.hasWriteAccess = writeGranted;
      }
      setProjectContext(ctx);
      if (permanent) {
        // Save permission to local .codeep/config.json
        setProjectPermission(projectPath, true, writeGranted);
      }
      
      // Show project tip with type and suggested commands
      const tip = getProjectTip(projectPath);
      if (tip) {
        notify(tip, 5000);
      } else {
        notify(writeGranted ? 'Project access granted (read + write)' : 'Project access granted (read-only)');
      }
      
      // Warn user if Agent Mode is ON but write access was not granted
      const agentMode = config.get('agentMode');
      if (agentMode === 'on' && !writeGranted) {
        setTimeout(() => {
          notify('⚠️  Agent Mode ON: Needs write permission to work. Use /grant to enable or /agent for manual mode.', 8000);
        }, 100);
      }
    } else {
      notify('Project access denied');
      
      // Warn user if Agent Mode is ON but access was denied
      const agentMode = config.get('agentMode');
      if (agentMode === 'on') {
        setTimeout(() => {
          notify('⚠️  Agent Mode ON: Permission denied. Use /grant to try again or /agent for manual mode.', 8000);
        }, 100);
      }
    }
    setScreen('chat');
  };

  // Render based on screen
  // Show intro only once on first load (not when messages are cleared)
  if (showIntro && screen === 'chat' && messages.length === 0 && !sessionLoaded) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center">
        <IntroAnimation onComplete={() => setShowIntro(false)} />
      </Box>
    );
  }

  if (screen === 'login') {
    return <Login onLogin={handleLogin} onCancel={() => setScreen('chat')} />;
  }

  if (screen === 'permission') {
    return (
      <ProjectPermission 
        projectPath={projectPath}
        onComplete={handlePermissionComplete}
      />
    );
  }

  if (screen === 'session-picker') {
    return (
      <SessionPicker
        projectPath={projectPath}
        onSelect={(loadedMessages, sessionName) => {
          setMessages(loadedMessages);
          setSessionId(sessionName);
          setSessionLoaded(true);
          setScreen('chat');
          setNotification(`Loaded: ${sessionName}`);
        }}
        onNewSession={() => {
          setSessionLoaded(true);
          setScreen('chat');
        }}
      />
    );
  }

  // Helper to check if we're showing an inline menu
  const isInlineMenu = ['help', 'status', 'settings', 'sessions', 'sessions-delete', 
                        'logout', 'search', 'export', 'model', 'provider', 'protocol', 'language'].includes(screen);

  return (
    <Box key="chat-screen" flexDirection="column">
      {/* Header - show logo only when no messages and not loading */}
      {messages.length === 0 && !isLoading && <Logo />}
      
      {/* Welcome message - show only when no messages */}
      {messages.length === 0 && !isLoading && (
        <Box flexDirection="column" marginY={1}>
          <Box justifyContent="center">
            <Text>
              Connected to <Text color="#f02a30">{config.get('model')}</Text>. Type <Text color="#f02a30">/help</Text> for commands.
            </Text>
          </Box>
          <Text> </Text>
          <Box justifyContent="center">
            <Text color="cyan" bold>Welcome to Codeep - Your AI Coding Assistant</Text>
          </Box>
          <Text> </Text>
          <Box flexDirection="column" paddingX={2}>
            <Text><Text color="#f02a30">•</Text> Ask questions about your code or request implementations</Text>
            <Text><Text color="#f02a30">•</Text> Use <Text color="cyan">/agent {'<task>'}</Text> for autonomous task execution</Text>
            <Text><Text color="#f02a30">•</Text> Type <Text color="cyan">/diff</Text> to review changes, <Text color="cyan">/commit</Text> to generate commit messages</Text>
            <Text><Text color="#f02a30">•</Text> Configure settings with <Text color="cyan">/settings</Text> - enable Agent Mode for auto-execution</Text>
          </Box>
          <Text> </Text>
          <Box justifyContent="center">
            <Text color="gray">Start typing your message or use a command to begin...</Text>
          </Box>
          <Text> </Text>
        </Box>
      )}

      {/* Messages */}
      <MessageList
        key={sessionId}
        messages={messages}
        streamingContent={streamingContent}
        agentStreamingContent={isAgentRunning ? agentStreamingContent : undefined}
      />

      {/* Loading - show while waiting or streaming */}
      {isLoading && !isAgentRunning && <Loading isStreaming={!!streamingContent} />}

      {/* Agent status bar - fixed height with spinner */}
      {isAgentRunning && (
        <AgentStatusBar
          iteration={agentIteration}
          actionsCount={agentActions.length}
          dryRun={agentDryRun}
          currentAction={agentActions.length > 0 ? `${agentActions[agentActions.length - 1].type}: ${agentActions[agentActions.length - 1].target.split('/').pop()}` : undefined}
        />
      )}

      {/* File changes prompt */}
      {pendingFileChanges.length > 0 && !isLoading && (
        <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1} marginY={1}>
          <Text color="#f02a30" bold>✓ Detected {pendingFileChanges.length} file change(s):</Text>
          {pendingFileChanges.map((change, i) => {
            const actionColor = change.action === 'delete' ? 'red' : change.action === 'edit' ? 'yellow' : 'green';
            const actionLabel = change.action === 'delete' ? 'DELETE' : change.action === 'edit' ? 'EDIT' : 'CREATE';
            return (
              <Text key={i}>
                  • <Text color={actionColor}>[{actionLabel}]</Text> {change.path}
                  {change.action !== 'delete' && change.content.includes('\n') && ` (${change.content.split('\n').length} lines)`}
              </Text>
            );
          })}
          <Text> </Text>
          <Text>Apply changes? <Text color="#f02a30" bold>[Y/n]</Text></Text>
          <Text color="cyan">Press Y to apply, N or Esc to reject</Text>
        </Box>
      )}

      {/* Notification */}
      {notification && (
        <Box justifyContent="center">
          <Text color="cyan">{notification}</Text>
        </Box>
      )}

      {/* Input - hide when inline menu is open */}
      {!isInlineMenu && (
        <Box flexDirection="column">
          <Text color="#f02a30">{'─'.repeat(Math.max(20, stdout?.columns || 80))}</Text>
          <Box paddingX={1}>
            <ChatInput 
              onSubmit={handleSubmit} 
              disabled={isLoading || isAgentRunning || pendingFileChanges.length > 0}
              history={inputHistory}
              clearTrigger={clearInputTrigger}
            />
          </Box>
          <Text color="#f02a30">{'─'.repeat(Math.max(20, stdout?.columns || 80))}</Text>
        </Box>
      )}

      {/* Inline menus - render below chat when active */}
      {isInlineMenu && (
        <Box flexDirection="column">
          {/* Separator line */}
          <Text color="#f02a30">{'─'.repeat(stdout?.columns || 80)}</Text>
          
          {/* Menu content */}
          {screen === 'help' && <Help projectPath={projectPath} />}
          {screen === 'status' && <Status />}
          {screen === 'settings' && (
            <Settings 
              onClose={() => setScreen('chat')}
              notify={notify}
              hasWriteAccess={hasWriteAccess}
              hasProjectContext={!!projectContext}
            />
          )}
          {screen === 'sessions' && (
            <Sessions 
              history={messages} 
              onLoad={handleSessionLoad}
              onClose={() => setScreen('chat')}
              projectPath={projectPath}
            />
          )}
          {screen === 'sessions-delete' && (
            <Sessions 
              history={messages} 
              onLoad={handleSessionLoad}
              onClose={() => setScreen('chat')}
              onDelete={(name) => {
                notify(`Deleted: ${name}`);
                setScreen('chat');
              }}
              deleteMode={true}
              projectPath={projectPath}
            />
          )}
          {screen === 'logout' && (
            <LogoutPicker
              onLogout={(providerId) => {
                notify(`Logged out from ${providerId}`);
                if (providerId === config.get('provider')) {
                  setMessages([]);
                  setScreen('login');
                } else {
                  setScreen('chat');
                }
              }}
              onLogoutAll={() => {
                notify('Logged out from all providers');
                setMessages([]);
                setScreen('login');
              }}
              onCancel={() => setScreen('chat')}
            />
          )}
          {screen === 'search' && (
            <Search 
              results={searchResults}
              searchTerm={searchTerm}
              onClose={() => setScreen('chat')}
              onSelectMessage={(index) => {
                notify(`Message #${index + 1}`);
              }}
            />
          )}
          {screen === 'export' && (
            <Export
              onExport={(format) => {
                const content = exportMessages(messages, {
                  format,
                  sessionName: sessionId || 'chat',
                });
                const result = saveExport(content, format, process.cwd(), sessionId || undefined);
                if (result.success) {
                  notify(`Exported to ${result.filePath}`);
                } else {
                  notify(`Export failed: ${result.error}`);
                }
                setScreen('chat');
              }}
              onCancel={() => setScreen('chat')}
            />
          )}
          {screen === 'model' && <ModelSelect onClose={() => setScreen('chat')} notify={notify} />}
          {screen === 'provider' && <ProviderSelect onClose={() => setScreen('chat')} notify={notify} />}
          {screen === 'protocol' && <ProtocolSelect onClose={() => setScreen('chat')} notify={notify} />}
          {screen === 'language' && <LanguageSelect onClose={() => setScreen('chat')} notify={notify} />}
          
          {/* Close hint */}
          <Text color="gray">Press Escape to close</Text>
        </Box>
      )}

      {/* Footer with shortcuts - hide when inline menu is open */}
      {!isInlineMenu && (
        <Box flexDirection="column">
          <Box>
            <Text>
              <Text color="#f02a30" bold>Ctrl+V</Text>
              <Text> Paste  </Text>
              <Text color="#f02a30" bold>Ctrl+L</Text>
              <Text> Clear  </Text>
              <Text color="#f02a30" bold>Esc</Text>
              <Text> Cancel  </Text>
              <Text color="#f02a30" bold>↑↓</Text>
              <Text> History  </Text>
              <Text color="#f02a30" bold>/help</Text>
              <Text> Commands</Text>
            </Text>
          </Box>
          <Box>
            {config.get('agentMode') === 'on' ? (
              hasWriteAccess && projectContext ? (
                <Text color="green">Agent: ON ✓</Text>
              ) : (
                <Text color="yellow">Agent: ON (no permission - use /grant)</Text>
              )
            ) : (
              <Text color="cyan">Agent: Manual (use /agent)</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};

// Model selection component
const ModelSelect: React.FC<{ onClose: () => void; notify: (msg: string) => void }> = ({ onClose, notify }) => {
  const [selected, setSelected] = useState(0);
  const models = Object.entries(getModelsForCurrentProvider());
  const provider = getCurrentProvider();

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(models.length - 1, s + 1));
    if (key.return) {
      config.set('model', models[selected][0]);
      notify(`Model: ${models[selected][0]}`);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Select Model</Text>
      <Text>Provider: {provider.name}</Text>
      <Text> </Text>
      {models.map(([key, desc], i) => (
        <Text key={key}>
          {i === selected ? <Text color="#f02a30">▸ </Text> : '  '}
          <Text color={i === selected ? '#f02a30' : undefined}>{key}</Text>
          <Text> - {desc}</Text>
          {key === config.get('model') && <Text color="green"> ●</Text>}
        </Text>
      ))}
      <Text> </Text>
      <Text>Enter to select, Escape to close</Text>
    </Box>
  );
};

// Provider selection component
const ProviderSelect: React.FC<{ onClose: () => void; notify: (msg: string) => void }> = ({ onClose, notify }) => {
  const [selected, setSelected] = useState(0);
  const providers = getProviderList();
  const currentProvider = getCurrentProvider();

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(providers.length - 1, s + 1));
    if (key.return) {
      setProvider(providers[selected].id);
      notify(`Provider: ${providers[selected].name}`);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Select AI Provider</Text>
      <Text> </Text>
      {providers.map((provider, i) => (
        <Text key={provider.id}>
          {i === selected ? <Text color="#f02a30">▸ </Text> : '  '}
          <Text color={i === selected ? '#f02a30' : undefined}>{provider.name}</Text>
          <Text> - {provider.description}</Text>
          {provider.id === currentProvider.id && <Text color="green"> ●</Text>}
        </Text>
      ))}
      <Text> </Text>
      <Text>Enter to select, Escape to close</Text>
      <Text color="#f02a30">Note: You may need to /login with a new API key</Text>
    </Box>
  );
};

// Protocol selection component
const ProtocolSelect: React.FC<{ onClose: () => void; notify: (msg: string) => void }> = ({ onClose, notify }) => {
  const [selected, setSelected] = useState(0);
  const protocols = Object.entries(PROTOCOLS);

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(protocols.length - 1, s + 1));
    if (key.return) {
      config.set('protocol', protocols[selected][0] as 'openai' | 'anthropic');
      notify(`Protocol: ${protocols[selected][0]}`);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Select Protocol</Text>
      <Text> </Text>
      {protocols.map(([key, desc], i) => (
        <Text key={key}>
          {i === selected ? <Text color="#f02a30">▸ </Text> : '  '}
          <Text color={i === selected ? '#f02a30' : undefined}>{key}</Text>
          <Text> - {desc}</Text>
          {key === config.get('protocol') && <Text color="green"> ●</Text>}
        </Text>
      ))}
      <Text> </Text>
      <Text>Enter to select, Escape to close</Text>
    </Box>
  );
};

// Language selection component
const LanguageSelect: React.FC<{ onClose: () => void; notify: (msg: string) => void }> = ({ onClose, notify }) => {
  const [selected, setSelected] = useState(0);
  const languages = Object.entries(LANGUAGES);

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(languages.length - 1, s + 1));
    if (key.return) {
      config.set('language', languages[selected][0] as LanguageCode);
      notify(`Language: ${languages[selected][1]}`);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Select Response Language</Text>
      <Text> </Text>
      {languages.map(([key, name], i) => (
        <Text key={key}>
          {i === selected ? <Text color="#f02a30">▸ </Text> : '  '}
          <Text color={i === selected ? '#f02a30' : undefined}>{name}</Text>
          {key === config.get('language') && <Text color="green"> ●</Text>}
        </Text>
      ))}
      <Text> </Text>
      <Text>Enter to select, Escape to close</Text>
    </Box>
  );
};
