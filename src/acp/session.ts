// acp/session.ts
// Bridges ACP parameters to the Codeep agent loop.

import { join, isAbsolute } from 'path';
import { runAgent } from '../utils/agent.js';
import { getProjectContext, ProjectContext } from '../utils/project.js';

export interface AgentSessionOptions {
  prompt: string;
  workspaceRoot: string;
  conversationId: string;
  abortSignal: AbortSignal;
  onChunk: (text: string) => void;
  onThought?: (text: string) => void;
  onToolCall?: (toolCallId: string, toolName: string, kind: string, title: string, status: 'pending' | 'running' | 'finished' | 'error', locations?: string[], rawOutput?: string) => void;
}

/**
 * Build a ProjectContext from a workspace root directory.
 * Falls back to a minimal synthetic context if scanning fails.
 */
export function buildProjectContext(workspaceRoot: string): ProjectContext {
  const ctx = getProjectContext(workspaceRoot);
  if (ctx) {
    return ctx;
  }

  // Minimal fallback so runAgent never receives null
  return {
    root: workspaceRoot,
    name: workspaceRoot.split('/').pop() ?? 'workspace',
    type: 'Unknown',
    structure: '',
    keyFiles: [],
    fileCount: 0,
    summary: `Workspace at ${workspaceRoot}`,
  };
}

// Maps internal tool names to ACP tool_call kind values and human titles.
function toolCallMeta(toolName: string, params: Record<string, string>, workspaceRoot: string): { kind: string; title: string } {
  const file = params.path ?? params.file ?? '';
  // Use full path for edit tools (Zed renders it as a clickable file link)
  const absFile = file
    ? (isAbsolute(file) ? file : join(workspaceRoot, file))
    : '';
  const basename = absFile ? absFile.split('/').pop() ?? '' : '';
  switch (toolName) {
    case 'read_file':        return { kind: 'read',    title: `Reading ${basename}` };
    case 'write_file':       return { kind: 'edit',    title: absFile ? `Edit ${absFile}` : 'Writing file' };
    case 'edit_file':        return { kind: 'edit',    title: absFile ? `Edit ${absFile}` : 'Editing file' };
    case 'delete_file':      return { kind: 'delete',  title: `Deleting ${basename}` };
    case 'move_file':        return { kind: 'move',    title: `Moving ${basename}` };
    case 'list_files':       return { kind: 'read',    title: `Listing ${basename || 'files'}` };
    case 'create_directory': return { kind: 'edit',    title: `Creating dir ${basename}` };
    case 'search_code':      return { kind: 'search',  title: `Searching ${params.pattern ?? 'code'}` };
    case 'find_files':       return { kind: 'search',  title: `Finding ${params.pattern ?? 'files'}` };
    case 'execute_command':  return { kind: 'execute', title: params.command ?? 'Running command' };
    case 'fetch_url':        return { kind: 'fetch',   title: `Fetching ${params.url ?? ''}` };
    case 'web_search':       return { kind: 'fetch',   title: `Searching ${params.query ?? ''}` };
    case 'web_read':         return { kind: 'fetch',   title: `Reading ${params.url ?? ''}` };
    default:                 return { kind: 'other',   title: toolName };
  }
}

// Builds rawOutput content to display inside tool call cards.
// For write/edit operations, returns the code content or diff.
// For command execution, returns the command output.
function buildRawOutput(
  toolName: string,
  params: Record<string, string>,
  toolResult: { success: boolean; output: string; error?: string }
): string | undefined {
  switch (toolName) {
    case 'write_file': {
      const content = params.content ?? '';
      return content || undefined;
    }
    case 'edit_file': {
      const oldText = params.old_text ?? '';
      const newText = params.new_text ?? '';
      if (!oldText && !newText) return undefined;
      // Format as a simple before/after diff block
      const oldLines = oldText.split('\n').map(l => `- ${l}`).join('\n');
      const newLines = newText.split('\n').map(l => `+ ${l}`).join('\n');
      return `${oldLines}\n${newLines}`;
    }
    case 'execute_command': {
      return toolResult.output || toolResult.error || undefined;
    }
    case 'read_file': {
      return toolResult.output || undefined;
    }
    default:
      return undefined;
  }
}

export async function runAgentSession(opts: AgentSessionOptions): Promise<void> {
  const projectContext = buildProjectContext(opts.workspaceRoot);
  let toolCallCounter = 0;
  // Maps tool call key → ACP toolCallId so onToolResult can emit finished/error status
  const toolCallIdMap = new Map<string, { toolCallId: string; kind: string; locations?: string[] }>();

  let chunksEmitted = 0;
  const result = await runAgent(opts.prompt, projectContext, {
    abortSignal: opts.abortSignal,
    onChunk: (text: string) => { chunksEmitted++; opts.onChunk(text); },
    onIteration: (_iteration: number, _message: string) => {
      // Intentionally not forwarded — iteration count is internal detail
    },
    onThinking: (text: string) => {
      if (opts.onThought) {
        opts.onThought(text);
      }
    },
    onToolCall: (toolCall) => {
      const name = toolCall.tool;
      const params = (toolCall.parameters ?? {}) as Record<string, string>;
      const { kind, title } = toolCallMeta(name, params, opts.workspaceRoot);
      const toolCallId = `tc_${++toolCallCounter}`;

      // Resolve file locations for edit/read/delete/move tools
      // ToolCallLocation.path expects a filesystem path, not a file:// URI
      const locations: string[] = [];
      const filePath = params.path ?? params.file ?? '';
      if (filePath) {
        const absPath = isAbsolute(filePath)
          ? filePath
          : join(opts.workspaceRoot, filePath);
        locations.push(absPath);
      }

      // Track this tool call so onToolResult can emit finished/error
      const mapKey = toolCall.id ?? `${name}_${toolCallCounter}`;
      toolCallIdMap.set(mapKey, { toolCallId, kind, locations: locations.length ? locations : undefined });

      // Emit tool_call notification (running state)
      opts.onToolCall?.(toolCallId, name, kind, title, 'running', locations.length ? locations : undefined);

    },
    onToolResult: (toolResult, toolCall) => {
      // Find the tracked entry: prefer exact id match, then first FIFO entry for same tool name
      let mapKey: string | undefined;
      if (toolCall.id && toolCallIdMap.has(toolCall.id)) {
        mapKey = toolCall.id;
      } else {
        // FIFO: find oldest pending entry for this tool name
        for (const [k, v] of toolCallIdMap) {
          if (k.startsWith(`${toolCall.tool}_`) && v.toolCallId) {
            mapKey = k;
            break;
          }
        }
      }
      if (mapKey !== undefined) {
        const tracked = toolCallIdMap.get(mapKey);
        if (tracked && opts.onToolCall) {
          const status = toolResult.success ? 'finished' : 'error';
          const rawOutput = buildRawOutput(toolCall.tool, toolCall.parameters as Record<string, string>, toolResult);
          opts.onToolCall(tracked.toolCallId, toolCall.tool, tracked.kind, '', status, tracked.locations, rawOutput);
        }
        toolCallIdMap.delete(mapKey);
      }
    },
  });

  // result.finalResponse is already emitted via onChunk streaming above;
  // only emit it here if nothing was streamed (e.g. non-streaming fallback path)
  if (result.finalResponse && chunksEmitted === 0) {
    opts.onChunk(result.finalResponse);
  }

  // Surface errors as thrown exceptions so index.ts can handle them correctly
  if (!result.success && !result.aborted) {
    throw new Error(result.error ?? 'Agent run failed without a specific error message');
  }

  if (result.aborted) {
    const abortError = new Error('Agent session was cancelled');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

