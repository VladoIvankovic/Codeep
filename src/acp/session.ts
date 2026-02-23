// acp/session.ts
// Bridges ACP parameters to the Codeep agent loop.

import { pathToFileURL } from 'url';
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
  onToolCall?: (toolCallId: string, toolName: string, kind: string, title: string, status: 'pending' | 'running' | 'finished' | 'error', locations?: string[]) => void;
  onFileEdit: (uri: string, newText: string) => void;
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
function toolCallMeta(toolName: string, params: Record<string, string>): { kind: string; title: string } {
  const file = params.path ?? params.file ?? '';
  const label = file ? ` ${file.split('/').pop()}` : '';
  switch (toolName) {
    case 'read_file':    return { kind: 'read',    title: `Reading${label}` };
    case 'write_file':   return { kind: 'edit',    title: `Writing${label}` };
    case 'edit_file':    return { kind: 'edit',    title: `Editing${label}` };
    case 'delete_file':  return { kind: 'delete',  title: `Deleting${label}` };
    case 'move_file':    return { kind: 'move',    title: `Moving${label}` };
    case 'list_files':   return { kind: 'read',    title: `Listing files${label}` };
    case 'search_files': return { kind: 'search',  title: `Searching${label || ' files'}` };
    case 'run_command':  return { kind: 'execute', title: `Running: ${params.command ?? ''}` };
    case 'web_fetch':    return { kind: 'fetch',   title: `Fetching ${params.url ?? ''}` };
    default:             return { kind: 'other',   title: toolName };
  }
}

export async function runAgentSession(opts: AgentSessionOptions): Promise<void> {
  const projectContext = buildProjectContext(opts.workspaceRoot);
  let toolCallCounter = 0;

  const result = await runAgent(opts.prompt, projectContext, {
    abortSignal: opts.abortSignal,
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
      const { kind, title } = toolCallMeta(name, params);
      const toolCallId = `tc_${++toolCallCounter}`;

      // Resolve file locations for edit/read/delete/move tools
      const locations: string[] = [];
      const filePath = params.path ?? params.file ?? '';
      if (filePath) {
        const absPath = isAbsolute(filePath)
          ? filePath
          : join(opts.workspaceRoot, filePath);
        locations.push(pathToFileURL(absPath).href);
      }

      // Emit tool_call notification (running state)
      opts.onToolCall?.(toolCallId, name, kind, title, 'running', locations.length ? locations : undefined);

      // For file edits, also send structured file/edit notification
      if (name === 'write_file' || name === 'edit_file') {
        if (filePath) {
          const absPath = isAbsolute(filePath)
            ? filePath
            : join(opts.workspaceRoot, filePath);
          const newText = params.content ?? params.new_text ?? '';
          opts.onFileEdit(pathToFileURL(absPath).href, newText);
        }
      }
    },
  });

  // Emit the final response text if present
  if (result.finalResponse) {
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

// Utility: convert an absolute file-system path to a file:// URI string.
// Exported for use by callers that need to construct applyEdit URIs.
export function pathToUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}
