import React, { useState, useMemo, useEffect } from 'react';
import { Text, Box, useInput } from 'ink';
import TextInput from 'ink-text-input';

const COMMANDS = [
  { cmd: '/help', desc: 'Show help' },
  { cmd: '/status', desc: 'Show status' },
  { cmd: '/version', desc: 'Show version' },
  { cmd: '/update', desc: 'Check updates' },
  { cmd: '/model', desc: 'Switch model' },
  { cmd: '/protocol', desc: 'Switch protocol' },
  { cmd: '/provider', desc: 'Switch provider' },
  { cmd: '/lang', desc: 'Set language' },
  { cmd: '/settings', desc: 'Adjust settings' },
  { cmd: '/sessions', desc: 'Manage sessions' },
  { cmd: '/sessions delete', desc: 'Delete session' },
  { cmd: '/rename', desc: 'Rename session' },
  { cmd: '/search', desc: 'Search history' },
  { cmd: '/export', desc: 'Export chat' },
  { cmd: '/diff', desc: 'Review git changes' },
  { cmd: '/diff --staged', desc: 'Review staged changes' },
  { cmd: '/commit', desc: 'Generate commit message' },
  { cmd: '/apply', desc: 'Apply file changes' },
  { cmd: '/copy', desc: 'Copy code block' },
  { cmd: '/clear', desc: 'Clear chat' },
  { cmd: '/login', desc: 'Change API key' },
  { cmd: '/logout', desc: 'Logout' },
  { cmd: '/exit', desc: 'Quit' },
];

interface InputProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  history?: string[];
  clearTrigger?: number;
}

export const ChatInput: React.FC<InputProps> = ({ onSubmit, disabled, history = [], clearTrigger = 0 }) => {
  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSelectingCommand, setIsSelectingCommand] = useState(false);

  // Clear input when clearTrigger changes
  useEffect(() => {
    if (clearTrigger > 0) {
      setValue('');
      setSelectedIndex(0);
      setIsSelectingCommand(false);
    }
  }, [clearTrigger]);

  // Filter commands based on input
  const suggestions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ')) return [];
    return COMMANDS.filter(c => c.cmd.startsWith(value.toLowerCase()));
  }, [value]);

  // Reset selection when suggestions change
  useEffect(() => {
    if (suggestions.length > 0) {
      setSelectedIndex(0);
      setIsSelectingCommand(true);
    } else {
      setIsSelectingCommand(false);
    }
  }, [suggestions.length]);

  // Handle keyboard navigation for command suggestions
  useInput((input, key) => {
    if (disabled || suggestions.length === 0) return;

    // Navigate suggestions with up/down arrows
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(suggestions.length - 1, i + 1));
      return;
    }

    // Tab to autocomplete selected command
    if (key.tab) {
      setValue(suggestions[selectedIndex].cmd);
      setIsSelectingCommand(false);
      return;
    }
  }, { isActive: isSelectingCommand });

  const handleChange = (newValue: string) => {
    setValue(newValue);
  };

  const handleSubmit = (text: string) => {
    if (text.trim() && !disabled) {
      onSubmit(text.trim());
      setValue('');
      setIsSelectingCommand(false);
    }
  };

  return (
    <Box flexDirection="column">
      {/* Suggestions dropdown */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {suggestions.map((s, i) => (
            <Text key={s.cmd}>
              {i === selectedIndex ? <Text color="#f02a30">▸ </Text> : '  '}
              <Text color={i === selectedIndex ? '#f02a30' : undefined} bold={i === selectedIndex}>
                {s.cmd}
              </Text>
              <Text color={i === selectedIndex ? undefined : 'gray'}> - {s.desc}</Text>
            </Text>
          ))}
          <Text color="gray">
            ↑↓ Navigate • Tab Complete • {suggestions.length} {suggestions.length === 1 ? 'command' : 'commands'}
          </Text>
        </Box>
      )}
      
      {/* Input line */}
      <Box>
        <Text color="#f02a30" bold>{'> '}</Text>
        {disabled ? (
          <Text>...</Text>
        ) : (
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder="Type a message or /command..."
          />
        )}
      </Box>
    </Box>
  );
};
