/**
 * Agent progress display component
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text } from 'ink';
import { ActionLog } from '../utils/tools';

// Spinner frames for animation (no emojis)
const SPINNER_FRAMES = ['/', '-', '\\', '|'];

interface AgentProgressProps {
  isRunning: boolean;
  iteration: number;
  maxIterations: number;
  actions: ActionLog[];
  currentThinking?: string;
  dryRun?: boolean;
}

export const AgentProgress: React.FC<AgentProgressProps> = ({
  isRunning,
  iteration,
  maxIterations,
  actions,
  currentThinking,
  dryRun,
}) => {
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  
  // Animate spinner when running
  useEffect(() => {
    if (!isRunning) return;
    
    const timer = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 150);
    
    return () => clearInterval(timer);
  }, [isRunning]);
  
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
      paddingX={1}
    >
      {/* Header */}
      <Box>
        {isRunning ? (
          <>
            <Text color={dryRun ? 'yellow' : '#f02a30'}>
              [{SPINNER_FRAMES[spinnerFrame]}]
            </Text>
            <Text color={dryRun ? 'yellow' : '#f02a30'} bold>
              {' '}{dryRun ? 'DRY RUN' : 'AGENT'}{' '}
            </Text>
            <Text color="gray">|</Text>
            <Text color="cyan"> step {iteration}</Text>
            <Text color="gray"> | </Text>
            {actionCounts.reads > 0 && <Text color="blue">{actionCounts.reads}R </Text>}
            {actionCounts.writes > 0 && <Text color="green">{actionCounts.writes}W </Text>}
            {actionCounts.edits > 0 && <Text color="yellow">{actionCounts.edits}E </Text>}
            {actionCounts.commands > 0 && <Text color="magenta">{actionCounts.commands}C </Text>}
            {actionCounts.searches > 0 && <Text color="cyan">{actionCounts.searches}S </Text>}
            {actions.length === 0 && <Text color="gray">0 actions</Text>}
          </>
        ) : (
          <>
            <Text color="green" bold>[DONE] </Text>
            <Text>Agent completed</Text>
            <Text color="gray"> | </Text>
            <Text color="white">{actions.length} actions</Text>
          </>
        )}
      </Box>
      
      {/* Current action - prominent display */}
      {isRunning && currentAction && (
        <Box marginTop={1}>
          <Text color="white" bold>Now: </Text>
          <Text color={getActionColor(currentAction.type)}>{getActionLabel(currentAction.type)} </Text>
          <Text color="white">{formatTarget(currentAction.target)}</Text>
        </Box>
      )}
      
      {/* Divider */}
      <Text color="gray">{'─'.repeat(50)}</Text>
      
      {/* Recent actions list - show previous actions */}
      {recentActions.length > 1 && (
        <Box flexDirection="column">
          <Text color="gray" dimColor>Recent:</Text>
          {recentActions.slice(0, -1).map((action, i) => (
            <ActionItem key={i} action={action} />
          ))}
        </Box>
      )}
      
      {/* File changes summary - show during run */}
      {isRunning && totalFileChanges > 0 && (
        <Box marginTop={1}>
          <Text color="gray">Changes: </Text>
          {fileChanges.created > 0 && <Text color="green">+{fileChanges.created} </Text>}
          {fileChanges.modified > 0 && <Text color="yellow">~{fileChanges.modified} </Text>}
          {fileChanges.deleted > 0 && <Text color="red">-{fileChanges.deleted}</Text>}
        </Box>
      )}
      
      {/* Current thinking - truncated */}
      {isRunning && currentThinking && (
        <Box marginTop={1}>
          <Text color="gray" wrap="truncate-end">
            &gt; {currentThinking.slice(0, 80)}{currentThinking.length > 80 ? '...' : ''}
          </Text>
        </Box>
      )}
      
      {/* Footer - how to stop */}
      {isRunning && (
        <Box marginTop={1}>
          <Text color="gray">Press </Text>
          <Text color="#f02a30">Esc</Text>
          <Text color="gray"> to stop</Text>
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
};

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
 * Live Code Stream component - shows ALL code being written/edited by agent
 * Displayed ABOVE the AgentProgress component
 * Enhanced with better syntax highlighting and visual organization
 */
interface LiveCodeStreamProps {
  actions: ActionLog[];
  isRunning: boolean;
}

export const LiveCodeStream: React.FC<LiveCodeStreamProps> = ({ actions, isRunning }) => {
  // Find the current write/edit action with code content
  const currentAction = actions.length > 0 ? actions[actions.length - 1] : null;
  
  // Only show for write/edit actions with content while running
  if (!isRunning || !currentAction) return null;
  if (currentAction.type !== 'write' && currentAction.type !== 'edit') return null;
  if (!currentAction.details) return null;
  
  const code = currentAction.details;
  const fullPath = currentAction.target;
  const filename = fullPath.split('/').pop() || fullPath;
  const ext = getFileExtension(filename);
  const langLabel = getLanguageLabel(ext);
  const allLines = code.split('\n');
  const totalLines = allLines.length;
  const actionLabel = currentAction.type === 'write' ? '✨ Creating' : '✏️  Editing';
  const actionColor = currentAction.type === 'write' ? 'green' : 'yellow';
  
  // Show last 10 lines (most recent code being written)
  const WINDOW_SIZE = 10;
  const startLine = Math.max(0, totalLines - WINDOW_SIZE);
  const linesToShow = allLines.slice(startLine, totalLines);
  const linesAbove = startLine;
  
  return (
    <Box flexDirection="column">
      {/* Header bar */}
      <Box>
        <Text color={actionColor} bold>{actionLabel} </Text>
        <Text color="white" bold>{filename}</Text>
        <Text color="gray"> • {langLabel} • </Text>
        <Text color="cyan">{totalLines}</Text>
        <Text color="gray"> lines</Text>
      </Box>
      
      {/* Top border */}
      <Text color={actionColor}>{'─'.repeat(76)}</Text>
      
      {/* Lines above indicator */}
      {linesAbove > 0 && (
        <Text color="gray" dimColor>  ⋮ {linesAbove} lines above</Text>
      )}
      
      {/* Code content - show last 10 lines */}
      {linesToShow.map((line, i) => (
        <Text key={`line-${startLine + i}`}>
          <Text color="gray" dimColor>
            {String(startLine + i + 1).padStart(4, ' ')} │{' '}
          </Text>
          <Text color={getCodeColor(line, ext)}>
            {line.slice(0, 68)}
          </Text>
          {line.length > 68 && <Text color="gray">…</Text>}
        </Text>
      ))}
      
      {/* Bottom border */}
      <Text color={actionColor}>{'─'.repeat(76)}</Text>
    </Box>
  );
};

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
      <Text color="gray">{formatTarget(action.target)}</Text>
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

export const AgentSummary: React.FC<AgentSummaryProps> = ({
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
        <Text color="gray"> | {iterations} iterations | {actions.length} actions</Text>
      </Box>
      
      {error && (
        <Text color="red">Error: {error}</Text>
      )}
      
      {/* File changes breakdown */}
      {hasFileChanges && (
        <>
          <Text color="gray">{'─'.repeat(40)}</Text>
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
};

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
        <Text color="gray">No file changes in current session</Text>
      </Box>
    );
  }
  
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text color="cyan" bold>Session Changes ({totalChanges} total)</Text>
      <Text color="gray">{'─'.repeat(40)}</Text>
      
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
