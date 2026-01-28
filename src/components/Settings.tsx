import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { config } from '../config/index';
import { updateRateLimits } from '../utils/ratelimit';

interface SettingsProps {
  onClose: () => void;
  notify: (msg: string) => void;
}

interface SettingItem {
  key: string;
  label: string;
  value: () => string | number;
  type: 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number | boolean; label: string }[];
}

const SETTINGS: SettingItem[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    value: () => config.get('temperature'),
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
  },
  {
    key: 'maxTokens',
    label: 'Max Tokens',
    value: () => config.get('maxTokens'),
    type: 'number',
    min: 256,
    max: 32768,
    step: 256,
  },
  {
    key: 'apiTimeout',
    label: 'API Timeout (ms)',
    value: () => config.get('apiTimeout'),
    type: 'number',
    min: 5000,
    max: 120000,
    step: 5000,
  },
  {
    key: 'rateLimitApi',
    label: 'API Rate Limit (/min)',
    value: () => config.get('rateLimitApi'),
    type: 'number',
    min: 1,
    max: 300,
    step: 5,
  },
  {
    key: 'rateLimitCommands',
    label: 'Command Rate Limit (/min)',
    value: () => config.get('rateLimitCommands'),
    type: 'number',
    min: 10,
    max: 1000,
    step: 10,
  },
  {
    key: 'autoSave',
    label: 'Auto Save Sessions',
    value: () => config.get('autoSave') ? 'On' : 'Off',
    type: 'select',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
  {
    key: 'agentMode',
    label: 'Agent Mode',
    value: () => config.get('agentMode') === 'auto' ? 'Auto' : 'Manual',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'manual', label: 'Manual' },
    ],
  },
];

export const Settings: React.FC<SettingsProps> = ({ onClose, notify }) => {
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      if (editing) {
        setEditing(false);
        setEditValue('');
      } else {
        onClose();
      }
      return;
    }

    if (editing) {
      // Handle editing mode
      if (key.return) {
        const setting = SETTINGS[selected];
        if (setting.type === 'number') {
          const num = parseFloat(editValue);
          if (!isNaN(num)) {
            const clamped = Math.max(setting.min || 0, Math.min(setting.max || Infinity, num));
            config.set(setting.key as any, clamped);
            
            // Update rate limiters if changed
            if (setting.key === 'rateLimitApi' || setting.key === 'rateLimitCommands') {
              updateRateLimits();
            }
            
            notify(`${setting.label}: ${clamped}`);
          }
        }
        setEditing(false);
        setEditValue('');
      } else if (key.backspace || key.delete) {
        setEditValue(v => v.slice(0, -1));
      } else if (/^[0-9.]$/.test(input)) {
        setEditValue(v => v + input);
      }
      return;
    }

    // Navigation mode
    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1));
    } else if (key.downArrow) {
      setSelected(s => Math.min(SETTINGS.length - 1, s + 1));
    } else if (key.leftArrow || key.rightArrow) {
      // Adjust value with arrows
      const setting = SETTINGS[selected];
      if (setting.type === 'number') {
        const current = setting.value() as number;
        const step = setting.step || 1;
        const delta = key.leftArrow ? -step : step;
        const newValue = Math.max(setting.min || 0, Math.min(setting.max || Infinity, current + delta));
        config.set(setting.key as any, newValue);
        
        // Update rate limiters if changed
        if (setting.key === 'rateLimitApi' || setting.key === 'rateLimitCommands') {
          updateRateLimits();
        }
      } else if (setting.type === 'select' && setting.options) {
        const current = config.get(setting.key as any);
        const currentIdx = setting.options.findIndex(o => o.value === current);
        const newIdx = key.leftArrow 
          ? Math.max(0, currentIdx - 1)
          : Math.min(setting.options.length - 1, currentIdx + 1);
        config.set(setting.key as any, setting.options[newIdx].value as any);
      }
    } else if (key.return) {
      const setting = SETTINGS[selected];
      if (setting.type === 'number') {
        setEditing(true);
        setEditValue(String(setting.value()));
      } else if (setting.type === 'select' && setting.options) {
        // Toggle select options
        const current = config.get(setting.key as any);
        const currentIdx = setting.options.findIndex(o => o.value === current);
        const newIdx = (currentIdx + 1) % setting.options.length;
        config.set(setting.key as any, setting.options[newIdx].value as any);
        notify(`${setting.label}: ${setting.options[newIdx].label}`);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Settings</Text>
      <Text> </Text>
      
      {SETTINGS.map((setting, i) => (
        <Box key={setting.key}>
          <Text>
            {i === selected ? <Text color="#f02a30">▸ </Text> : '  '}
            <Text color={i === selected ? '#f02a30' : undefined}>{setting.label}:</Text>
            <Text> </Text>
            {editing && i === selected ? (
              <Text color="cyan" inverse>{editValue || ' '}</Text>
            ) : (
              <Text color="green">{setting.value()}</Text>
            )}
            {i === selected && setting.type === 'number' && !editing && (
              <Text> (←/→ adjust, Enter to type)</Text>
            )}
            {i === selected && setting.type === 'select' && (
              <Text> (←/→ or Enter to toggle)</Text>
            )}
          </Text>
        </Box>
      ))}

      <Text> </Text>
      <Text>↑/↓ Navigate  |  ←/→ Adjust  |  Enter Edit  |  Esc Close</Text>
    </Box>
  );
};
