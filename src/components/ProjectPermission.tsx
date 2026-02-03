import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { setProjectPermission, hasStandardProjectMarkers, initializeAsProject } from '../config/index';
import { getProjectSummary } from '../utils/project';

interface ProjectPermissionProps {
  projectPath: string;
  onComplete: (granted: boolean, permanent: boolean, writeGranted?: boolean) => void;
}

export const ProjectPermission: React.FC<ProjectPermissionProps> = ({ projectPath, onComplete }) => {
  // If folder doesn't have standard project markers, ask if user wants to initialize it
  const isStandardProject = hasStandardProjectMarkers(projectPath);
  const [step, setStep] = useState<'init' | 'read' | 'write'>(isStandardProject ? 'read' : 'init');
  const [readGranted, setReadGranted] = useState(false);
  
  const summary = getProjectSummary(projectPath);
  const projectName = summary?.name || projectPath.split('/').pop() || 'Unknown';

  useInput((input, key) => {
    const char = input.toLowerCase();

    if (step === 'init') {
      if (char === 'y') {
        // Initialize as project and continue to permissions
        initializeAsProject(projectPath);
        setStep('read');
      } else if (char === 'n' || key.escape) {
        // Don't initialize - use global config, skip to read permission
        setStep('read');
      }
    } else if (step === 'read') {
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

      {step === 'init' && (
        <>
          <Text color="yellow">This folder is not recognized as a project.</Text>
          <Text> </Text>
          <Text>Initialize as a Codeep project?</Text>
          <Text> </Text>
          <Text color="gray">This will create a .codeep/ folder to store:</Text>
          <Text color="gray">  • Session history</Text>
          <Text color="gray">  • Project-specific settings</Text>
          <Text color="gray">  • Permission preferences</Text>
          <Text> </Text>
          <Text color="gray">If you choose No, settings will be stored globally.</Text>
          <Text> </Text>
          <Box>
            <Text color="green">[Y]</Text>
            <Text> Yes, initialize   </Text>
            <Text color="cyan">[N]</Text>
            <Text> No, use global config</Text>
          </Box>
        </>
      )}

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
