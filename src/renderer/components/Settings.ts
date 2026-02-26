/**
 * Settings screen component
 */

import { Screen } from '../Screen';
import { fg, style } from '../ansi';
import { config } from '../../config/index';
import { updateRateLimits } from '../../utils/ratelimit';

// Primary color: #f02a30 (Codeep red)
const PRIMARY_COLOR = fg.rgb(240, 42, 48);
const PRIMARY_BRIGHT = fg.rgb(255, 80, 85);

export interface SettingItem {
  key: string;
  label: string;
  getValue: () => string | number | boolean;
  type: 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number | boolean; label: string }[];
}

export const SETTINGS: SettingItem[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    getValue: () => config.get('temperature'),
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
  },
  {
    key: 'maxTokens',
    label: 'Max Tokens',
    getValue: () => config.get('maxTokens'),
    type: 'number',
    min: 256,
    max: 32768,
    step: 256,
  },
  {
    key: 'apiTimeout',
    label: 'API Timeout (ms)',
    getValue: () => config.get('apiTimeout'),
    type: 'number',
    min: 5000,
    max: 300000,
    step: 5000,
  },
  {
    key: 'rateLimitApi',
    label: 'API Rate Limit (/min)',
    getValue: () => config.get('rateLimitApi'),
    type: 'number',
    min: 1,
    max: 300,
    step: 5,
  },
  {
    key: 'rateLimitCommands',
    label: 'Command Rate Limit (/min)',
    getValue: () => config.get('rateLimitCommands'),
    type: 'number',
    min: 10,
    max: 1000,
    step: 10,
  },
  {
    key: 'autoSave',
    label: 'Auto Save Sessions',
    getValue: () => config.get('autoSave'),
    type: 'select',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
  {
    key: 'agentMode',
    label: 'Agent Mode',
    getValue: () => config.get('agentMode'),
    type: 'select',
    options: [
      { value: 'on', label: 'ON' },
      { value: 'manual', label: 'Manual' },
      { value: 'off', label: 'OFF' },
    ],
  },
  {
    key: 'agentConfirmation',
    label: 'Agent Confirmation',
    getValue: () => config.get('agentConfirmation') || 'dangerous',
    type: 'select',
    options: [
      { value: 'never', label: 'Never' },
      { value: 'dangerous', label: 'Dangerous' },
      { value: 'always', label: 'Always' },
    ],
  },
  {
    key: 'agentApiTimeout',
    label: 'Agent API Timeout (ms)',
    getValue: () => config.get('agentApiTimeout'),
    type: 'number',
    min: 30000,
    max: 300000,
    step: 10000,
  },
  {
    key: 'agentMaxDuration',
    label: 'Agent Max Duration (min)',
    getValue: () => config.get('agentMaxDuration'),
    type: 'number',
    min: 5,
    max: 60,
    step: 5,
  },
  {
    key: 'agentMaxIterations',
    label: 'Agent Max Iterations',
    getValue: () => config.get('agentMaxIterations'),
    type: 'number',
    min: 10,
    max: 500,
    step: 10,
  },
  {
    key: 'agentAutoVerify',
    label: 'Agent Auto-Verify',
    getValue: () => config.get('agentAutoVerify'),
    type: 'select',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'build', label: 'Build only' },
      { value: 'typecheck', label: 'Typecheck only' },
      { value: 'test', label: 'Test only' },
      { value: 'all', label: 'Build + Typecheck + Test' },
    ],
  },
  {
    key: 'agentAutoCommit',
    label: 'Agent Auto-Commit',
    getValue: () => config.get('agentAutoCommit'),
    type: 'select',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
  {
    key: 'agentAutoCommitBranch',
    label: 'Auto-Commit on New Branch',
    getValue: () => config.get('agentAutoCommitBranch'),
    type: 'select',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
  {
    key: 'agentMaxFixAttempts',
    label: 'Agent Max Fix Attempts',
    getValue: () => config.get('agentMaxFixAttempts') || 3,
    type: 'number',
    min: 0,
    max: 10,
    step: 1,
  },
  {
    key: 'agentInteractive',
    label: 'Agent Interactive Mode',
    getValue: () => config.get('agentInteractive') !== false,
    type: 'select',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
];

export interface SettingsState {
  selectedIndex: number;
  editing: boolean;
  editValue: string;
}

/**
 * Format value for display
 */
function formatValue(setting: SettingItem): string {
  const value = setting.getValue();
  if (setting.type === 'select' && setting.options) {
    const option = setting.options.find(o => o.value === value);
    return option ? option.label : String(value);
  }
  return String(value);
}

/**
 * Render settings screen
 */
export function renderSettingsScreen(
  screen: Screen, 
  state: SettingsState,
  hasWriteAccess: boolean,
  hasProjectContext: boolean
): void {
  const { width, height } = screen.getSize();
  
  screen.clear();
  
  // Title
  const title = '═══ Settings ═══';
  const titleX = Math.floor((width - title.length) / 2);
  screen.write(titleX, 0, title, PRIMARY_COLOR + style.bold);
  
  // Settings list
  const startY = 2;
  const maxVisible = height - 7;
  const scrollOffset = Math.max(0, state.selectedIndex - maxVisible + 3);
  
  for (let i = 0; i < SETTINGS.length && i < maxVisible; i++) {
    const settingIdx = i + scrollOffset;
    if (settingIdx >= SETTINGS.length) break;
    
    const setting = SETTINGS[settingIdx];
    const isSelected = settingIdx === state.selectedIndex;
    const y = startY + i;
    
    // Prefix
    const prefix = isSelected ? '► ' : '  ';
    screen.write(2, y, prefix, isSelected ? PRIMARY_COLOR : '');
    
    // Label
    const labelColor = isSelected ? PRIMARY_BRIGHT : fg.white;
    screen.write(4, y, setting.label + ':', labelColor);
    
    // Value
    const valueX = 30;
    if (state.editing && isSelected) {
      screen.write(valueX, y, state.editValue + '█', fg.cyan);
    } else {
      screen.write(valueX, y, formatValue(setting), fg.green);
    }
    
    // Hint
    if (isSelected && !state.editing) {
      const hintX = valueX + formatValue(setting).length + 2;
      if (setting.type === 'number') {
        screen.write(hintX, y, '(←/→ adjust, Enter edit)', fg.gray);
      } else {
        screen.write(hintX, y, '(←/→ or Enter toggle)', fg.gray);
      }
    }
  }
  
  // Agent status message
  const agentMode = config.get('agentMode');
  const statusY = height - 4;
  let statusMessage: string;
  let statusColor: string;
  
  if (agentMode === 'on') {
    if (!hasWriteAccess || !hasProjectContext) {
      statusMessage = '⚠️  Agent needs permission - use /grant';
      statusColor = fg.yellow;
    } else {
      statusMessage = '✓ Agent will run automatically';
      statusColor = fg.green;
    }
  } else if (agentMode === 'manual') {
    statusMessage = 'ℹ️  Manual mode - use /agent <task>';
    statusColor = fg.gray;
  } else {
    statusMessage = 'ℹ️  Agent disabled';
    statusColor = fg.gray;
  }
  
  screen.write(2, statusY, statusMessage, statusColor);
  
  // Footer
  const footerY = height - 1;
  screen.write(2, footerY, '↑/↓ Navigate | ←/→ Adjust | Enter Edit | Esc Close', fg.gray);
  
  screen.showCursor(state.editing);
  screen.fullRender();
}

/**
 * Handle settings key
 * Returns: { handled: boolean, close: boolean, notify?: string }
 */
export function handleSettingsKey(
  key: string,
  ctrl: boolean,
  state: SettingsState
): { handled: boolean; close: boolean; notify?: string; newState: SettingsState } {
  const newState = { ...state };
  
  // Escape
  if (key === 'escape') {
    if (state.editing) {
      newState.editing = false;
      newState.editValue = '';
      return { handled: true, close: false, newState };
    }
    return { handled: true, close: true, newState };
  }
  
  if (state.editing) {
    // Editing mode
    if (key === 'enter') {
      const setting = SETTINGS[state.selectedIndex];
      if (setting.type === 'number') {
        const num = parseFloat(state.editValue);
        if (!isNaN(num)) {
          const clamped = Math.max(setting.min || 0, Math.min(setting.max || Infinity, num));
          config.set(setting.key as any, clamped);
          
          if (setting.key === 'rateLimitApi' || setting.key === 'rateLimitCommands') {
            updateRateLimits();
          }
          
          newState.editing = false;
          newState.editValue = '';
          return { handled: true, close: false, notify: `${setting.label}: ${clamped}`, newState };
        }
      }
      newState.editing = false;
      newState.editValue = '';
      return { handled: true, close: false, newState };
    }
    
    if (key === 'backspace') {
      newState.editValue = state.editValue.slice(0, -1);
      return { handled: true, close: false, newState };
    }
    
    if (/^[0-9.]$/.test(key)) {
      newState.editValue = state.editValue + key;
      return { handled: true, close: false, newState };
    }
    
    return { handled: true, close: false, newState };
  }
  
  // Navigation mode
  if (key === 'up') {
    newState.selectedIndex = Math.max(0, state.selectedIndex - 1);
    return { handled: true, close: false, newState };
  }
  
  if (key === 'down') {
    newState.selectedIndex = Math.min(SETTINGS.length - 1, state.selectedIndex + 1);
    return { handled: true, close: false, newState };
  }
  
  if (key === 'left' || key === 'right') {
    const setting = SETTINGS[state.selectedIndex];
    
    if (setting.type === 'number') {
      const current = setting.getValue() as number;
      const step = setting.step || 1;
      const delta = key === 'left' ? -step : step;
      const newValue = Math.max(setting.min || 0, Math.min(setting.max || Infinity, current + delta));
      config.set(setting.key as any, newValue);
      
      if (setting.key === 'rateLimitApi' || setting.key === 'rateLimitCommands') {
        updateRateLimits();
      }
      
      return { handled: true, close: false, newState };
    }
    
    if (setting.type === 'select' && setting.options) {
      const current = config.get(setting.key as any);
      const currentIdx = setting.options.findIndex(o => o.value === current);
      const newIdx = key === 'left'
        ? (currentIdx - 1 + setting.options.length) % setting.options.length
        : (currentIdx + 1) % setting.options.length;
      config.set(setting.key as any, setting.options[newIdx].value as any);
      return { handled: true, close: false, newState };
    }
    
    return { handled: true, close: false, newState };
  }
  
  if (key === 'enter') {
    const setting = SETTINGS[state.selectedIndex];
    
    if (setting.type === 'number') {
      newState.editing = true;
      newState.editValue = String(setting.getValue());
      return { handled: true, close: false, newState };
    }
    
    if (setting.type === 'select' && setting.options) {
      const current = config.get(setting.key as any);
      const currentIdx = setting.options.findIndex(o => o.value === current);
      const newIdx = (currentIdx + 1) % setting.options.length;
      config.set(setting.key as any, setting.options[newIdx].value as any);
      return { 
        handled: true, 
        close: false, 
        notify: `${setting.label}: ${setting.options[newIdx].label}`,
        newState 
      };
    }
    
    return { handled: true, close: false, newState };
  }
  
  return { handled: false, close: false, newState };
}
