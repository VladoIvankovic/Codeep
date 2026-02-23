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

/**
 * Run a single agent session driven by ACP parameters.
 *
 * onFileEdit is reserved for future use (v1 emits everything via onChunk).
 */
export async function runAgentSession(opts: AgentSessionOptions): Promise<void> {
  const projectContext = buildProjectContext(opts.workspaceRoot);

  const result = await runAgent(opts.prompt, projectContext, {
    abortSignal: opts.abortSignal,
    onIteration: (_iteration: number, message: string) => {
      opts.onChunk(message + '\n');
    },
    onThinking: (text: string) => {
      opts.onChunk(text);
    },
    onToolCall: (toolCall) => {
      // Notify the caller when agent writes or edits a file so ACP can
      // send a structured file/edit notification to the editor.
      const name = toolCall.tool;
      if (name === 'write_file' || name === 'edit_file') {
        const params = toolCall.parameters as Record<string, string>;
        const filePath = params.path ?? '';
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
