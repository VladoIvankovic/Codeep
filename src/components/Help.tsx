import React from 'react';
import { Text, Box } from 'ink';
import { detectProjectFeatures, ProjectFeatures } from '../utils/project';

interface HelpProps {
  projectPath?: string;
}

export const Help: React.FC<HelpProps> = ({ projectPath }) => {
  const features: ProjectFeatures | null = projectPath ? detectProjectFeatures(projectPath) : null;

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
      
      {/* Project-specific suggestions */}
      {features && (features.hasGit || features.hasPackageJson || features.hasPython || features.hasCargo || features.hasGoMod) && (
        <>
          <Text> </Text>
          <Text color="green" bold>Suggested for this project:</Text>
          <Box flexDirection="column" marginLeft={1}>
            {features.hasGit && (
              <Text><Text color="green">/diff</Text> - Review your uncommitted changes</Text>
            )}
            {features.hasGit && (
              <Text><Text color="green">/commit</Text> - AI-generated commit message</Text>
            )}
            {features.hasPackageJson && (
              <Text><Text color="green">/agent npm run build</Text> - Build Node.js project</Text>
            )}
            {features.hasPython && (
              <Text><Text color="green">/agent pytest</Text> - Run Python tests</Text>
            )}
            {features.hasCargo && (
              <Text><Text color="green">/agent cargo build</Text> - Build Rust project</Text>
            )}
            {features.hasGoMod && (
              <Text><Text color="green">/agent go build</Text> - Build Go project</Text>
            )}
          </Box>
        </>
      )}
      
      <Text> </Text>
      <Text color="cyan">Type / to see autocomplete. Docs: github.com/VladoIvankovic/Codeep</Text>
    </Box>
  );
};
