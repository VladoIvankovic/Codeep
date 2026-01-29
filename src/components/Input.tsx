import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Text, Box, useInput } from 'ink';
import clipboardy from 'clipboardy';

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

interface PasteInfo {
  lines: number;
  chars: number;
  preview: string;
  fullText: string;
}

export const ChatInput: React.FC<InputProps> = ({ onSubmit, disabled, history = [], clearTrigger = 0 }) => {
  const [value, setValue] = useState('');
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pasteInfo, setPasteInfo] = useState<PasteInfo | null>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  // Paste detection using timing - chars arriving < 5ms apart = paste
  const inputBuffer = useRef<string>('');
  const lastInputTime = useRef<number>(0);
  const pasteTimeout = useRef<NodeJS.Timeout | null>(null);

  // Clear input when clearTrigger changes
  useEffect(() => {
    if (clearTrigger > 0) {
      setValue('');
      setCursorPos(0);
      setSelectedIndex(0);
      setPasteInfo(null);
      setHistoryIndex(-1);
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
    }
  }, [suggestions.length]);

  // Process buffered input - called after paste timeout
  const processBuffer = () => {
    const buffer = inputBuffer.current;
    inputBuffer.current = '';
    
    if (!buffer) return;
    
    // If buffer has multiple chars (> 20), treat as paste and show indicator
    if (buffer.length > 20) {
      handlePastedText(buffer, true);
    } else {
      // Short buffer - just add to value normally
      setValue(prev => prev + buffer);
      setCursorPos(prev => prev + buffer.length);
    }
  };

  const handlePastedText = (text: string, fromCtrlV: boolean = false) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const lines = trimmed.split(/\r?\n/);
    const lineCount = lines.length;
    const charCount = trimmed.length;

    // For multi-line, long pastes, or explicit Ctrl+V - show indicator
    if (lineCount > 1 || charCount > 100 || (fromCtrlV && charCount > 20)) {
      const firstLine = lines[0].substring(0, 60);
      const preview = firstLine + (lines[0].length > 60 ? '...' : '');
      
      setPasteInfo({
        lines: lineCount,
        chars: charCount,
        preview,
        fullText: trimmed,
      });
      
      // Show only indicator in input field, NOT the actual pasted text
      const indicator = `📋 Paste: ${charCount} chars`;
      // Replace entire value with just the indicator (don't append pasted text)
      setValue(indicator);
      setCursorPos(indicator.length);
    } else {
      // Short paste - insert directly
      setValue(prev => prev + trimmed);
      setCursorPos(prev => prev + trimmed.length);
      setPasteInfo(null);
    }
  };

  // Main input handler
  useInput((input, key) => {
    if (disabled) return;

    // Handle Enter - submit
    if (key.return) {
      if (value.trim()) {
        let submitValue = value.trim();
        
        // Replace paste indicator with actual content
        if (pasteInfo && submitValue.includes('📋 Paste:')) {
          submitValue = submitValue.replace(/📋 Paste: \d+ chars/, pasteInfo.fullText);
        }
        
        onSubmit(submitValue);
        setValue('');
        setCursorPos(0);
        setPasteInfo(null);
        setHistoryIndex(-1);
      }
      return;
    }

    // Handle Escape - clear paste info or input
    if (key.escape) {
      if (pasteInfo) {
        // Remove paste indicator from value
        setValue(prev => prev.replace(/📋 Paste: \d+ chars/, ''));
        setPasteInfo(null);
      } else if (value) {
        setValue('');
        setCursorPos(0);
      }
      return;
    }

    // Handle Backspace
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setValue(prev => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos(prev => prev - 1);
        
        // Clear paste info if we deleted the indicator
        if (pasteInfo && !value.includes('📋 Paste:')) {
          setPasteInfo(null);
        }
      }
      return;
    }

    // Handle Tab - autocomplete command
    if (key.tab && suggestions.length > 0) {
      setValue(suggestions[selectedIndex].cmd + ' ');
      setCursorPos(suggestions[selectedIndex].cmd.length + 1);
      return;
    }

    // Handle Up Arrow - navigate suggestions or history
    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSelectedIndex(i => Math.max(0, i - 1));
      } else if (history.length > 0) {
        const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        if (newIndex >= 0 && history[history.length - 1 - newIndex]) {
          const historyValue = history[history.length - 1 - newIndex];
          setValue(historyValue);
          setCursorPos(historyValue.length);
        }
      }
      return;
    }

    // Handle Down Arrow - navigate suggestions or history
    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSelectedIndex(i => Math.min(suggestions.length - 1, i + 1));
      } else if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        const historyValue = history[history.length - 1 - newIndex];
        setValue(historyValue);
        setCursorPos(historyValue.length);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setValue('');
        setCursorPos(0);
      }
      return;
    }

    // Handle Left Arrow
    if (key.leftArrow) {
      setCursorPos(prev => Math.max(0, prev - 1));
      return;
    }

    // Handle Right Arrow
    if (key.rightArrow) {
      setCursorPos(prev => Math.min(value.length, prev + 1));
      return;
    }

    // Handle Ctrl+A - go to beginning
    if (key.ctrl && input === 'a') {
      setCursorPos(0);
      return;
    }

    // Handle Ctrl+E - go to end
    if (key.ctrl && input === 'e') {
      setCursorPos(value.length);
      return;
    }

    // Handle Ctrl+U - clear line
    if (key.ctrl && input === 'u') {
      setValue('');
      setCursorPos(0);
      setPasteInfo(null);
      return;
    }

    // Handle Ctrl+W - delete word
    if (key.ctrl && input === 'w') {
      const beforeCursor = value.slice(0, cursorPos);
      const afterCursor = value.slice(cursorPos);
      const lastSpace = beforeCursor.trimEnd().lastIndexOf(' ');
      const newBefore = lastSpace >= 0 ? beforeCursor.slice(0, lastSpace + 1) : '';
      setValue(newBefore + afterCursor);
      setCursorPos(newBefore.length);
      return;
    }

    // Handle Ctrl+V - paste from clipboard
    // Terminal sends ASCII 22 (\x16) for Ctrl+V
    if (input === '\x16' || (key.ctrl && input === 'v')) {
      try {
        const clipboardText = clipboardy.readSync();
        if (clipboardText) {
          handlePastedText(clipboardText, true);
        }
      } catch {
        // Clipboard read failed, ignore
      }
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      // If we have paste info and user types new char, clear paste
      if (pasteInfo) {
        setPasteInfo(null);
        setValue('');
        setCursorPos(0);
      }
      
      const now = Date.now();
      const timeSinceLastInput = now - lastInputTime.current;
      lastInputTime.current = now;
      
      // If chars arrive very fast (< 5ms apart), buffer them as paste
      if (timeSinceLastInput < 5 || inputBuffer.current.length > 0) {
        inputBuffer.current += input;
        
        // Clear existing timeout
        if (pasteTimeout.current) {
          clearTimeout(pasteTimeout.current);
        }
        
        // Set timeout to process buffer
        pasteTimeout.current = setTimeout(() => {
          processBuffer();
        }, 10);
        
        return; // Don't add to value yet
      }
      
      // Normal single character input (slow typing)
      setValue(prev => prev.slice(0, cursorPos) + input + prev.slice(cursorPos));
      setCursorPos(prev => prev + input.length);
    }
  }, { isActive: !disabled });


  // Render input with cursor
  const renderInput = () => {
    if (!value) {
      return <Text color="gray">Type a message or /command...</Text>;
    }
    
    const before = value.slice(0, cursorPos);
    const cursor = value[cursorPos] || ' ';
    const after = value.slice(cursorPos + 1);
    
    return (
      <Text>
        {before}
        <Text backgroundColor="white" color="black">{cursor}</Text>
        {after}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Suggestions dropdown */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {suggestions.slice(0, 8).map((s, i) => (
            <Text key={s.cmd}>
              {i === selectedIndex ? <Text color="#f02a30">▸ </Text> : '  '}
              <Text color={i === selectedIndex ? '#f02a30' : undefined} bold={i === selectedIndex}>
                {s.cmd}
              </Text>
              <Text color={i === selectedIndex ? undefined : 'gray'}> - {s.desc}</Text>
            </Text>
          ))}
          <Text color="gray" dimColor>
            ↑↓ navigate • Tab complete • Esc cancel
          </Text>
        </Box>
      )}

      {/* Paste info box */}
      {pasteInfo && (
        <Box 
          borderStyle="round" 
          borderColor="cyan" 
          paddingX={1} 
          marginBottom={1}
          flexDirection="column"
        >
          <Text color="cyan" bold>
            📋 Pasted Content
          </Text>
          <Text>
            <Text color="white" bold>{pasteInfo.lines}</Text>
            <Text color="gray"> {pasteInfo.lines === 1 ? 'line' : 'lines'} • </Text>
            <Text color="white" bold>{pasteInfo.chars}</Text>
            <Text color="gray"> characters</Text>
          </Text>
          <Text color="gray" dimColor wrap="truncate">
            {pasteInfo.preview}
          </Text>
          <Text color="gray" dimColor>
            Press Enter to send • Esc to remove
          </Text>
        </Box>
      )}
      
      {/* Input line */}
      <Box>
        <Text color="#f02a30" bold>{'> '}</Text>
        {disabled ? (
          <Text color="yellow">Agent working... (Esc to stop)</Text>
        ) : (
          renderInput()
        )}
      </Box>
    </Box>
  );
};