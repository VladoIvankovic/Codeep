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
  { cmd: '/paste', desc: 'Paste from clipboard' },
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
  
  // Paste detection using timing - chars arriving fast = paste
  const inputBuffer = useRef<string>('');
  const lastInputTime = useRef<number>(0);
  const pasteTimeout = useRef<NodeJS.Timeout | null>(null);
  const charTimings = useRef<number[]>([]);

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

    // For multi-line or long pastes - show info box with preview
    if (lineCount > 1 || charCount > 80 || (fromCtrlV && charCount > 30)) {
      // Create preview - first line truncated
      const firstLine = lines[0].substring(0, 50);
      const preview = firstLine + (lines[0].length > 50 || lineCount > 1 ? '...' : '');
      
      setPasteInfo({
        lines: lineCount,
        chars: charCount,
        preview,
        fullText: trimmed,
      });
      
      // Show truncated text in input (not ugly indicator)
      const displayText = trimmed.replace(/\r?\n/g, ' ').substring(0, 60);
      const inputText = displayText + (trimmed.length > 60 ? '...' : '');
      setValue(inputText);
      setCursorPos(inputText.length);
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
      const trimmedValue = value.trim();
      
      // Handle /paste command - read from clipboard
      if (trimmedValue === '/paste') {
        try {
          const clipboardText = clipboardy.readSync();
          if (clipboardText && clipboardText.trim()) {
            handlePastedText(clipboardText.trim(), true);
          }
        } catch {
          // Clipboard read failed
        }
        return;
      }
      
      if (trimmedValue) {
        // If we have paste info, submit the full pasted text
        const submitValue = pasteInfo ? pasteInfo.fullText : trimmedValue;
        
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
        // Clear pasted content
        setValue('');
        setCursorPos(0);
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
        // If paste info exists, clear everything on backspace
        if (pasteInfo) {
          setValue('');
          setCursorPos(0);
          setPasteInfo(null);
          return;
        }
        setValue(prev => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos(prev => prev - 1);
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
      
      // Track timing for paste detection
      // Paste typically sends many chars with < 10ms between them
      const isPasteLikeTiming = timeSinceLastInput < 15;
      
      if (isPasteLikeTiming || inputBuffer.current.length > 0) {
        // Add to buffer
        inputBuffer.current += input;
        charTimings.current.push(timeSinceLastInput);
        
        // Clear existing timeout
        if (pasteTimeout.current) {
          clearTimeout(pasteTimeout.current);
        }
        
        // Set timeout to process buffer - wait a bit longer to collect all paste chars
        pasteTimeout.current = setTimeout(() => {
          const buffer = inputBuffer.current;
          const timings = charTimings.current;
          inputBuffer.current = '';
          charTimings.current = [];
          
          if (!buffer) return;
          
          // Calculate average timing - if most chars came fast, it's a paste
          const fastChars = timings.filter(t => t < 15).length;
          const isPaste = buffer.length > 5 && (fastChars / timings.length) > 0.5;
          
          if (isPaste && (buffer.length > 30 || buffer.includes('\n'))) {
            // Treat as paste
            handlePastedText(buffer, true);
          } else {
            // Just fast typing, add normally
            setValue(prev => prev + buffer);
            setCursorPos(prev => prev + buffer.length);
          }
        }, 50); // Wait 50ms to collect all paste chars
        
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
          borderColor="green" 
          paddingX={1} 
          marginBottom={1}
          flexDirection="column"
        >
          <Text>
            <Text color="green" bold>📋 </Text>
            <Text color="white" bold>{pasteInfo.chars}</Text>
            <Text color="gray"> chars</Text>
            {pasteInfo.lines > 1 && (
              <>
                <Text color="gray"> • </Text>
                <Text color="white" bold>{pasteInfo.lines}</Text>
                <Text color="gray"> lines</Text>
              </>
            )}
            <Text color="gray" dimColor>  (Enter send • Esc cancel)</Text>
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