import React from 'react';
import { Text, Box } from 'ink';

export const Help: React.FC = () => {
  return (
    <Box flexDirection="column">
      <Text color="#f02a30" bold>Available Commands</Text>
      <Text> </Text>
      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column" flexGrow={1}>
          <Text><Text color="#f02a30">/help</Text>       - Show this help</Text>
          <Text><Text color="#f02a30">/status</Text>     - Current status</Text>
          <Text><Text color="#f02a30">/settings</Text>   - Adjust settings</Text>
          <Text><Text color="#f02a30">/sessions</Text>   - Manage sessions</Text>
          <Text><Text color="#f02a30">/grant</Text>      - Grant permissions</Text>
          <Text><Text color="#f02a30">/agent</Text> {'<task>'} - Run agent</Text>
          <Text><Text color="#f02a30">/clear</Text>      - Clear chat</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text><Text color="#f02a30">/model</Text>      - Switch model</Text>
          <Text><Text color="#f02a30">/provider</Text>   - Switch provider</Text>
          <Text><Text color="#f02a30">/diff</Text>       - Review git changes</Text>
          <Text><Text color="#f02a30">/commit</Text>     - Generate commit msg</Text>
          <Text><Text color="#f02a30">/export</Text>     - Export chat</Text>
          <Text><Text color="#f02a30">/copy</Text> [n]   - Copy code block</Text>
          <Text><Text color="#f02a30">/exit</Text>       - Quit</Text>
        </Box>
      </Box>
      <Text> </Text>
      <Text color="cyan">Type / to see autocomplete. Docs: github.com/VladoIvankovic/Codeep</Text>
    </Box>
  );
};
