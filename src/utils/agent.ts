/**
 * Agent loop - autonomous task execution.
 *
 * Private chat/stream logic lives in agentChat.ts and agentStream.ts.
 */

import { ProjectContext } from './project';

// Debug logging helper - only logs when CODEEP_DEBUG=1
const debug = (...args: unknown[]) => {
  if (process.env.CODEEP_DEBUG === '1') {
    console.error('[DEBUG]', ...args);
  }
};

// Import chat layer (prompt building + API calls)
import {
  agentChat,
  agentChatFallback as _agentChatFallback,
  getAgentSystemPrompt,
  getFallbackSystemPrompt,
  TimeoutError,
  loadProjectRules,
  formatChatHistoryForAgent,
} from './agentChat';
import type { AgentChatResponse } from './agentChat';
export { loadProjectRules, formatChatHistoryForAgent };
export type { AgentChatResponse };

/**
 * Calculate dynamic timeout based on task complexity
 * Complex tasks (creating pages, multiple files) need more time
 */
function calculateDynamicTimeout(prompt: string, iteration: number, baseTimeout: number): number {
  // Simple approach: just use base timeout with small multiplier for later iterations
  // Complex calculations were causing more problems than they solved
  
  let multiplier = 1.0;
  
  // Later iterations have larger context, may need slightly more time
  if (iteration > 3) {
    multiplier = 1.2;
  }
  if (iteration > 8) {
    multiplier = 1.5;
  }
  
  // Minimum 120 seconds, maximum 5 minutes for a single API call
  const calculatedTimeout = baseTimeout * multiplier;
  return Math.min(Math.max(calculatedTimeout, 120000), 300000);
}
import {
  parseToolCalls,
  executeTool,
  createActionLog,
  ToolCall,
  ToolResult,
  ActionLog
} from './tools';
import { config, Message } from '../config/index';
import { supportsNativeTools } from '../config/providers';
import { startSession, endSession, undoLastAction, undoAllActions, getCurrentSession, getRecentSessions, formatSession, ActionSession } from './history';
import { runAllVerifications, formatErrorsForAgent, hasVerificationErrors, getVerificationSummary, VerifyResult } from './verify';
import { gatherSmartContext, formatSmartContext, extractTargetFile } from './smartContext';
import { planTasks, getNextTask, formatTaskPlan, TaskPlan, SubTask } from './taskPlanner';

export interface AgentOptions {
  maxIterations: number;
  maxDuration: number; // milliseconds
  onToolCall?: (tool: ToolCall) => void;
  onToolResult?: (result: ToolResult, toolCall: ToolCall) => void;
  onIteration?: (iteration: number, message: string) => void;
  onThinking?: (text: string) => void;
  onVerification?: (results: VerifyResult[]) => void;
  onTaskPlan?: (plan: TaskPlan) => void;
  onTaskUpdate?: (task: SubTask) => void;
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  autoVerify?: boolean;
  maxFixAttempts?: number;
  usePlanning?: boolean; // Enable task planning for complex tasks
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>; // Prior chat session context
}

export interface AgentResult {
  success: boolean;
  iterations: number;
  actions: ActionLog[];
  finalResponse: string;
  error?: string;
  aborted?: boolean;
}

const DEFAULT_OPTIONS: AgentOptions = {
  maxIterations: 100, // Increased for large tasks
  maxDuration: 20 * 60 * 1000, // 20 minutes
  usePlanning: false, // Disable task planning - causes more problems than it solves
};


/**
 * Run the agent loop
 */
