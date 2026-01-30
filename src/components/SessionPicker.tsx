import React, { useState, useMemo } from 'react';
import { Text, Box, useInput } from 'ink';
import { SessionInfo, listSessionsWithInfo, loadSession, startNewSession } from '../config/index';
import { Message } from '../config/index';

interface SessionPickerProps {
  onSelect: (messages: Message[], sessionName: string) => void;
  onNewSession: () => void;
  projectPath?: string;
}

/**
 * Format relative time (e.g., "today", "yesterday", "3 days ago")
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

/**
 * Format file size (e.g., "1.2 KB")
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Truncate session name for display
 */
function truncateName(name: string, maxLength: number = 25): string {
  if (name.length <= maxLength) return name;
  return name.substring(0, maxLength - 3) + '...';
}

export const SessionPicker: React.FC<SessionPickerProps> = ({ 
  onSelect, 
  onNewSession,
  projectPath 
}) => {
  const sessions = useMemo(() => listSessionsWithInfo(projectPath), [projectPath]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    // N = New session
    if (input === 'n' || input === 'N') {
      startNewSession();
      onNewSession();
      return;
    }

    // Arrow navigation
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(sessions.length - 1, i + 1));
    }

    // Enter = Load selected session
    if (key.return && sessions.length > 0) {
      const selected = sessions[selectedIndex];
      const messages = loadSession(selected.name, projectPath);
      if (messages) {
        onSelect(messages, selected.name);
      }
    }

    // Escape = Start new session (same as N)
    if (key.escape) {
      startNewSession();
      onNewSession();
    }
  });

  // If no sessions exist, auto-start new session
  if (sessions.length === 0) {
    // Will trigger on next render cycle
    setTimeout(() => {
      startNewSession();
      onNewSession();
    }, 0);
    
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan">Starting new session...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Select a session:</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {sessions.map((session, index) => {
          const isSelected = index === selectedIndex;
          const prefix = isSelected ? '→ ' : '  ';
          const name = truncateName(session.name);
          const meta = `${session.messageCount} msg, ${formatRelativeTime(session.createdAt)}`;
          
          return (
            <Box key={session.name}>
              <Text color={isSelected ? 'green' : 'white'} bold={isSelected}>
                {prefix}{name}
              </Text>
              <Text color="#888888"> ({meta})</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="yellow">[N]</Text>
        <Text> New session</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="#888888">↑↓ Navigate  </Text>
        <Text color="#888888">Enter Select  </Text>
        <Text color="#888888">N New  </Text>
        <Text color="#888888">Esc New</Text>
      </Box>
    </Box>
  );
};
