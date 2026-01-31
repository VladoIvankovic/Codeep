/**
 * Agent progress display component
 * Optimized with isolated spinner animation and memoization
 */

import React, { useState, useEffect, useRef, memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import { ActionLog } from '../utils/tools';

// Spinner frames for animation (no emojis)
const SPINNER_FRAMES = ['/', '-', '\\', '|'];

/**
 * Isolated spinner component - animation doesn't cause parent re-renders
 */
const AgentSpinner: React.FC<{ color?: string }> = memo(({ color = '#f02a30' }) => {
  const [frame, setFrame] = useState(0);
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 150);
    return () => clearInterval(timer);
  }, []);
  
  return <Text color={color}>[{SPINNER_FRAMES[frame]}]</Text>;
});

AgentSpinner.displayName = 'AgentSpinner';

interface AgentProgressProps {
  isRunning: boolean;
  iteration: number;
  maxIterations: number;
  actions: ActionLog[];
  currentThinking?: string;
  dryRun?: boolean;
}

export const AgentProgress: React.FC<AgentProgressProps> = memo(({
  isRunning,
  iteration,
  maxIterations,
  actions,
  currentThinking,
  dryRun,
}) => {
  
  // Don't show anything if not running and no actions
  if (!isRunning && actions.length === 0) {
    return null;
  }
  
  // Show last 5 actions (more compact)
  const recentActions = actions.slice(-5);
  
  // Get current/last action for prominent display
  const currentAction = actions.length > 0 ? actions[actions.length - 1] : null;
  
  // Count actions by type
  const actionCounts = {
    reads: actions.filter(a => a.type === 'read').length,
    writes: actions.filter(a => a.type === 'write').length,
    edits: actions.filter(a => a.type === 'edit').length,
    commands: actions.filter(a => a.type === 'command').length,
    searches: actions.filter(a => a.type === 'search').length,
  };
  
  // Count file changes
  const fileChanges = {
    created: actions.filter(a => a.type === 'write' && a.result === 'success').length,
    modified: actions.filter(a => a.type === 'edit' && a.result === 'success').length,
    deleted: actions.filter(a => a.type === 'delete' && a.result === 'success').length,
  };
  const totalFileChanges = fileChanges.created + fileChanges.modified + fileChanges.deleted;
  
  return (
    <Box 
      flexDirection="column" 
      borderStyle="round" 
      borderColor={dryRun ? 'yellow' : '#f02a30'} 
      paddingX={1}
      marginY={1}
    >
      {/* Header */}
      <Box>
        {isRunning ? (
          <>
            <AgentSpinner color={dryRun ? 'yellow' : '#f02a30'} />
            <Text color={dryRun ? 'yellow' : '#f02a30'} bold>
              {' '}{dryRun ? 'DRY RUN' : 'AGENT'}{' '}
            </Text>
            <Text color="cyan">|</Text>
            <Text color="cyan"> step {iteration}</Text>
            <Text color="cyan"> | </Text>
            {actionCounts.reads > 0 && <Text color="blue">{actionCounts.reads}R </Text>}
            {actionCounts.writes > 0 && <Text color="green">{actionCounts.writes}W </Text>}
            {actionCounts.edits > 0 && <Text color="yellow">{actionCounts.edits}E </Text>}
            {actionCounts.commands > 0 && <Text color="magenta">{actionCounts.commands}C </Text>}
            {actionCounts.searches > 0 && <Text color="cyan">{actionCounts.searches}S </Text>}
            {actions.length === 0 && <Text color="cyan">0 actions</Text>}
          </>
        ) : (
          <>
            <Text color="green" bold>[DONE] </Text>
            <Text>Agent completed</Text>
            <Text color="cyan"> | </Text>
            <Text color="white">{actions.length} actions</Text>
          </>
        )}
      </Box>
      
      {/* Current action - simple display without code preview */}
      {isRunning && currentAction && (
        <Box marginTop={1}>
          <Text color="white" bold>Now: </Text>
          <Text color={getActionColor(currentAction.type)}>{getActionLabel(currentAction.type)} </Text>
          <Text color="white">{formatTarget(currentAction.target)}</Text>
        </Box>
      )}
      
      {/* Divider */}
      <Text color="cyan">{'─'.repeat(50)}</Text>
      
      {/* Recent actions list - show previous actions */}
      {recentActions.length > 1 && (
        <Box flexDirection="column">
          <Text color="cyan" dimColor>Recent:</Text>
          {recentActions.slice(0, -1).map((action, i) => (
            <ActionItem key={i} action={action} />
          ))}
        </Box>
      )}
      
      {/* File changes summary - show during run */}
      {isRunning && totalFileChanges > 0 && (
        <Box marginTop={1}>
          <Text color="cyan">Changes: </Text>
          {fileChanges.created > 0 && <Text color="green">+{fileChanges.created} </Text>}
          {fileChanges.modified > 0 && <Text color="yellow">~{fileChanges.modified} </Text>}
          {fileChanges.deleted > 0 && <Text color="red">-{fileChanges.deleted}</Text>}
        </Box>
      )}
      
      {/* Current thinking - truncated */}
      {isRunning && currentThinking && (
        <Box marginTop={1}>
          <Text color="cyan" wrap="truncate-end">
            &gt; {currentThinking.slice(0, 80)}{currentThinking.length > 80 ? '...' : ''}
          </Text>
        </Box>
      )}
      
      {/* Footer - how to stop */}
      {isRunning && (
        <Box marginTop={1}>
          <Text color="cyan">Press </Text>
          <Text color="#f02a30">Esc</Text>
          <Text color="cyan"> to stop</Text>
        </Box>
      )}
      
      {/* Show summary when done */}
      {!isRunning && totalFileChanges > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>File Changes:</Text>
          {fileChanges.created > 0 && (
            <Text color="green">  + {fileChanges.created} file(s) created</Text>
          )}
          {fileChanges.modified > 0 && (
            <Text color="yellow">  ~ {fileChanges.modified} file(s) modified</Text>
          )}
          {fileChanges.deleted > 0 && (
            <Text color="red">  - {fileChanges.deleted} file(s) deleted</Text>
          )}
        </Box>
      )}
    </Box>
  );
});

