/**
 * useAgent hook - isolates agent state management from main App
 * Reduces re-renders in App component when agent state changes
 */

import { useState, useCallback, useRef } from 'react';
import { runAgent, formatAgentResult, AgentResult } from '../utils/agent';
import { ActionLog, ToolCall, ToolResult, createActionLog } from '../utils/tools';
import { ProjectContext } from '../utils/project';
import { Message, autoSaveSession } from '../config/index';

interface UseAgentOptions {
  projectContext: ProjectContext | null;
  hasWriteAccess: boolean;
  messages: Message[];
  projectPath: string;
  onMessageAdd: (message: Message) => void;
  notify: (msg: string, duration?: number) => void;
}

interface UseAgentReturn {
  isAgentRunning: boolean;
  agentIteration: number;
  agentActions: ActionLog[];
  agentThinking: string;
  agentResult: AgentResult | null;
  agentDryRun: boolean;
  startAgent: (prompt: string, dryRun?: boolean) => Promise<void>;
  stopAgent: () => void;
  clearAgentState: () => void;
}

export function useAgent({
  projectContext,
  hasWriteAccess,
  messages,
  projectPath,
  onMessageAdd,
  notify,
}: UseAgentOptions): UseAgentReturn {
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [agentIteration, setAgentIteration] = useState(0);
  const [agentActions, setAgentActions] = useState<ActionLog[]>([]);
  const [agentThinking, setAgentThinking] = useState('');
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentDryRun, setAgentDryRun] = useState(false);
  
  const abortControllerRef = useRef<AbortController | null>(null);

  const clearAgentState = useCallback(() => {
    setAgentResult(null);
    setAgentActions([]);
    setAgentThinking('');
    setAgentIteration(0);
  }, []);

  const stopAgent = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

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
    
    // Add user message
    const userMessage: Message = { 
      role: 'user', 
      content: dryRun ? `[DRY RUN] ${prompt}` : `[AGENT] ${prompt}` 
    };
    onMessageAdd(userMessage);
    
    const controller = new AbortController();
    abortControllerRef.current = controller;
    
    try {
      const result = await runAgent(prompt, projectContext, {
        dryRun,
        onIteration: (iteration) => {
          setAgentIteration(iteration);
        },
        onToolCall: (tool: ToolCall) => {
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
            result: 'success',
            details,
            timestamp: Date.now(),
          };
          setAgentActions(prev => [...prev, actionLog]);
        },
        onToolResult: (result: ToolResult, toolCall: ToolCall) => {
          const actionLog = createActionLog(toolCall, result);
          setAgentActions(prev => {
            const updated = [...prev];
            if (updated.length > 0) {
              updated[updated.length - 1] = actionLog;
            }
            return updated;
          });
        },
        onThinking: (text: string) => {
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
      
      // Add agent summary as assistant message
      const summaryMessage: Message = {
        role: 'assistant',
        content: result.finalResponse || formatAgentResult(result),
      };
      onMessageAdd(summaryMessage);
      
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
      abortControllerRef.current = null;
      setAgentThinking('');
    }
  }, [projectContext, hasWriteAccess, messages, projectPath, onMessageAdd, notify]);

  return {
    isAgentRunning,
    agentIteration,
    agentActions,
    agentThinking,
    agentResult,
    agentDryRun,
    startAgent,
    stopAgent,
    clearAgentState,
  };
}

export default useAgent;
