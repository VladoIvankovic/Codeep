/**
 * Agent loop - autonomous task execution
 */

import { ProjectContext } from './project';
import { 
  parseToolCalls, 
  executeTool, 
  createActionLog, 
  formatToolDefinitions, 
  getOpenAITools,
  getAnthropicTools,
  parseOpenAIToolCalls,
  parseAnthropicToolCalls,
  ToolCall, 
  ToolResult, 
  ActionLog 
} from './tools';
import { config, getApiKey, Message } from '../config/index';
import { getProviderBaseUrl, getProviderAuthHeader, supportsNativeTools } from '../config/providers';
import { startSession, endSession, undoLastAction, undoAllActions, getCurrentSession, getRecentSessions, formatSession, ActionSession } from './history';
import { runAllVerifications, formatErrorsForAgent, hasVerificationErrors, getVerificationSummary, VerifyResult } from './verify';
import { gatherSmartContext, formatSmartContext, extractTargetFile } from './smartContext';
import { planTasks, getNextTask, formatTaskPlan, TaskPlan, SubTask } from './taskPlanner';

export interface AgentOptions {
  maxIterations: number;
  maxDuration: number; // milliseconds
  onToolCall?: (tool: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
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
  usePlanning: true, // Enable task planning by default
};

/**
 * Generate system prompt for agent mode (used with native tool calling)
 */
function getAgentSystemPrompt(projectContext: ProjectContext): string {
  return `You are an AI coding agent with FULL autonomous access to this project.

## Your Capabilities
- Read, write, edit, and delete files and directories
- Create directories with create_directory tool
- Execute shell commands (npm, git, build tools, etc.)
- Search code in the project
- List directory contents

## IMPORTANT: Follow User Instructions Exactly
- Do EXACTLY what the user asks - complete the ENTIRE task
- If user says "create a website" -> create ALL necessary files (HTML, CSS, JS, etc.)
- If user says "create folder X" -> use create_directory tool to create folder X
- If user says "delete file X" -> use delete_file tool to delete file X
- Do NOT stop after just 1-2 tool calls unless the task is trivially simple
- Complex tasks (like creating websites) require MANY tool calls to complete
- The user may write in any language - understand their request and execute it
- Tool names and parameters must ALWAYS be in English (e.g., "create_directory", not "kreiraj_direktorij")
- KEEP WORKING until the entire task is finished - do not stop prematurely

## Rules
1. Always read files before editing them to understand the current content
2. Use edit_file for modifications to existing files (preserves other content)
3. Use write_file only for creating new files or complete overwrites
4. Use create_directory to create new folders/directories
5. When the task is complete, respond with a summary WITHOUT any tool calls
6. IMPORTANT: After finishing, your response must NOT include any tool calls - just provide a summary

## Self-Verification
After you make changes, the system will automatically run build and tests.
If there are errors, you will receive them and must fix them.
- Read error messages carefully
- Fix the specific files and lines mentioned
- Keep trying until verification passes

## Project Context
**Name:** ${projectContext.name}
**Type:** ${projectContext.type}

**Structure:**
\`\`\`
${projectContext.structure}
\`\`\`

**Key Files:** ${projectContext.keyFiles.join(', ')}

You have FULL READ AND WRITE access. Use the tools to complete tasks autonomously.`;
}

/**
 * Generate fallback system prompt (text-based tool calling)
 */
function getFallbackSystemPrompt(projectContext: ProjectContext): string {
  return `You are an AI coding agent with FULL autonomous access to this project.

## IMPORTANT: Follow User Instructions Exactly
- Do EXACTLY what the user asks - complete the ENTIRE task
- If user says "create a website" -> create ALL necessary files (HTML, CSS, JS, etc.)
- If user says "create folder X" -> use create_directory tool
- If user says "delete file X" -> use delete_file tool
- Do NOT stop after just 1-2 tool calls unless the task is trivially simple
- Complex tasks (like creating websites) require MANY tool calls to complete
- The user may write in any language - understand and execute
- Tool names and parameters must ALWAYS be in English
- KEEP WORKING until the entire task is finished - do not stop prematurely

## Available Tools
${formatToolDefinitions()}

## Tool Call Format
When you need to use a tool, respond with:
<tool_call>
{"tool": "tool_name", "parameters": {"param1": "value1"}}
</tool_call>

## Examples
<tool_call>
{"tool": "create_directory", "parameters": {"path": "my-folder"}}
</tool_call>

<tool_call>
{"tool": "write_file", "parameters": {"path": "test/index.html", "content": "<!DOCTYPE html>..."}}
</tool_call>

## Rules
1. Use the exact format shown above
2. Always read files before editing
3. When done, respond WITHOUT tool calls

## Project: ${projectContext.name} (${projectContext.type})
${projectContext.structure}

You have FULL access. Execute tasks autonomously.`;
}

// Response from agent chat - includes both content and tool calls
interface AgentChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usedNativeTools: boolean;
}