AgentProgress.displayName = 'AgentProgress';

// Get file extension for language detection
const getFileExtension = (filename: string): string => {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
};

// Get language label from extension
const getLanguageLabel = (ext: string): string => {
  const langMap: Record<string, string> = {
    'js': 'JavaScript',
    'jsx': 'React JSX',
    'ts': 'TypeScript',
    'tsx': 'React TSX',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'json': 'JSON',
    'md': 'Markdown',
    'py': 'Python',
    'rb': 'Ruby',
    'go': 'Go',
    'rs': 'Rust',
    'java': 'Java',
    'kt': 'Kotlin',
    'swift': 'Swift',
    'php': 'PHP',
    'sql': 'SQL',
    'sh': 'Shell',
    'bash': 'Bash',
    'yml': 'YAML',
    'yaml': 'YAML',
    'xml': 'XML',
    'vue': 'Vue',
    'svelte': 'Svelte',
  };
  return langMap[ext] || ext.toUpperCase();
};

// Enhanced syntax highlighting with more colors
const getCodeColor = (line: string, ext: string): string => {
  const trimmed = line.trim();
  
  // Empty lines
  if (!trimmed) return 'gray';
  
  // Comments - multiple styles
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || 
      trimmed.startsWith('*') || trimmed.startsWith('<!--') || trimmed.startsWith('"""') ||
      trimmed.startsWith("'''")) {
    return 'gray';
  }
  
  // Import/export statements
  if (/^(import|export|from|require)\b/.test(trimmed)) {
    return 'magenta';
  }
  
  // Function/class definitions
  if (/^(function|class|interface|type|enum|const\s+\w+\s*=\s*(\(|async)|def |class |fn |func |pub fn)\b/.test(trimmed)) {
    return 'yellow';
  }
  
  // Control flow keywords
  if (/^(if|else|for|while|switch|case|try|catch|finally|return|throw|break|continue|async|await)\b/.test(trimmed)) {
    return 'blue';
  }
  
  // Variable declarations
  if (/^(const|let|var|val|mut)\b/.test(trimmed)) {
    return 'cyan';
  }
  
  // HTML/JSX tags
  if ((ext === 'html' || ext === 'jsx' || ext === 'tsx' || ext === 'vue' || ext === 'svelte') &&
      (trimmed.startsWith('<') || trimmed.startsWith('</'))) {
    return 'cyan';
  }
  
  // CSS selectors and properties
  if ((ext === 'css' || ext === 'scss') && (trimmed.includes('{') || trimmed.includes(':'))) {
    return 'green';
  }
  
  // JSON keys
  if (ext === 'json' && trimmed.includes(':')) {
    return 'cyan';
  }
  
  // Strings (but not the whole line)
  if (/["'`]/.test(trimmed)) {
    return 'green';
  }
  
  return 'white';
};

// Check if line is a section separator (empty or comment-only)
const isSectionBreak = (line: string, prevLine: string | null): boolean => {
  const trimmed = line.trim();
  const prevTrimmed = prevLine?.trim() || '';
  
  // Empty line after non-empty line
  if (!trimmed && prevTrimmed) return true;
  
  // Comment after code
  if ((trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) &&
      prevTrimmed && !prevTrimmed.startsWith('//') && !prevTrimmed.startsWith('#')) {
    return true;
  }
  
  return false;
};

/**
 * Live Code Stream component - shows current file operation with live preview
 * 
 * KEY DESIGN: This component always renders exactly MAX_LINES lines
 * - While running: shows live code preview
 * - When finished: shows summary statistics
 * - This prevents ghost content and terminal jumping because height is constant
 */
interface LiveCodeStreamProps {
  actions: ActionLog[];
  isRunning: boolean;
  terminalWidth?: number;
}

const MAX_PREVIEW_LINES = 12; // Code preview lines for live streaming

export const LiveCodeStream: React.FC<LiveCodeStreamProps> = memo(({ actions, isRunning, terminalWidth = 80 }) => {
  // Find the current write/edit action for live preview (skip read actions)
  const currentAction = actions.length > 0 ? actions[actions.length - 1] : null;
  const isCodeAction = currentAction && (currentAction.type === 'write' || currentAction.type === 'edit');
  
  // Skip rendering for read actions - no preview needed
  const isReadAction = currentAction && currentAction.type === 'read';
  
  // ALL HOOKS MUST BE CALLED BEFORE ANY EARLY RETURNS (Rules of Hooks)
  
  // Calculate statistics from all actions
  const stats = useMemo(() => {
    const filesCreated = actions.filter(a => a.type === 'write' && a.result === 'success');
    const filesEdited = actions.filter(a => a.type === 'edit' && a.result === 'success');
    const filesDeleted = actions.filter(a => a.type === 'delete' && a.result === 'success');
    const filesRead = actions.filter(a => a.type === 'read' && a.result === 'success');
    const commands = actions.filter(a => a.type === 'command' && a.result === 'success');
    const errors = actions.filter(a => a.result === 'error');
    
    // Calculate total lines written
    let totalLinesWritten = 0;
    for (const action of [...filesCreated, ...filesEdited]) {
      if (action.details) {
        totalLinesWritten += action.details.split('\n').length;
      }
    }
    
    return {
      filesCreated: filesCreated.length,
      filesEdited: filesEdited.length,
      filesDeleted: filesDeleted.length,
      filesRead: filesRead.length,
      commands: commands.length,
      errors: errors.length,
      totalLinesWritten,
      createdFiles: filesCreated.map(a => a.target.split('/').pop() || a.target),
      editedFiles: filesEdited.map(a => a.target.split('/').pop() || a.target),
    };
  }, [actions]);
  
  // Get code lines for preview
  const codeLines = useMemo(() => {
    if (!isCodeAction || !currentAction?.details) return [];
    return currentAction.details.split('\n');
  }, [isCodeAction, currentAction?.details]);
  
  // Don't render anything if no actions yet (agent just started)
  if (actions.length === 0) {
    return null;
  }
  
  const filename = currentAction?.target.split('/').pop() || '';
  const ext = getFileExtension(filename);
  const langLabel = getLanguageLabel(ext);
  
  // RUNNING STATE: Show live code preview
  if (isRunning && isCodeAction && codeLines.length > 0) {
    // Show last N lines of code being written
    const visibleLines = codeLines.slice(-MAX_PREVIEW_LINES);
    const hiddenCount = Math.max(0, codeLines.length - MAX_PREVIEW_LINES);
    
    const actionIcon = currentAction.type === 'write' ? '+' : '~';
    const actionColor = currentAction.type === 'write' ? 'green' : 'yellow';
    const boxWidth = Math.min(terminalWidth - 4, 76);
    
    return (
      <Box 
        flexDirection="column" 
        borderStyle="round" 
        borderColor={actionColor}
        marginBottom={1}
        width={boxWidth}
      >
        {/* Header */}
        <Box paddingX={1}>
          <Text color={actionColor} bold>{actionIcon} </Text>
          <Text color="white" bold>{filename}</Text>
          <Text color="gray"> • {langLabel} • {codeLines.length} lines</Text>
        </Box>
        
        {/* Code preview */}
        <Box flexDirection="column" paddingX={1}>
          {hiddenCount > 0 && (
            <Text color="gray" dimColor>  ... {hiddenCount} more lines above</Text>
          )}
          {visibleLines.map((line, i) => {
            const lineNum = hiddenCount + i + 1;
            const displayLine = line.length > boxWidth - 10 
              ? line.slice(0, boxWidth - 13) + '...' 
              : line;
            return (
              <Text key={i}>
                <Text color="gray" dimColor>{String(lineNum).padStart(3)} </Text>
                <Text color={getCodeColor(line, ext)}>{displayLine || ' '}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }
  
  // RUNNING STATE but not a code action (and not read): show simple status
  // Skip showing box for read actions - they don't need preview
  if (isRunning && currentAction && !isReadAction) {
    const boxWidth = Math.min(terminalWidth - 4, 76);
    
    return (
      <Box 
        flexDirection="column" 
        borderStyle="round" 
        borderColor="cyan"
        marginBottom={1}
        width={boxWidth}
      >
        <Box paddingX={1}>
          <Text color="cyan" bold>◦ </Text>
          <Text color={getActionColor(currentAction.type)}>{getActionLabel(currentAction.type)} </Text>
          <Text color="white">{formatTarget(currentAction.target)}</Text>
        </Box>
      </Box>
    );
  }
  
  // For read actions while running, don't show anything
  if (isRunning && isReadAction) {
    return null;
  }
  
  // FINISHED STATE: Show summary statistics (same height as live preview)
  const boxWidth = Math.min(terminalWidth - 4, 76);
  const hasChanges = stats.filesCreated > 0 || stats.filesEdited > 0 || stats.filesDeleted > 0;
  
  return (
    <Box 
      flexDirection="column" 
      borderStyle="round" 
      borderColor={stats.errors > 0 ? 'red' : 'green'}
      marginBottom={1}
      width={boxWidth}
    >
      {/* Header */}
      <Box paddingX={1}>
        <Text color={stats.errors > 0 ? 'red' : 'green'} bold>
          {stats.errors > 0 ? '!' : '✓'} Session Complete
        </Text>
        <Text color="gray"> • {actions.length} actions</Text>
      </Box>
      
      {/* Statistics */}
      <Box flexDirection="column" paddingX={1}>
        {hasChanges ? (
          <>
            {stats.filesCreated > 0 && (
              <Text>
                <Text color="green" bold>  + {stats.filesCreated} </Text>
                <Text color="gray">file(s) created</Text>
                {stats.createdFiles.length <= 3 && (
                  <Text color="gray" dimColor> ({stats.createdFiles.join(', ')})</Text>
                )}
              </Text>
            )}
            {stats.filesEdited > 0 && (
              <Text>
                <Text color="yellow" bold>  ~ {stats.filesEdited} </Text>
                <Text color="gray">file(s) modified</Text>
                {stats.editedFiles.length <= 3 && (
                  <Text color="gray" dimColor> ({stats.editedFiles.join(', ')})</Text>
                )}
              </Text>
            )}
            {stats.filesDeleted > 0 && (
              <Text>
                <Text color="red" bold>  - {stats.filesDeleted} </Text>
                <Text color="gray">file(s) deleted</Text>
              </Text>
            )}
            {stats.totalLinesWritten > 0 && (
              <Text>
                <Text color="cyan" bold>  ≡ {stats.totalLinesWritten} </Text>
                <Text color="gray">total lines written</Text>
              </Text>
            )}
            {stats.filesRead > 0 && (
              <Text color="gray" dimColor>    {stats.filesRead} file(s) read</Text>
            )}
            {stats.commands > 0 && (
              <Text color="gray" dimColor>    {stats.commands} command(s) run</Text>
            )}
          </>
        ) : (
          <>
            <Text color="gray">  No file changes made</Text>
            {stats.filesRead > 0 && (
              <Text color="gray" dimColor>    {stats.filesRead} file(s) read</Text>
            )}
            {stats.commands > 0 && (
              <Text color="gray" dimColor>    {stats.commands} command(s) run</Text>
            )}
          </>
        )}
        {stats.errors > 0 && (
          <Text color="red">  ✗ {stats.errors} error(s) occurred</Text>
        )}
        
        {/* Pad with empty lines to maintain constant height */}
        {Array.from({ length: Math.max(0, MAX_PREVIEW_LINES - 6) }).map((_, i) => (
          <Text key={`pad-${i}`} color="gray" dimColor> </Text>
        ))}
      </Box>
    </Box>
  );
});

LiveCodeStream.displayName = 'LiveCodeStream';

// Helper functions for action display
const getActionColor = (type: string): string => {
  switch (type) {
    case 'read': return 'blue';
    case 'write': return 'green';
    case 'edit': return 'yellow';
    case 'delete': return 'red';
    case 'command': return 'magenta';
    case 'search': return 'cyan';
    case 'list': return 'white';
    case 'mkdir': return 'blue';
    case 'fetch': return 'cyan';
    default: return 'white';
  }
};

const getActionLabel = (type: string): string => {
  switch (type) {
    case 'read': return 'Reading';
    case 'write': return 'Creating';
    case 'edit': return 'Editing';
    case 'delete': return 'Deleting';
    case 'command': return 'Running';
    case 'search': return 'Searching';
    case 'list': return 'Listing';
    case 'mkdir': return 'Creating dir';
    case 'fetch': return 'Fetching';
    default: return type.toUpperCase();
  }
};

const formatTarget = (target: string): string => {
  // For file paths, show just the filename or last part
  if (target.includes('/')) {
    const parts = target.split('/');
    const filename = parts[parts.length - 1];
    if (parts.length > 2) {
      return `.../${parts[parts.length - 2]}/${filename}`;
    }
    return target.length > 50 ? '...' + target.slice(-47) : target;
  }
  return target.length > 50 ? target.slice(0, 47) + '...' : target;
};

/**
 * Single action item display
 */
const ActionItem: React.FC<{ action: ActionLog }> = ({ action }) => {
  const getStatusIndicator = () => {
    switch (action.result) {
      case 'success':
        return <Text color="green">✓</Text>;
      case 'error':
        return <Text color="red">✗</Text>;
      default:
        return <Text color="yellow">·</Text>;
    }
  };
  
  return (
    <Text>
      {getStatusIndicator()}{' '}
      <Text color={getActionColor(action.type)}>{getActionLabel(action.type).padEnd(10)}</Text>{' '}
      <Text color="cyan">{formatTarget(action.target)}</Text>
    </Text>
  );
};

/**
 * Agent summary component - shown when agent completes
 */
interface AgentSummaryProps {
  success: boolean;
  iterations: number;
  actions: ActionLog[];
  error?: string;
  aborted?: boolean;
}

export const AgentSummary: React.FC<AgentSummaryProps> = memo(({
  success,
  iterations,
  actions,
  error,
  aborted,
}) => {
  const filesWritten = actions.filter(a => a.type === 'write' && a.result === 'success');
  const filesEdited = actions.filter(a => a.type === 'edit' && a.result === 'success');
  const filesDeleted = actions.filter(a => a.type === 'delete' && a.result === 'success');
  const dirsCreated = actions.filter(a => a.type === 'mkdir' && a.result === 'success');
  const commandsRun = actions.filter(a => a.type === 'command' && a.result === 'success');
  const errors = actions.filter(a => a.result === 'error');
  
  const hasFileChanges = filesWritten.length > 0 || filesEdited.length > 0 || 
                         filesDeleted.length > 0 || dirsCreated.length > 0;
  
  return (
    <Box 
      flexDirection="column" 
      borderStyle="round" 
      borderColor={success ? 'green' : aborted ? 'yellow' : 'red'} 
      padding={1} 
      marginY={1}
    >
      {/* Status header */}
      <Box>
        {success ? (
          <Text color="green" bold>[OK] Agent completed</Text>
        ) : aborted ? (
          <Text color="yellow" bold>[--] Agent stopped</Text>
        ) : (
          <Text color="red" bold>[!!] Agent failed</Text>
        )}
        <Text color="cyan"> | {iterations} iterations | {actions.length} actions</Text>
      </Box>
      
      {error && (
        <Text color="red">Error: {error}</Text>
      )}
      
      {/* File changes breakdown */}
      {hasFileChanges && (
        <>
          <Text color="cyan">{'─'.repeat(40)}</Text>
          <Text bold>Changes:</Text>
          
          {filesWritten.length > 0 && (
            <Box flexDirection="column">
              <Text color="green">+ Created ({filesWritten.length}):</Text>
              {filesWritten.map((f, i) => (
                <Text key={i} color="green">    {f.target}</Text>
              ))}
            </Box>
          )}
          
          {filesEdited.length > 0 && (
            <Box flexDirection="column">
              <Text color="yellow">~ Modified ({filesEdited.length}):</Text>
              {filesEdited.map((f, i) => (
                <Text key={i} color="yellow">    {f.target}</Text>
              ))}
            </Box>
          )}
          
          {filesDeleted.length > 0 && (
            <Box flexDirection="column">
              <Text color="red">- Deleted ({filesDeleted.length}):</Text>
              {filesDeleted.map((f, i) => (
                <Text key={i} color="red">    {f.target}</Text>
              ))}
            </Box>
          )}
          
          {dirsCreated.length > 0 && (
            <Text color="blue">+ {dirsCreated.length} director(ies) created</Text>
          )}
        </>
      )}
      
      {/* Commands summary */}
      {commandsRun.length > 0 && (
        <Text color="magenta">{commandsRun.length} command(s) executed</Text>
      )}
      
      {/* Errors */}
      {errors.length > 0 && (
        <Text color="red">{errors.length} error(s) occurred</Text>
      )}
    </Box>
  );
});

AgentSummary.displayName = 'AgentSummary';

/**
 * Changes list component - for /changes command
 */
interface ChangesListProps {
  actions: ActionLog[];
}

export const ChangesList: React.FC<ChangesListProps> = ({ actions }) => {
  const writes = actions.filter(a => a.type === 'write' && a.result === 'success');
  const edits = actions.filter(a => a.type === 'edit' && a.result === 'success');
  const deletes = actions.filter(a => a.type === 'delete' && a.result === 'success');
  const mkdirs = actions.filter(a => a.type === 'mkdir' && a.result === 'success');
  
  const totalChanges = writes.length + edits.length + deletes.length + mkdirs.length;
  
  if (totalChanges === 0) {
    return (
      <Box>
        <Text color="cyan">No file changes in current session</Text>
      </Box>
    );
  }
  
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text color="cyan" bold>Session Changes ({totalChanges} total)</Text>
      <Text color="cyan">{'─'.repeat(40)}</Text>
      
      {writes.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green" bold>Created ({writes.length}):</Text>
          {writes.map((w, i) => (
            <Text key={i}>  + {w.target}</Text>
          ))}
        </Box>
      )}
      
      {edits.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>Modified ({edits.length}):</Text>
          {edits.map((e, i) => (
            <Text key={i}>  ~ {e.target}</Text>
          ))}
        </Box>
      )}
      
      {deletes.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>Deleted ({deletes.length}):</Text>
          {deletes.map((d, i) => (
            <Text key={i}>  - {d.target}</Text>
          ))}
        </Box>
      )}
      
      {mkdirs.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="blue" bold>Directories ({mkdirs.length}):</Text>
          {mkdirs.map((m, i) => (
            <Text key={i}>  + {m.target}/</Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
