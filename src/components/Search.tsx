import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SearchResult } from '../utils/search';

interface SearchProps {
  results: SearchResult[];
  searchTerm: string;
  onClose: () => void;
  onSelectMessage: (index: number) => void;
}

export const Search: React.FC<SearchProps> = ({ results, searchTerm, onClose, onSelectMessage }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
    }

    if (key.downArrow) {
      setSelectedIndex(i => Math.min(results.length - 1, i + 1));
    }

    if (key.return && results.length > 0) {
      onSelectMessage(results[selectedIndex].messageIndex);
      onClose();
    }
  });

  if (results.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
        <Text color="#f02a30" bold>Search Results</Text>
        <Text> </Text>
        <Text>
          <Text>Query: </Text>
          <Text color="cyan">"{searchTerm}"</Text>
        </Text>
        <Text> </Text>
        <Text>No results found.</Text>
        <Text> </Text>
        <Text>Press Esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Search Results</Text>
      <Text> </Text>
      <Text>
        <Text>Query: </Text>
        <Text color="cyan">"{searchTerm}"</Text>
        <Text> ({results.length} {results.length === 1 ? 'result' : 'results'})</Text>
      </Text>
      <Text> </Text>

      {results.map((result, i) => {
        const isSelected = i === selectedIndex;
        const roleColor = result.role === 'user' ? 'green' : 'blue';

        return (
          <Box key={i} flexDirection="column" marginBottom={i < results.length - 1 ? 1 : 0}>
            <Text>
              {isSelected ? <Text color="#f02a30">▸ </Text> : '  '}
              <Text color={roleColor} bold>
                [{result.role.toUpperCase()}]
              </Text>
              <Text> Message #{result.messageIndex + 1}</Text>
            </Text>
            <Text>
              {'  '}
              <Text>{result.matchedText}</Text>
            </Text>
          </Box>
        );
      })}

      <Text> </Text>
      <Text>↑/↓ Navigate, Enter = Jump to message, Esc = Close</Text>
    </Box>
  );
};