export async function runAgent(
  prompt: string,
  projectContext: ProjectContext,
  options: Partial<AgentOptions> = {}
): Promise<AgentResult> {
  // Load limits from config
  const configMaxIterations = config.get('agentMaxIterations');
  const configMaxDuration = config.get('agentMaxDuration') * 60 * 1000; // convert minutes to ms
  
  const opts: AgentOptions = { 
    ...DEFAULT_OPTIONS, 
    maxIterations: configMaxIterations,
    maxDuration: configMaxDuration,
    ...options 
  };
  const startTime = Date.now();
  const actions: ActionLog[] = [];
  const messages: Message[] = [];
  
  // Start history session for undo support
  const sessionId = startSession(prompt, projectContext.root || process.cwd());
  
  // Task planning phase (if enabled)
  // Use planning for complex keywords or multi-word prompts
  let taskPlan: TaskPlan | null = null;
  const complexKeywords = ['create', 'build', 'implement', 'add', 'setup', 'generate', 'make', 'develop'];
  const hasComplexKeyword = complexKeywords.some(kw => prompt.toLowerCase().includes(kw));
  const shouldPlan = opts.usePlanning && (prompt.split(' ').length > 3 || hasComplexKeyword);
  
  if (shouldPlan) {
    try {
      opts.onIteration?.(0, 'Planning tasks...');
      taskPlan = await planTasks(prompt, {
        name: projectContext.name,
        type: projectContext.type,
        structure: projectContext.structure,
      });
      
      if (taskPlan.tasks.length > 1) {
        opts.onTaskPlan?.(taskPlan);
        // Mark first task as in_progress
        taskPlan.tasks[0].status = 'in_progress';
      } else {
        taskPlan = null; // Single task, no need for planning
      }
    } catch (error) {
      // Planning failed, continue without it
      taskPlan = null;
    }
  }
  
  // Gather smart context based on the task
  const targetFile = extractTargetFile(prompt);
  const smartContext = gatherSmartContext(targetFile, projectContext, prompt);
  const smartContextStr = formatSmartContext(smartContext);
  
  // Check if provider supports native tools
  const protocol = config.get('protocol');
  const providerId = config.get('provider');
  const useNativeTools = supportsNativeTools(providerId, protocol);
  
  // Build system prompt - use fallback format if native tools not supported
  let systemPrompt = useNativeTools 
    ? getAgentSystemPrompt(projectContext)
    : getFallbackSystemPrompt(projectContext);
  
  // Inject project rules (from .codeep/rules.md or CODEEP.md)
  const projectRules = loadProjectRules(projectContext.root);
  if (projectRules) {
    systemPrompt += projectRules;
  }
  
  if (smartContextStr) {
    systemPrompt += '\n\n' + smartContextStr;
  }

  // Inject prior chat session context
  const chatHistoryStr = formatChatHistoryForAgent(opts.chatHistory);
  if (chatHistoryStr) {
    systemPrompt += chatHistoryStr;
  }
  
  // Initial user message with optional task plan
  let initialPrompt = prompt;
  if (taskPlan) {
    initialPrompt = `${prompt}\n\n## Task Breakdown\nI've broken this down into subtasks. Complete them in order:\n\n${formatTaskPlan(taskPlan)}\n\nStart with task 1.`;
  }
  messages.push({ role: 'user', content: initialPrompt });
  
  let iteration = 0;
  let finalResponse = '';
  let result: AgentResult;
  let consecutiveTimeouts = 0;
  const maxTimeoutRetries = 3;
  const maxConsecutiveTimeouts = 9; // Allow more consecutive timeouts before giving up
  const baseTimeout = config.get('agentApiTimeout');
  
  try {
    while (iteration < opts.maxIterations) {
      // Check timeout
      if (Date.now() - startTime > opts.maxDuration) {
        result = {
          success: false,
          iterations: iteration,
          actions,
          finalResponse: 'Agent timed out',
          error: `Exceeded maximum duration of ${opts.maxDuration / 1000} seconds`,
        };
        return result;
      }
      
      // Check abort signal
      if (opts.abortSignal?.aborted) {
        debug('Agent aborted at iteration', iteration);
        result = {
          success: false,
          iterations: iteration,
          actions,
          finalResponse: 'Agent was stopped by user',
          aborted: true,
        };
        return result;
      }
      
      iteration++;
      opts.onIteration?.(iteration, `Iteration ${iteration}/${opts.maxIterations}`);
      
      debug(`Starting iteration ${iteration}/${opts.maxIterations}, actions: ${actions.length}`);
      
      // Calculate dynamic timeout based on task complexity
      const dynamicTimeout = calculateDynamicTimeout(prompt, iteration, baseTimeout);
      debug(`Using timeout: ${dynamicTimeout}ms (base: ${baseTimeout}ms)`);
      
      // Get AI response with retry logic for timeouts
      let chatResponse: AgentChatResponse;
      let retryCount = 0;
      
      while (true) {
        try {
          chatResponse = await agentChat(
            messages,
            systemPrompt,
            opts.onThinking,
            opts.abortSignal,
            dynamicTimeout * (1 + retryCount * 0.5) // Increase timeout on retry
          );
          consecutiveTimeouts = 0; // Reset consecutive count on success
          break;
        } catch (error) {
          const err = error as Error;
          
          // Handle user abort (not timeout)
          if (err.name === 'AbortError') {
            result = {
              success: false,
              iterations: iteration,
              actions,
              finalResponse: 'Agent was stopped by user',
              aborted: true,
            };
            return result;
          }
          
          // Handle timeout with retry
          if (err.name === 'TimeoutError') {
            retryCount++;
            consecutiveTimeouts++;
            debug(`Timeout occurred (retry ${retryCount}/${maxTimeoutRetries}, consecutive: ${consecutiveTimeouts})`);
            opts.onIteration?.(iteration, `API timeout, retrying (${retryCount}/${maxTimeoutRetries})...`);
            
            if (retryCount >= maxTimeoutRetries) {
              // Too many retries for this iteration
              if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
                // Too many consecutive timeouts overall, give up
                result = {
                  success: false,
                  iterations: iteration,
                  actions,
                  finalResponse: 'Agent stopped due to repeated API timeouts',
                  error: `API timed out ${consecutiveTimeouts} times consecutively. Try increasing the timeout in settings or simplifying the task.`,
                };
                return result;
              }
              
              // Skip this iteration and try next
              messages.push({ 
                role: 'user', 
                content: 'The previous request timed out. Please continue with the task, using simpler responses if needed.' 
              });
              break;
            }
            
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            continue;
          }
          
          throw error;
        }
      }
      
      // If we broke out due to max retries without a response, continue to next iteration
      if (!chatResponse!) {
        continue;
      }
      
      let { content, toolCalls, usedNativeTools } = chatResponse;
      
      // If native tools were used but no tool calls returned, try parsing text-based tool calls
      // This handles models that accept tools parameter but respond with text anyway
      if (usedNativeTools && toolCalls.length === 0 && iteration === 1) {
        const textToolCalls = parseToolCalls(content);
        if (textToolCalls.length > 0) {
          toolCalls = textToolCalls;
        }
      }
      
      // If no tool calls, check if model wants to continue or is really done
      if (toolCalls.length === 0) {
        debug(`No tool calls at iteration ${iteration}, content length: ${content.length}`);
        
        // Remove <think>...</think> tags from response (some models include thinking)
        // Also remove Tool parameters/tool call artifacts that AI sometimes includes in text
        finalResponse = content
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/Tool parameters:[\s\S]*?(?=\n\n|$)/gi, '')
          .replace(/\{'path'[\s\S]*?\}/g, '')
          .replace(/```[\s\S]*?```/g, '')
          .trim();
        
        // Check if model indicates it wants to continue (incomplete response)
        const continueIndicators = [
          'let me', 'i will', 'i\'ll', 'now i', 'next i', 
          'creating', 'writing', 'generating',
          'let\'s', 'going to', 'need to create', 'need to write'
        ];
        const lowerResponse = finalResponse.toLowerCase();
        const wantsToContinue = continueIndicators.some(indicator => lowerResponse.includes(indicator));
        
        // Also check if there were tool call parsing failures in this iteration
        // by looking for incomplete actions (e.g., write_file without content)
        const hasIncompleteWork = iteration < 10 && wantsToContinue && finalResponse.length < 500;
        
        if (hasIncompleteWork) {
          debug('Model wants to continue, prompting for next action');
          messages.push({ role: 'assistant', content });
          messages.push({ 
            role: 'user', 
            content: 'Continue. Execute the tool calls now.' 
          });
          continue;
        }
        
        // Model is done
        debug(`Agent finished at iteration ${iteration}`);
        break;
      }
      
      // Add assistant response to history
      messages.push({ role: 'assistant', content });
      
      // Execute tool calls
      const toolResults: string[] = [];
      
      for (const toolCall of toolCalls) {
        opts.onToolCall?.(toolCall);
        
        let toolResult: ToolResult;
        
        if (opts.dryRun) {
          // In dry run mode, simulate success
          toolResult = {
            success: true,
            output: `[DRY RUN] Would execute: ${toolCall.tool}`,
            tool: toolCall.tool,
            parameters: toolCall.parameters,
          };
        } else {
          // Actually execute the tool
          toolResult = await executeTool(toolCall, projectContext.root || process.cwd());
        }
        
        opts.onToolResult?.(toolResult, toolCall);
        
        // Log action
        const actionLog = createActionLog(toolCall, toolResult);
        actions.push(actionLog);
        
        // Format result for AI
        if (toolResult.success) {
          toolResults.push(`Tool ${toolCall.tool} succeeded:\n${toolResult.output}`);
        } else {
          toolResults.push(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
        }
      }
      
      // Add tool results to messages
      messages.push({
        role: 'user',
        content: `Tool results:\n\n${toolResults.join('\n\n')}\n\nContinue with the task. If this subtask is complete, provide a summary without tool calls.`,
      });
    }
    
    // Check if we hit max iterations
    if (iteration >= opts.maxIterations && !finalResponse) {
      result = {
        success: false,
        iterations: iteration,
        actions,
        finalResponse: 'Agent reached maximum iterations',
        error: `Exceeded maximum of ${opts.maxIterations} iterations`,
      };
      return result;
    }
    
    // Self-verification: Run build/test and fix errors if needed
    const autoVerify = opts.autoVerify ?? config.get('agentAutoVerify');
    const maxFixAttempts = opts.maxFixAttempts ?? config.get('agentMaxFixAttempts');
    
    if (autoVerify && !opts.dryRun) {
      // Check if we made any file changes worth verifying
      const hasFileChanges = actions.some(a => 
        a.type === 'write' || a.type === 'edit' || a.type === 'delete'
      );
      
      if (hasFileChanges) {
        let fixAttempt = 0;
        
        while (fixAttempt < maxFixAttempts) {
          // Check abort signal
          if (opts.abortSignal?.aborted) {
            break;
          }
          
          opts.onIteration?.(iteration, `Verification attempt ${fixAttempt + 1}/${maxFixAttempts}`);
          
          // Run verifications
          const verifyResults = runAllVerifications(projectContext.root || process.cwd(), {
            runBuild: true,
            runTest: true,
            runTypecheck: true,
            runLint: false,
          });
          
          opts.onVerification?.(verifyResults);
          
          // Check if all passed
          if (!hasVerificationErrors(verifyResults)) {
            const summary = getVerificationSummary(verifyResults);
            finalResponse += `\n\n✓ Verification passed: ${summary.passed}/${summary.total} checks`;
            break;
          }
          
          fixAttempt++;
          
          // If we've exceeded attempts, report the errors
          if (fixAttempt >= maxFixAttempts) {
            const summary = getVerificationSummary(verifyResults);
            finalResponse += `\n\n✗ Verification failed after ${fixAttempt} fix attempts: ${summary.errors} errors remaining`;
            break;
          }
          
          // Ask agent to fix the errors
          const errorMessage = formatErrorsForAgent(verifyResults);
          messages.push({ role: 'assistant', content: finalResponse });
          messages.push({ 
            role: 'user', 
            content: `${errorMessage}\n\nFix these errors. After fixing, I will re-run verification.` 
          });
          
          iteration++;
          if (iteration >= opts.maxIterations) {
            break;
          }
          
          // Get AI response to fix errors
          try {
            const fixResponse = await agentChat(
              messages,
              systemPrompt,
              opts.onThinking,
              opts.abortSignal
            );
            
            const { content: fixContent, toolCalls: fixToolCalls } = fixResponse;
            
            if (fixToolCalls.length === 0) {
              // Agent gave up or thinks it's fixed
              finalResponse = fixContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
              continue; // Re-run verification
            }
            
            // Execute fix tool calls
            messages.push({ role: 'assistant', content: fixContent });
            const fixResults: string[] = [];
            
            for (const toolCall of fixToolCalls) {
              opts.onToolCall?.(toolCall);
              
              const toolResult = await executeTool(toolCall, projectContext.root || process.cwd());
              opts.onToolResult?.(toolResult, toolCall);
              
              const actionLog = createActionLog(toolCall, toolResult);
              actions.push(actionLog);
              
              if (toolResult.success) {
                fixResults.push(`Tool ${toolCall.tool} succeeded:\n${toolResult.output}`);
              } else {
                fixResults.push(`Tool ${toolCall.tool} failed:\n${toolResult.error || 'Unknown error'}`);
              }
            }
            
            messages.push({
              role: 'user',
              content: `Fix results:\n\n${fixResults.join('\n\n')}\n\nContinue fixing if needed. Re-running verification...`,
            });
            
          } catch (error) {
            // If fix attempt failed, continue to next attempt
            break;
          }
        }
      }
    }
    
    result = {
      success: true,
      iterations: iteration,
      actions,
      finalResponse,
    };
    return result;
    
  } catch (error) {
    const err = error as Error;
    result = {
      success: false,
      iterations: iteration,
      actions,
      finalResponse: '',
      error: err.message,
    };
    return result;
  } finally {
    // End session and save history
    endSession();
  }
}

