import React, { useState, useMemo, useEffect } from 'react';
import { Text, Box, useInput } from 'ink';
import TextInput from 'ink-text-input';
import clipboard from 'clipboardy';

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
  const [pasteInfo, setPasteInfo] = useState<{ lines: number; chars: number; preview: string } | null>(null);
  const [fullPasteText, setFullPasteText] = useState<string | null>(null);

  // Clear input when clearTrigger changes
  useEffect(() => {
    if (clearTrigger > 0) {
      setValue('');
      setSelectedIndex(0);
      setIsSelectingCommand(false);
      setPasteInfo(null);
      setFullPasteText(null);
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

  // Handle keyboard navigation for command suggestions and paste
  useInput(async (input, key) => {
    if (disabled) return;
    
    // Handle paste (Ctrl+V) - read from clipboard and insert
    if (key.ctrl && input === 'v') {
      try {
        const clipboardText = await clipboard.read();
        const trimmed = clipboardText.trim();
        
        if (!trimmed) return;
        
        const lines = trimmed.split(/\r?\n/);
        const lineCount = lines.length;
        const charCount = trimmed.length;
        
        // For multi-line or long pastes, show summary and store full text
        if (lineCount > 1 || charCount > 200) {
          // Store the full text for submission
          setFullPasteText(trimmed);
          
          // Create a short preview (first line, truncated)
          const firstLine = lines[0].substring(0, 50);
          const preview = firstLine + (lines[0].length > 50 ? '...' : '');
          
          // Show compact indicator in input
          setValue(prev => prev + `[paste: ${lineCount} lines, ${charCount} chars]`);
          
          // Show detailed info below
          setPasteInfo({ lines: lineCount, chars: charCount, preview });
        } else {
          // Short single-line paste - just insert directly
          setValue(prev => prev + trimmed);
          setFullPasteText(null);
          setPasteInfo(null);
        }
      } catch (error) {
        // Clipboard read failed, ignore
      }
      return;
    }
    
    if (suggestions.length === 0) return;

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
  }, { isActive: !disabled });

  const handleChange = (newValue: string) => {
    setValue(newValue);
  };

  const handleSubmit = () => {
    if (value.trim() && !disabled) {
      // If we have stored paste text, replace the placeholder with actual content
      let submitValue = value.trim();
      if (fullPasteText && submitValue.includes('[paste:')) {
        // Replace the paste placeholder with actual content
        submitValue = submitValue.replace(/\[paste: \d+ lines, \d+ chars\]/, fullPasteText);
      }
      
      onSubmit(submitValue);
      setValue('');
      setPasteInfo(null);
      setFullPasteText(null);
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
      <Box flexDirection="column">
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
        {pasteInfo && (
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            <Text color="cyan">
              📋 Pasted: <Text bold>{pasteInfo.lines}</Text> {pasteInfo.lines === 1 ? 'line' : 'lines'}, <Text bold>{pasteInfo.chars}</Text> chars
            </Text>
            <Text color="gray" dimColor>
              Preview: {pasteInfo.preview}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