/**
 * Make a chat API call for agent mode with native tool support
 */
async function agentChat(
  messages: Message[],
  systemPrompt: string,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal
): Promise<AgentChatResponse> {
  const protocol = config.get('protocol');
  const model = config.get('model');
  const apiKey = getApiKey();
  const providerId = config.get('provider');
  
  const baseUrl = getProviderBaseUrl(providerId, protocol);
  const authHeader = getProviderAuthHeader(providerId, protocol);
  
  if (!baseUrl) {
    throw new Error(`Provider ${providerId} does not support ${protocol} protocol`);
  }
  
  // Check if provider supports native tools - if not, use text-based fallback directly
  if (!supportsNativeTools(providerId, protocol)) {
    // Provider doesn't support native tools, use text-based fallback
    return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
  }
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.get('apiTimeout'));
  
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }
  
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  
  try {
    let endpoint: string;
    let body: Record<string, unknown>;
    
    if (protocol === 'openai') {
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        tools: getOpenAITools(),
        tool_choice: 'auto',
        temperature: config.get('temperature'),
        max_tokens: config.get('maxTokens'),
      };
    } else {
      endpoint = `${baseUrl}/v1/messages`;
      body = {
        model,
        system: systemPrompt,
        messages: messages,
        tools: getAnthropicTools(),
        temperature: config.get('temperature'),
        max_tokens: config.get('maxTokens'),
      };
    }
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      
      // Check if error is due to tools not being supported - fallback to text mode
      if (errorText.includes('tools') || errorText.includes('function') || response.status === 400) {
        return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
      }
      
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (protocol === 'openai') {
      const message = data.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = parseOpenAIToolCalls(message?.tool_calls || []);
      
      if (onChunk && content) {
        onChunk(content);
      }
      
      return { content, toolCalls, usedNativeTools: true };
    } else {
      // Anthropic format
      const contentBlocks = data.content || [];
      let textContent = '';
      
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          textContent += block.text;
          if (onChunk) onChunk(block.text);
        }
      }
      
      const toolCalls = parseAnthropicToolCalls(contentBlocks);
      
      return { content: textContent, toolCalls, usedNativeTools: true };
    }
  } catch (error) {
    const err = error as Error;
    
    // If native tools failed, try fallback
    if (err.message.includes('tools') || err.message.includes('function')) {
      return await agentChatFallback(messages, systemPrompt, onChunk, abortSignal);
    }
    
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback chat without native tools (text-based parsing)
 */
async function agentChatFallback(
  messages: Message[],
  systemPrompt: string,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal
): Promise<AgentChatResponse> {
  const protocol = config.get('protocol');
  const model = config.get('model');
  const apiKey = getApiKey();
  const providerId = config.get('provider');
  
  const baseUrl = getProviderBaseUrl(providerId, protocol);
  const authHeader = getProviderAuthHeader(providerId, protocol);
  
  if (!baseUrl) {
    throw new Error(`Provider ${providerId} does not support ${protocol} protocol`);
  }
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.get('apiTimeout'));
  
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }
  
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  
  // Use fallback system prompt with text-based tool format
  const fallbackPrompt = systemPrompt.includes('## Available Tools') 
    ? systemPrompt 
    : systemPrompt + '\n\n' + formatToolDefinitions();
  
  try {
    let endpoint: string;
    let body: Record<string, unknown>;
    
    if (protocol === 'openai') {
      endpoint = `${baseUrl}/chat/completions`;
      body = {
        model,
        messages: [
          { role: 'system', content: fallbackPrompt },
          ...messages,
        ],
        stream: Boolean(onChunk),
        temperature: config.get('temperature'),
        max_tokens: config.get('maxTokens'),
      };
    } else {
      endpoint = `${baseUrl}/v1/messages`;
      body = {
        model,
        messages: [
          { role: 'user', content: fallbackPrompt },
          { role: 'assistant', content: 'Understood. I will use the tools as specified.' },
          ...messages,
        ],
        stream: Boolean(onChunk),
        temperature: config.get('temperature'),
        max_tokens: config.get('maxTokens'),
      };
    }
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }
    
    let content: string;
    
    if (onChunk && response.body) {
      content = await handleStream(response.body, protocol, onChunk);
    } else {
      const data = await response.json();
      if (protocol === 'openai') {
        content = data.choices?.[0]?.message?.content || '';
      } else {
        content = data.content?.[0]?.text || '';
      }
    }
    
    // Parse tool calls from text response
    const toolCalls = parseToolCalls(content);
    
    return { content, toolCalls, usedNativeTools: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Handle streaming response
 */
async function handleStream(
  body: ReadableStream<Uint8Array>,
  protocol: string,
  onChunk: (chunk: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(data);
          let content: string | undefined;
          
          if (protocol === 'openai') {
            content = parsed.choices?.[0]?.delta?.content;
          } else if (parsed.type === 'content_block_delta') {
            content = parsed.delta?.text;
          }
          
          if (content) {
            chunks.push(content);
            onChunk(content);
          }
        } catch {
          // Skip parse errors
        }
      }
    }
  }
  
  return chunks.join('');
}

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
  
  // Task planning phase (if enabled and prompt is complex enough)
  let taskPlan: TaskPlan | null = null;
  if (opts.usePlanning && prompt.split(' ').length > 5) {
    try {
      opts.onIteration?.(0, 'Planning tasks...');
      taskPlan = await planTasks(prompt, {
        name: projectContext.name,
        type: projectContext.type,
        structure: projectContext.structure,
      });
      
      if (taskPlan.tasks.length > 1) {
        opts.onTaskPlan?.(taskPlan);
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
  if (smartContextStr) {
    systemPrompt += '\n\n' + smartContextStr;
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
      
      // Get AI response
      let chatResponse: AgentChatResponse;
      try {
        chatResponse = await agentChat(
          messages,
          systemPrompt,
          opts.onThinking,
          opts.abortSignal
        );
      } catch (error) {
        const err = error as Error;
        if (err.name === 'AbortError') {
          result = {
            success: false,
            iterations: iteration,
            actions,
            finalResponse: 'Agent was stopped',
            aborted: true,
          };
          return result;
        }
        throw error;
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
      
      // If no tool calls, check if this is really the final response
      // Don't exit on first iteration without tool calls - agent might be thinking
      if (toolCalls.length === 0) {
        // Only accept as final response if:
        // 1. We've done at least some work (iteration > 2)
        // 2. Agent explicitly indicates completion
        const completionIndicators = [
          'task is complete',
          'all files have been created',
          'website has been created',
          'successfully completed',
          'everything is ready',
          'all done'
        ];
        const lowerContent = content.toLowerCase();
        const indicatesCompletion = completionIndicators.some(indicator => lowerContent.includes(indicator));
        
        if (iteration > 2 && indicatesCompletion) {
          // Remove <think>...</think> tags from response
          finalResponse = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          break;
        } else if (iteration <= 2) {
          // Too early to quit - remind agent to continue
          messages.push({ role: 'assistant', content });
          messages.push({ 
            role: 'user', 
            content: 'Continue with the task. Use the tools to complete what was requested. Do not stop until all files are created and the task is fully complete.' 
          });
          continue;
        } else {
          // Later iteration without completion indicator - accept as final
          finalResponse = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          break;
        }
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
          toolResult = executeTool(toolCall, projectContext.root || process.cwd());
        }
        
        opts.onToolResult?.(toolResult);
        
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
      const nextStepPrompt = iteration < 5 
        ? `Tool results:\n\n${toolResults.join('\n\n')}\n\nGood progress! Continue working on the task. Use more tools to complete what was requested. Only stop when EVERYTHING is finished and working.`
        : `Tool results:\n\n${toolResults.join('\n\n')}\n\nContinue with the task. If the task is fully complete, provide a final summary without any tool calls.`;
      
      messages.push({
        role: 'user',
        content: nextStepPrompt,
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
              
              const toolResult = executeTool(toolCall, projectContext.root || process.cwd());
              opts.onToolResult?.(toolResult);
              
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
