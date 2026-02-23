// src/acp/commands.ts
// Slash command handler for ACP sessions.
// Commands are intercepted before the agent loop and handled directly.

import { config, setProvider, getModelsForCurrentProvider, setApiKey, getMaskedApiKey } from '../config/index.js';
import { PROVIDERS } from '../config/providers.js';

export interface CommandResult {
  handled: boolean;
  response: string;
}

/**
 * Try to handle a slash command. Returns { handled: true, response } if the
 * input was a command, or { handled: false, response: '' } to let it pass
 * through to the agent loop.
 */
export function handleCommand(input: string): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false, response: '' };

  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'help':
      return { handled: true, response: buildHelp() };

    case 'settings':
      return { handled: true, response: buildSettings() };

    case 'provider': {
      const id = args[0];
      if (!id) return { handled: true, response: buildProviderList() };
      return { handled: true, response: setProviderCmd(id) };
    }

    case 'model': {
      const id = args[0];
      if (!id) return { handled: true, response: buildModelList() };
      return { handled: true, response: setModelCmd(id) };
    }

    case 'apikey': {
      const key = args[0];
      if (!key) return { handled: true, response: showApiKey() };
      return { handled: true, response: setApiKeyCmd(key) };
    }

    case 'status':
      return { handled: true, response: buildSettings() };

    default:
      return {
        handled: true,
        response: `Unknown command: \`/${cmd}\`\n\nType \`/help\` to see available commands.`,
      };
  }
}

// ─── renderers ────────────────────────────────────────────────────────────────

function buildHelp(): string {
  return [
    '## Codeep Commands',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `/help` | Show this help |',
    '| `/settings` | Show current configuration |',
    '| `/provider` | List available providers |',
    '| `/provider <id>` | Switch to a provider (e.g. `/provider anthropic`) |',
    '| `/model` | List models for current provider |',
    '| `/model <id>` | Switch model (e.g. `/model claude-opus-4-5`) |',
    '| `/apikey <key>` | Set API key for current provider |',
    '| `/apikey` | Show masked API key |',
    '| `/status` | Same as /settings |',
  ].join('\n');
}

function buildSettings(): string {
  const provider = config.get('provider');
  const model = config.get('model');
  const protocol = config.get('protocol');
  const maskedKey = getMaskedApiKey(provider);
  const providerConfig = PROVIDERS[provider];

  return [
    '## Current Configuration',
    '',
    `- **Provider:** ${providerConfig?.name ?? provider} (\`${provider}\`)`,
    `- **Model:** \`${model}\``,
    `- **Protocol:** \`${protocol}\``,
    `- **API Key:** ${maskedKey ? `\`${maskedKey}\`` : '_not set_'}`,
    '',
    'Use `/provider`, `/model`, or `/apikey` to change settings.',
  ].join('\n');
}

function buildProviderList(): string {
  const current = config.get('provider');
  const lines = ['## Available Providers', ''];

  for (const [id, p] of Object.entries(PROVIDERS)) {
    const marker = id === current ? ' ✓' : '';
    lines.push(`- \`${id}\`${marker} — **${p.name}**: ${p.description}`);
  }

  lines.push('', 'Use `/provider <id>` to switch.');
  return lines.join('\n');
}

function setProviderCmd(id: string): string {
  if (!PROVIDERS[id]) {
    return `Provider \`${id}\` not found.\n\n${buildProviderList()}`;
  }
  setProvider(id);
  const p = PROVIDERS[id];
  return `Switched to **${p.name}** (\`${id}\`). Default model: \`${p.defaultModel}\`.`;
}

function buildModelList(): string {
  const current = config.get('model');
  const models = getModelsForCurrentProvider();
  const lines = ['## Models for Current Provider', ''];

  for (const [id, label] of Object.entries(models)) {
    const marker = id === current ? ' ✓' : '';
    lines.push(`- \`${id}\`${marker} — ${label}`);
  }

  lines.push('', 'Use `/model <id>` to switch.');
  return lines.join('\n');
}

function setModelCmd(id: string): string {
  const models = getModelsForCurrentProvider();
  if (!models[id]) {
    return `Model \`${id}\` not available for current provider.\n\n${buildModelList()}`;
  }
  config.set('model', id);
  return `Model set to \`${id}\`.`;
}

function showApiKey(): string {
  const provider = config.get('provider');
  const masked = getMaskedApiKey(provider);
  return masked
    ? `API key for \`${provider}\`: \`${masked}\``
    : `No API key set for \`${provider}\`. Use \`/apikey <key>\` to set one.`;
}

function setApiKeyCmd(key: string): string {
  const provider = config.get('provider');
  setApiKey(key, provider);
  return `API key for \`${provider}\` saved.`;
}
