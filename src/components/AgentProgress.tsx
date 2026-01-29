/**
 * Agent progress display component
 */

import React, { useState, useEffect } from 'react';
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
      borderStyle="round" 
      borderColor={dryRun ? 'yellow' : '#f02a30'} 
      padding={1} 
      marginY={1}
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
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="white" bold>Now: </Text>
            <Text color={getActionColor(currentAction.type)}>{getActionLabel(currentAction.type)} </Text>
            <Text color="white">{formatTarget(currentAction.target)}</Text>
          </Box>
          {/* Show live code preview for write/edit actions */}
          {(currentAction.type === 'write' || currentAction.type === 'edit') && currentAction.details && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text color="cyan" bold>📝 Live Code:</Text>
                <Text color="gray"> {currentAction.target.split('/').pop()}</Text>
              </Box>
              <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={0}>
                {currentAction.details.split('\n').slice(0, 12).map((line, i) => (
                  <Text key={i}>
                    <Text color="gray" dimColor>{String(i + 1).padStart(3, ' ')} │ </Text>
                    <Text color={getCodeColor(line)}>{line.slice(0, 70)}{line.length > 70 ? '...' : ''}</Text>
                  </Text>
                ))}
                {currentAction.details.split('\n').length > 12 && (
                  <Text color="gray" dimColor>     ... +{currentAction.details.split('\n').length - 12} more lines</Text>
                )}
              </Box>
            </Box>
          )}
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

// Helper function for syntax highlighting
const getCodeColor = (line: string): string => {
  const trimmed = line.trim();
  // Comments
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return 'gray';
  }
  // Keywords
  if (/^(import|export|const|let|var|function|class|interface|type|return|if|else|for|while|async|await)\b/.test(trimmed)) {
    return 'magenta';
  }
  // HTML tags
  if (trimmed.startsWith('<') && (trimmed.includes('>') || trimmed.includes('/>'))) {
    return 'cyan';
  }
  // Strings
  if (trimmed.includes('"') || trimmed.includes("'") || trimmed.includes('`')) {
    return 'green';
  }
  return 'white';
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
