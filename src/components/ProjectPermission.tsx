import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { setProjectPermission } from '../config/index';
import { getProjectSummary } from '../utils/project';

interface ProjectPermissionProps {
  projectPath: string;
  onComplete: (granted: boolean, permanent: boolean, writeGranted?: boolean) => void;
}

export const ProjectPermission: React.FC<ProjectPermissionProps> = ({ projectPath, onComplete }) => {
  const { stdout } = useStdout();
  const [step, setStep] = useState<'read' | 'write'>('read');
  const [readGranted, setReadGranted] = useState(false);

  useEffect(() => {
    stdout?.write('\x1b[2J\x1b[H');
  }, [stdout]);
  
  const summary = getProjectSummary(projectPath);
  const projectName = summary?.name || projectPath.split('/').pop() || 'Unknown';

  useInput((input, key) => {
    const char = input.toLowerCase();

    if (step === 'read') {
      if (char === 'y') {
        // Grant for this session only
        setReadGranted(true);
        setStep('write');
      } else if (char === 'a') {
        // Grant permanently (always)
        setProjectPermission(projectPath, true, false);
        setReadGranted(true);
        setStep('write');
      } else if (char === 'n' || key.escape) {
        // Deny
        onComplete(false, false);
      }
    } else if (step === 'write') {
      if (char === 'y') {
        // Grant write for session
        onComplete(true, false, true);
      } else if (char === 'a') {
        // Grant write permanently
        setProjectPermission(projectPath, true, true);
        onComplete(true, true, true);
      } else if (char === 'n' || key.escape) {
        // Read only
        if (readGranted) {
          onComplete(true, false, false);
        } else {
          onComplete(false, false, false);
        }
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Project Access Request</Text>
      <Text> </Text>
      
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text>Project: </Text>
          <Text color="cyan" bold>{projectName}</Text>
        </Text>
        <Text>
          <Text>Path: </Text>
          <Text>{projectPath}</Text>
        </Text>
        {summary && (
          <>
            <Text>
              <Text>Type: </Text>
              <Text>{summary.type}</Text>
            </Text>
            <Text>
              <Text>Files: </Text>
              <Text>{summary.fileCount} code files</Text>
            </Text>
          </>
        )}
      </Box>

      <Text> </Text>

      {step === 'read' && (
        <>
          <Text color="#f02a30">Allow Codeep to read project files?</Text>
          <Text> </Text>
          <Text>This enables:</Text>
          <Text>  • Auto-detect file paths in your messages</Text>
          <Text>  • Send file contents to AI for analysis</Text>
          <Text>  • Project structure awareness</Text>
          <Text> </Text>
          <Box>
            <Text color="green">[Y]</Text>
            <Text> Yes (this session)   </Text>
            <Text color="cyan">[A]</Text>
            <Text> Always   </Text>
            <Text color="#f02a30">[N]</Text>
            <Text> No</Text>
          </Box>
        </>
      )}

      {step === 'write' && (
        <>
          <Text color="green">✓ Read permission granted</Text>
          <Text> </Text>
          <Text color="#f02a30">Allow Codeep to suggest file changes?</Text>
          <Text> </Text>
          <Text>This enables:</Text>
          <Text>  • AI can suggest code modifications</Text>
          <Text>  • You'll always see changes before applying</Text>
          <Text> </Text>
          <Box>
            <Text color="green">[Y]</Text>
            <Text> Yes (this session)   </Text>
            <Text color="cyan">[A]</Text>
            <Text> Always   </Text>
            <Text color="#f02a30">[N]</Text>
            <Text> Read-only</Text>
          </Box>
        </>
      )}
    </Box>
  );
};
