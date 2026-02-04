/**
 * Agent Actions component - displays actions in the chat area
 * Removed Static component as it renders at top of terminal
 */

import React, { useState, useEffect, memo } from 'react';
import { Box, Text } from 'ink';
import { ActionLog } from '../utils/tools';

// Spinner frames
const SPINNER_FRAMES = ['/', '-', '\\', '|'];

/**
 * Isolated spinner - doesn't cause parent re-renders
 */
const Spinner: React.FC<{ color?: string }> = memo(({ color = '#f02a30' }) => {
  const [frame, setFrame] = useState(0);
  
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);
  
  return <Text color={color}>[{SPINNER_FRAMES[frame]}]</Text>;
});

Spinner.displayName = 'Spinner';

/**
 * Format action for display
 */
function formatAction(action: ActionLog): { icon: string; color: string; text: string } {
  const filename = action.target.split('/').pop() || action.target;
  const lineCount = action.details ? action.details.split('\n').length : 0;
  const lineInfo = lineCount > 0 ? ` (${lineCount} lines)` : '';
  
  switch (action.type) {
    case 'write':
      return {
        icon: action.result === 'success' ? '✓' : '✗',
        color: action.result === 'success' ? 'green' : 'red',
        text: `Created ${filename}${lineInfo}`,
      };
    case 'edit':
      return {
        icon: action.result === 'success' ? '✓' : '✗',
        color: action.result === 'success' ? 'yellow' : 'red',
        text: `Edited ${filename}${lineInfo}`,
      };
    case 'read':
      return {
        icon: '→',
        color: 'blue',
        text: `Reading ${filename}`,
      };
    case 'delete':
      return {
        icon: action.result === 'success' ? '✓' : '✗',
        color: 'red',
        text: `Deleted ${filename}`,
      };
    case 'command':
      const cmd = action.target.length > 30 ? action.target.slice(0, 30) + '...' : action.target;
      return {
        icon: action.result === 'success' ? '✓' : '✗',
        color: action.result === 'success' ? 'magenta' : 'red',
        text: `Ran \`${cmd}\``,
      };
    case 'search':
      return {
        icon: '→',
        color: 'cyan',
        text: `Searching ${filename}`,
      };
    case 'mkdir':
      return {
        icon: action.result === 'success' ? '✓' : '✗',
        color: 'blue',
        text: `Created dir ${filename}`,
      };
    case 'fetch':
      return {
        icon: '→',
        color: 'cyan',
        text: `Fetching ${filename}`,
      };
    case 'list':
      return {
        icon: '→',
        color: 'gray',
        text: `Listing ${filename}`,
      };
    default:
      return {
        icon: '◦',
        color: 'white',
        text: `${action.type}: ${filename}`,
      };
  }
}

/**
 * Single action line component
 */
const ActionLine: React.FC<{ action: ActionLog }> = memo(({ action }) => {
  const { icon, color, text } = formatAction(action);
  return (
    <Text>
      <Text color={color}>{icon}</Text>
      <Text> {text}</Text>
    </Text>
  );
});

ActionLine.displayName = 'ActionLine';

interface AgentActionsProps {
  actions: ActionLog[];
  isRunning: boolean;
  currentStep: number;
  dryRun?: boolean;
}

/**
 * Agent Actions display - renders in chat area
 * Shows only the last few actions to prevent too much jumping
 */
export const AgentActions: React.FC<AgentActionsProps> = memo(({
  actions,
  isRunning,
  currentStep,
  dryRun,
}) => {
  const color = dryRun ? 'yellow' : '#f02a30';
  const label = dryRun ? 'DRY RUN' : 'AGENT';
  
  // Only show last 5 completed actions to minimize re-render area
  const MAX_VISIBLE_ACTIONS = 5;
  const completedActions = actions.filter(a => a.result === 'success' || a.result === 'error');
  const visibleActions = completedActions.slice(-MAX_VISIBLE_ACTIONS);
  const hiddenCount = completedActions.length - visibleActions.length;
  
  // Current action (last one if result is pending or the running state)
  const currentAction = actions.length > 0 ? actions[actions.length - 1] : null;
  
  if (!isRunning && actions.length === 0) {
    return null;
  }
  
  return (
    <Box flexDirection="column" marginY={1}>
      {/* Show count of hidden actions */}
      {hiddenCount > 0 && (
        <Text color="gray">... {hiddenCount} earlier action(s) ...</Text>
      )}
      
      {/* Recent completed actions */}
      {visibleActions.map((action, i) => (
        <ActionLine key={`action-${hiddenCount + i}-${action.timestamp}`} action={action} />
      ))}
      
      {/* Current action with spinner (only while running) */}
      {isRunning && (
        <Box>
          <Spinner color={color} />
          <Text color={color} bold> {label} </Text>
          <Text color="cyan">Step {currentStep}</Text>
          {currentAction && (
            <>
              <Text color="gray"> | </Text>
              <Text>{formatAction(currentAction).text}</Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
});

AgentActions.displayName = 'AgentActions';
