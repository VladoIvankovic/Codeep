import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ExportFormat } from '../utils/export';

interface ExportProps {
  onExport: (format: ExportFormat) => void;
  onCancel: () => void;
}

export const Export: React.FC<ExportProps> = ({ onExport, onCancel }) => {
  const { stdout } = useStdout();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    stdout?.write('\x1b[2J\x1b[H');
  }, [stdout]);

  const formats: Array<{ id: ExportFormat; name: string; description: string }> = [
    { id: 'md', name: 'Markdown', description: 'Formatted with headers and separators' },
    { id: 'json', name: 'JSON', description: 'Structured data format' },
    { id: 'txt', name: 'Plain Text', description: 'Simple text format' },
  ];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : formats.length - 1));
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < formats.length - 1 ? prev + 1 : 0));
    }

    if (key.return) {
      onExport(formats[selectedIndex].id);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" padding={1}>
      <Text color="green" bold>Export Chat</Text>
      <Text> </Text>
      <Text>Select export format:</Text>
      <Text> </Text>

      {formats.map((format, index) => (
        <Box key={format.id} flexDirection="column">
          <Text>
            {selectedIndex === index ? '› ' : '  '}
            <Text color={selectedIndex === index ? 'green' : 'white'} bold={selectedIndex === index}>
              {format.name}
            </Text>
            <Text> - {format.description}</Text>
          </Text>
        </Box>
      ))}

      <Text> </Text>
      <Text>↑/↓ Navigate • Enter Export • Esc Cancel</Text>
    </Box>
  );
};