/**
 * Format agent result for display
 */
export function formatAgentResult(result: AgentResult): string {
  const lines: string[] = [];
  
  if (result.success) {
    lines.push(`Agent completed in ${result.iterations} iteration(s)`);
  } else if (result.aborted) {
    lines.push('Agent was stopped by user');
  } else {
    lines.push(`Agent failed: ${result.error}`);
  }
  
  if (result.actions.length > 0) {
    lines.push('');
    lines.push('Actions performed:');
    for (const action of result.actions) {
      const status = action.result === 'success' ? '✓' : '✗';
      lines.push(`  ${status} ${action.type}: ${action.target}`);
    }
  }
  
  return lines.join('\n');
}

// Re-export history functions for undo support
export { 
  undoLastAction, 
  undoAllActions, 
  getCurrentSession, 
  getRecentSessions, 
  formatSession,
  type ActionSession 
};

/**
 * Get agent history for display
 */
export function getAgentHistory(): Array<{
  timestamp: number;
  task: string;
  actions: Array<{ type: string; target: string; result: string }>;
  success: boolean;
}> {
  const sessions = getRecentSessions(10);
  return sessions.map(s => ({
    timestamp: s.startTime,
    task: s.prompt || 'Unknown task',
    actions: s.actions.map(a => ({
      type: a.type,
      target: a.path || '',
      result: 'success',
    })),
    success: s.endTime !== undefined,
  }));
}

/**
 * Get current session actions
 */
export function getCurrentSessionActions(): Array<{ type: string; target: string; result: string }> {
  const session = getCurrentSession();
  if (!session) return [];
  return session.actions.map(a => ({
    type: a.type,
    target: a.path || '',
    result: 'success',
  }));
}
