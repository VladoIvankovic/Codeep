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
      <Text color="#f02a30" bold>Codeep Commands</Text>
      <Text> </Text>
      
      {/* General */}
      <Text color="cyan" bold>General</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/help</Text>      - Show this help</Text>
          <Text><Text color="#f02a30">/status</Text>    - Current status</Text>
          <Text><Text color="#f02a30">/version</Text>   - Show version</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/update</Text>    - Check for updates</Text>
          <Text><Text color="#f02a30">/clear</Text>     - Clear chat</Text>
          <Text><Text color="#f02a30">/exit</Text>      - Quit</Text>
        </Box>
      </Box>
      
      <Text> </Text>
      
      {/* Agent & AI */}
      <Text color="cyan" bold>Agent & AI</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/agent</Text> {'<task>'}   - Run AI agent</Text>
          <Text><Text color="#f02a30">/agent-dry</Text>     - Preview agent actions</Text>
          <Text><Text color="#f02a30">/agent-stop</Text>    - Stop running agent</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/grant</Text>         - Grant write permission</Text>
          <Text><Text color="#f02a30">/scan</Text>          - Scan project for AI</Text>
          <Text><Text color="#f02a30">/skills</Text>        - List available skills</Text>
        </Box>
      </Box>
      
      <Text> </Text>
      
      {/* Git */}
      <Text color="cyan" bold>Git</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/diff</Text>          - Review git changes</Text>
          <Text><Text color="#f02a30">/diff --staged</Text> - Review staged</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/commit</Text>        - Generate commit msg</Text>
          <Text><Text color="#f02a30">/apply</Text>         - Apply file changes</Text>
        </Box>
      </Box>
      
      <Text> </Text>
      
      {/* Configuration */}
      <Text color="cyan" bold>Configuration</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/model</Text>     - Switch AI model</Text>
          <Text><Text color="#f02a30">/provider</Text>  - Switch provider</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/settings</Text>  - Adjust settings</Text>
          <Text><Text color="#f02a30">/lang</Text>      - Set language</Text>
        </Box>
      </Box>
      
      <Text> </Text>
      
      {/* Sessions & Export */}
      <Text color="cyan" bold>Sessions</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/sessions</Text>  - Manage sessions</Text>
          <Text><Text color="#f02a30">/rename</Text>    - Rename session</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/search</Text>    - Search history</Text>
          <Text><Text color="#f02a30">/export</Text>    - Export chat</Text>
        </Box>
      </Box>
      
      <Text> </Text>
      
      {/* Clipboard */}
      <Text color="cyan" bold>Clipboard</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/copy</Text> [n]  - Copy code block</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/paste</Text>     - Paste from clipboard</Text>
        </Box>
      </Box>
      
      <Text> </Text>
      
      {/* Account */}
      <Text color="cyan" bold>Account</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/login</Text>     - Change API key</Text>
        </Box>
        <Box flexDirection="column">
          <Text><Text color="#f02a30">/logout</Text>    - Logout</Text>
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
      <Text color="cyan">Type / for autocomplete | Docs: github.com/VladoIvankovic/Codeep</Text>
    </Box>
  );
};
