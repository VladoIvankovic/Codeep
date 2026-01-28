import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';
import { getConfiguredProviders, clearApiKey, getCurrentProvider } from '../config/index';

interface LogoutPickerProps {
  onLogout: (providerId: string) => void;
  onLogoutAll: () => void;
  onCancel: () => void;
}

export const LogoutPicker: React.FC<LogoutPickerProps> = ({ 
  onLogout, 
  onLogoutAll,
  onCancel 
}) => {
  const providers = getConfiguredProviders();
  const currentProvider = getCurrentProvider();
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  // Options: individual providers + "All" + "Cancel"
  const options = [
    ...providers.map(p => ({ 
      type: 'provider' as const, 
      id: p.id, 
      label: p.name,
      isCurrent: p.id === currentProvider.id
    })),
    { type: 'all' as const, id: 'all', label: 'Logout from all providers', isCurrent: false },
    { type: 'cancel' as const, id: 'cancel', label: 'Cancel', isCurrent: false },
  ];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(options.length - 1, i + 1));
    }

    if (key.return) {
      const selected = options[selectedIndex];
      if (selected.type === 'provider') {
        clearApiKey(selected.id);
        onLogout(selected.id);
      } else if (selected.type === 'all') {
        for (const p of providers) {
          clearApiKey(p.id);
        }
        onLogoutAll();
      } else {
        onCancel();
      }
    }
  });

  if (providers.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">No providers configured.</Text>
        <Text color="gray">Press Escape to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Select provider to logout:</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          const prefix = isSelected ? '→ ' : '  ';
          
          let color = isSelected ? 'green' : 'white';
          if (option.type === 'all') color = isSelected ? 'red' : 'yellow';
          if (option.type === 'cancel') color = isSelected ? 'blue' : 'gray';
          
          return (
            <Box key={option.id}>
              <Text color={color} bold={isSelected}>
                {prefix}{option.label}
              </Text>
              {option.isCurrent && (
                <Text color="cyan"> (current)</Text>
              )}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">↑↓ Navigate  Enter Select  Esc Cancel</Text>
      </Box>
    </Box>
  );
};
