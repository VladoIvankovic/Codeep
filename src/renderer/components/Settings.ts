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
  type: 'number' | 'select' | 'text';
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
    key: 'reasoningEffort',
    label: 'Thinking Effort',
    getValue: () => config.get('reasoningEffort') ?? 'auto',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto (model default)' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ],
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
    max: 10000,
    step: 50,
  },
  {
    key: 'rateLimitCommands',
    label: 'Command Rate Limit (/min)',
    getValue: () => config.get('rateLimitCommands'),
    type: 'number',
    min: 10,
    max: 10000,
    step: 100,
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
    key: 'autoSessionTitle',
    label: 'Auto Session Titles',
    getValue: () => config.get('autoSessionTitle'),
    type: 'select',
    options: [
      { value: true, label: 'On (small background API call)' },
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
    key: 'agentConfirmDeleteFile',
    label: 'Confirm: delete_file',
    getValue: () => config.get('agentConfirmDeleteFile') !== false,
    type: 'select',
    options: [
      { value: true, label: 'ON' },
      { value: false, label: 'OFF' },
    ],
  },
  {
    key: 'agentConfirmExecuteCommand',
    label: 'Confirm: execute_command',
    getValue: () => config.get('agentConfirmExecuteCommand') !== false,
    type: 'select',
    options: [
      { value: true, label: 'ON' },
      { value: false, label: 'OFF' },
    ],
  },
  {
    key: 'agentConfirmWriteFile',
    label: 'Confirm: write_file / edit_file',
    getValue: () => config.get('agentConfirmWriteFile') === true,
    type: 'select',
    options: [
      { value: false, label: 'OFF' },
      { value: true, label: 'ON' },
    ],
  },
  {
    key: 'ollamaUrl',
    label: 'Ollama URL',
    getValue: () => config.get('ollamaUrl') || 'http://localhost:11434',
    type: 'text',
  },
  {
    key: 'ollamaNativeApi',
    label: 'Ollama Native API (beta)',
    getValue: () => config.get('ollamaNativeApi'),
    type: 'select',
    options: [
      { value: false, label: 'Off (OpenAI-compatible /v1)' },
      { value: true, label: 'On — beta: native /api/chat (num_ctx + keep_alive)' },
    ],
  },
  {
    key: 'ollamaKeepAlive',
    label: 'Ollama Keep-Alive',
    getValue: () => String(config.get('ollamaKeepAlive') ?? '30m'),
    type: 'text',
  },
  {
    key: 'ollamaNumCtx',
    label: 'Ollama Context (num_ctx, 0=auto)',
    getValue: () => String(config.get('ollamaNumCtx') ?? 0),
    type: 'text',
  },
  {
    key: 'customBaseUrl',
    label: 'Custom Base URL',
    getValue: () => config.get('customBaseUrl') || '',
    type: 'text',
  },
  {
    key: 'agentApiTimeout',
    label: 'Agent API Timeout (ms)',
    getValue: () => config.get('agentApiTimeout'),
    type: 'number',
    min: 30000,
    max: 3600000,
    step: 30000,
  },
  {
    key: 'agentMaxDuration',
    label: 'Agent Max Duration (min)',
    getValue: () => config.get('agentMaxDuration'),
    type: 'number',
    min: 5,
    max: 1440,
    step: 30,
  },
  {
    key: 'agentMaxIterations',
    label: 'Agent Max Iterations',
    getValue: () => config.get('agentMaxIterations'),
    type: 'number',
    min: 10,
    // 500 is the new cap. Anything higher almost always means a stuck loop — it's
    // more useful for the agent to bail and ask than to chew tokens for an hour.
    max: 500,
    step: 5,
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
    key: 'agentAutoReview',
    label: 'Agent Auto-Review',
    getValue: () => config.get('agentAutoReview'),
    type: 'select',
    options: [
      { value: true, label: 'On (reviewer pass after changes)' },
      { value: false, label: 'Off' },
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
    getValue: () => config.get('agentMaxFixAttempts') ?? 1,
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
  {
    key: 'syncKeysToCloud',
    label: 'Sync API Keys to Cloud (server-readable)',
    getValue: () => config.get('syncKeysToCloud') === true,
    type: 'select',
    options: [
      { value: false, label: 'Off (keychain only)' },
      { value: true, label: 'On (push/sync to codeep.dev)' },
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
      if (setting.type === 'text' && state.editValue.trim()) {
        config.set(setting.key as any, state.editValue.trim());
        newState.editing = false;
        newState.editValue = '';
        return { handled: true, close: false, notify: `${setting.label}: ${state.editValue.trim()}`, newState };
      }
      newState.editing = false;
      newState.editValue = '';
      return { handled: true, close: false, newState };
    }

    if (key === 'backspace') {
      newState.editValue = state.editValue.slice(0, -1);
      return { handled: true, close: false, newState };
    }

    const setting = SETTINGS[state.selectedIndex];
    if (setting.type === 'text' && key.length === 1) {
      newState.editValue = state.editValue + key;
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
    
    if (setting.type === 'number' || setting.type === 'text') {
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
