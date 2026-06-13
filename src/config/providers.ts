/**
 * Provider configurations for different AI services
 */

export interface ProviderConfig {
  name: string;
  description: string;
  protocols: {
    openai?: {
      baseUrl: string;
      authHeader: 'Bearer' | 'x-api-key';
      supportsNativeTools?: boolean; // Whether native tool calling works
    };
    anthropic?: {
      baseUrl: string;
      authHeader: 'Bearer' | 'x-api-key';
      supportsNativeTools?: boolean; // Whether native tool calling works
    };
  };
  models: {
    id: string;
    name: string;
    description: string;
  }[];
  defaultModel: string;
  defaultProtocol: 'openai' | 'anthropic';
  maxOutputTokens?: number; // Provider-specific max output tokens limit
  useMaxCompletionTokens?: boolean; // Use max_completion_tokens instead of max_tokens (e.g. OpenAI GPT-5+)
  requiresDefaultTemperature?: boolean; // Provider rejects custom temperature (e.g. OpenAI GPT-5+ only allows 1)
  envKey?: string; // Environment variable name for API key
  subscribeUrl?: string; // URL to get API key
  noApiKey?: boolean; // Provider doesn't require an API key (e.g. Ollama)
  dynamicModels?: boolean; // Models are fetched dynamically at runtime
  // UI metadata exposed to ACP clients (Codeep VS Code extension, etc.) so
  // they don't have to hardcode their own copy of the provider list. Keep these
  // strings short and human-readable — they show up in dropdowns and hints.
  groupLabel?: string; // Heading shown in grouped model selectors / settings
  hint?: string;       // One-line hint about pricing/auth model
  mcpEndpoints?: { // Z.AI MCP service endpoints
    webSearch?: string;
    webReader?: string;
    zread?: string;
  };
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  'z.ai': {
    name: 'Z.AI (ZhipuAI)',
    description: 'GLM Coding Plan',
    protocols: {
      openai: {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
      anthropic: {
        baseUrl: 'https://api.z.ai/api/anthropic',
        authHeader: 'x-api-key',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'glm-5.2[1m]', name: 'GLM-5.2 (1M)', description: 'Latest GLM model with 1M context, available to all users' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model, available to all users' },
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Previous GLM model, available to all users' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant, available to all users' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM-5 model (Pro/Max plan only)' },
    ],
    defaultModel: 'glm-5.2[1m]',
    defaultProtocol: 'openai',
    envKey: 'ZAI_API_KEY',
    subscribeUrl: 'https://z.ai/subscribe?ic=NXYNXZOV14',
    groupLabel: 'Z.AI — Subscription (GLM Coding Plan)',
    hint: 'Uses your Z.AI subscription — no per-token charges.',
    mcpEndpoints: {
      webSearch: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
      webReader: 'https://api.z.ai/api/mcp/web_reader/mcp',
      zread: 'https://api.z.ai/api/mcp/zread/mcp',
    },
  },
  'z.ai-api': {
    name: 'Z.AI API (pay-per-use)',
    description: 'ZhipuAI GLM models via API key',
    protocols: {
      openai: {
        baseUrl: 'https://api.z.ai/api/paas/v4',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'glm-5.2[1m]', name: 'GLM-5.2 (1M)', description: 'Latest GLM model with 1M context' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model' },
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Previous GLM model' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM-5 model' },
    ],
    defaultModel: 'glm-5.2[1m]',
    defaultProtocol: 'openai',
    envKey: 'ZAI_API_KEY',
    subscribeUrl: 'https://api.z.ai',
    groupLabel: 'Z.AI — API (pay-per-use)',
    hint: 'Pay-per-use via Z.AI API key (zai.ai → API Keys).',
  },
  'z.ai-cn': {
    name: 'Z.AI China (ZhipuAI)',
    description: 'GLM Coding Plan (China)',
    protocols: {
      openai: {
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
      anthropic: {
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        authHeader: 'x-api-key',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'glm-5.2[1m]', name: 'GLM-5.2 (1M)', description: 'Latest GLM model with 1M context, available to all users' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model, available to all users' },
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Previous GLM model, available to all users' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant, available to all users' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM-5 model (Pro/Max plan only)' },
    ],
    defaultModel: 'glm-5.2[1m]',
    defaultProtocol: 'openai',
    envKey: 'ZAI_CN_API_KEY',
    subscribeUrl: 'https://open.bigmodel.cn/glm-coding',
    groupLabel: 'Z.AI China — Subscription (GLM Coding Plan)',
    hint: 'Uses your ZhipuAI China subscription.',
    mcpEndpoints: {
      webSearch: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
      webReader: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
      zread: 'https://open.bigmodel.cn/api/mcp/zread/mcp',
    },
  },
  'z.ai-cn-api': {
    name: 'Z.AI China API (pay-per-use)',
    description: 'ZhipuAI GLM models via BigModel API key (China)',
    protocols: {
      openai: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'glm-5.2[1m]', name: 'GLM-5.2 (1M)', description: 'Latest GLM model with 1M context' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model' },
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Previous GLM model' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM-5 model' },
    ],
    defaultModel: 'glm-5.2[1m]',
    defaultProtocol: 'openai',
    envKey: 'ZAI_CN_API_KEY',
    subscribeUrl: 'https://open.bigmodel.cn',
    groupLabel: 'Z.AI China — API (pay-per-use)',
    hint: 'Pay-per-use via ZhipuAI China API key.',
  },
  'minimax': {
    name: 'MiniMax',
    description: 'MiniMax Coding Plan',
    protocols: {
      openai: {
        baseUrl: 'https://api.minimax.io/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
      anthropic: {
        baseUrl: 'https://api.minimax.io/anthropic',
        authHeader: 'x-api-key',
        supportsNativeTools: false, // MiniMax Anthropic doesn't support native tools properly
      },
    },
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', description: 'Latest MiniMax model' },
    ],
    defaultModel: 'MiniMax-M3',
    defaultProtocol: 'anthropic',
    envKey: 'MINIMAX_API_KEY',
    subscribeUrl: 'https://platform.minimax.io/subscribe/coding-plan?code=2lWvoWUhrp&source=link',
    groupLabel: 'MiniMax — Subscription',
    hint: 'Uses your MiniMax subscription — no per-token charges.',
  },
  'minimax-api': {
    name: 'MiniMax API (pay-per-use)',
    description: 'MiniMax models via API key',
    protocols: {
      openai: {
        baseUrl: 'https://api.minimax.io/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', description: 'Latest MiniMax model' },
    ],
    defaultModel: 'MiniMax-M3',
    defaultProtocol: 'openai',
    envKey: 'MINIMAX_API_KEY',
    subscribeUrl: 'https://platform.minimax.io',
    groupLabel: 'MiniMax — API (pay-per-use)',
    hint: 'Pay-per-use via MiniMax API key (minimaxi.com → API Keys).',
  },
  'minimax-cn': {
    name: 'MiniMax China',
    description: 'MiniMax Coding Plan (China)',
    protocols: {
      openai: {
        baseUrl: 'https://api.minimaxi.com/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
      anthropic: {
        baseUrl: 'https://api.minimaxi.com/anthropic',
        authHeader: 'x-api-key',
        supportsNativeTools: false,
      },
    },
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', description: 'Latest MiniMax model' },
    ],
    defaultModel: 'MiniMax-M3',
    defaultProtocol: 'anthropic',
    envKey: 'MINIMAX_CN_API_KEY',
    subscribeUrl: 'https://platform.minimaxi.com',
    groupLabel: 'MiniMax China — Subscription',
    hint: 'Uses your MiniMax China subscription.',
  },
  'deepseek': {
    name: 'DeepSeek',
    description: 'DeepSeek AI models',
    protocols: {
      openai: {
        baseUrl: 'https://api.deepseek.com',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
      anthropic: {
        baseUrl: 'https://api.deepseek.com/anthropic',
        authHeader: 'x-api-key',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro',   description: 'Most capable DeepSeek model (1M context, thinking mode)' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Fast and affordable DeepSeek model (1M context)' },
    ],
    defaultModel: 'deepseek-v4-pro',
    defaultProtocol: 'openai',
    maxOutputTokens: 384_000, // DeepSeek V4 max output
    envKey: 'DEEPSEEK_API_KEY',
    subscribeUrl: 'https://platform.deepseek.com/sign_up',
    groupLabel: 'DeepSeek',
    hint: 'Pay-per-use via DeepSeek API key (platform.deepseek.com).',
  },
  'openai': {
    name: 'OpenAI',
    description: 'GPT and o-series models',
    protocols: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'gpt-5.5',      name: 'GPT-5.5',       description: 'Latest GPT model — best for coding' },
      { id: 'gpt-5.4',      name: 'GPT-5.4',       description: 'Previous generation GPT' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini',  description: 'Faster and cheaper GPT-5.4' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano',  description: 'Most affordable, great for simple tasks' },
    ],
    defaultModel: 'gpt-5.5',
    defaultProtocol: 'openai',
    useMaxCompletionTokens: true,
    requiresDefaultTemperature: true,
    envKey: 'OPENAI_API_KEY',
    subscribeUrl: 'https://platform.openai.com/api-keys',
    groupLabel: 'OpenAI',
    hint: 'Pay-per-use via OpenAI API key (platform.openai.com).',
  },
  'anthropic': {
    name: 'Anthropic',
    description: 'Claude AI models',
    protocols: {
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        authHeader: 'x-api-key',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'claude-fable-5',            name: 'Claude Fable 5',        description: 'Most powerful — new tier above Opus' },
      { id: 'claude-opus-4-8',           name: 'Claude Opus 4.8',       description: 'Most capable Opus model' },
      { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet',         description: 'Best balance of speed and intelligence' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku',          description: 'Fastest and most affordable' },
    ],
    defaultModel: 'claude-opus-4-8',
    defaultProtocol: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    groupLabel: 'Anthropic',
    hint: 'Pay-per-use via Anthropic API key (console.anthropic.com).',
  },
  'google': {
    name: 'Google AI',
    description: 'Gemini models',
    protocols: {
      openai: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro',   description: 'Most capable Gemini model' },
      { id: 'gemini-3.5-flash',       name: 'Gemini 3.5 Flash', description: 'Pro-level intelligence at Flash speed' },
    ],
    defaultModel: 'gemini-3.1-pro-preview',
    defaultProtocol: 'openai',
    envKey: 'GOOGLE_API_KEY',
    subscribeUrl: 'https://aistudio.google.com/apikey',
    groupLabel: 'Google AI',
    hint: 'Pay-per-use via Google AI API key (aistudio.google.com).',
  },
  'openrouter': {
    name: 'OpenRouter',
    description: 'Unified access to 100+ models via one API key',
    protocols: {
      openai: {
        baseUrl: 'https://openrouter.ai/api/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    // Top 12 — the full catalog (100+) is fetched lazily via
    // fetchOpenRouterModels() because dynamicModels is true.
    // We keep these hardcoded so first-time users without network
    // get a working dropdown.
    models: [
      { id: 'openrouter/auto',                  name: 'Auto-route',         description: 'OpenRouter picks the best model for the task' },
      { id: 'anthropic/claude-opus-4',          name: 'Claude Opus 4',      description: 'Anthropic — most capable' },
      { id: 'anthropic/claude-sonnet-4',        name: 'Claude Sonnet 4',    description: 'Anthropic — balanced' },
      { id: 'openai/gpt-5.5',                   name: 'GPT-5.5',            description: 'OpenAI — flagship' },
      { id: 'openai/gpt-5.4-mini',              name: 'GPT-5.4 Mini',       description: 'OpenAI — fast/cheap' },
      { id: 'google/gemini-3.1-pro',            name: 'Gemini 3.1 Pro',     description: 'Google — multimodal' },
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B',   description: 'Meta — open weights, largest' },
      { id: 'meta-llama/llama-3.1-70b-instruct',  name: 'Llama 3.1 70B',    description: 'Meta — open weights, fast' },
      { id: 'deepseek/deepseek-v4',             name: 'DeepSeek V4',        description: 'DeepSeek via OpenRouter' },
      { id: 'mistralai/mistral-large',          name: 'Mistral Large',      description: 'Mistral — flagship' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', description: 'Alibaba — coding-tuned' },
      { id: 'x-ai/grok-2',                      name: 'Grok 2',             description: 'xAI via OpenRouter' },
    ],
    defaultModel: 'anthropic/claude-opus-4',
    defaultProtocol: 'openai',
    envKey: 'OPENROUTER_API_KEY',
    subscribeUrl: 'https://openrouter.ai/keys',
    dynamicModels: true,
    groupLabel: 'OpenRouter — Aggregator',
    hint: 'One key for 100+ models. Pay-per-use via openrouter.ai.',
  },
  'ollama': {
    name: 'Ollama (local)',
    description: 'Run models locally with Ollama',
    protocols: {
      openai: {
        baseUrl: 'http://localhost:11434/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [
      { id: 'llama3.2', name: 'Llama 3.2', description: 'Meta Llama 3.2' },
    ],
    defaultModel: 'llama3.2',
    defaultProtocol: 'openai',
    noApiKey: true,
    dynamicModels: true,
    groupLabel: 'Ollama (local)',
    hint: 'Runs locally — no API key or account needed.',
  },
  'custom': {
    name: 'Custom (OpenAI-compatible)',
    description: 'Any OpenAI-compatible endpoint — vLLM, LiteLLM, LM Studio',
    protocols: {
      openai: {
        baseUrl: 'http://localhost:8000/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
      },
    },
    models: [],
    defaultModel: '',
    defaultProtocol: 'openai',
    noApiKey: true,        // key optional — sent as Bearer only if you set one
    dynamicModels: true,
    groupLabel: 'Custom',
    hint: 'Point at any OpenAI-compatible server. Set the URL in /settings (Custom Base URL) or the OPENAI_BASE_URL env var, then pick your model with /model.',
  },
};

export type ProviderId = keyof typeof PROVIDERS;

export function getProvider(id: string): ProviderConfig | null {
  return PROVIDERS[id] || null;
}

/**
 * Curated display order for the first-run login flow + `/provider` /
 * `/login` pickers. Headline / popular providers float to the top so
 * brand-new users see them first; regional + parameter-variant entries
 * (Z.AI China, MiniMax variants) trail. Any provider id not in this
 * list is appended afterward in object-declaration order, so adding a
 * new provider to PROVIDERS without touching this list still shows up.
 */
const DISPLAY_ORDER: string[] = [
  'anthropic',
  'openai',
  'openrouter',   // 100+ models, one key — surfaced high on purpose for 2.0.0.
  'z.ai',
  'z.ai-api',
  'deepseek',
  'google',
  'minimax',
  'minimax-api',
  'ollama',
  'custom',
  'z.ai-cn',
  'z.ai-cn-api',
  'minimax-cn',
];

export function getProviderList(): { id: string; name: string; description: string; subscribeUrl?: string; noApiKey?: boolean }[] {
  const all = Object.entries(PROVIDERS);
  const byId = new Map(all);
  const ordered: typeof all = [];
  // 1) Curated order first.
  for (const id of DISPLAY_ORDER) {
    const cfg = byId.get(id);
    if (cfg) { ordered.push([id, cfg]); byId.delete(id); }
  }
  // 2) Anything else, in declaration order.
  for (const entry of all) {
    if (byId.has(entry[0])) ordered.push(entry);
  }
  return ordered.map(([id, config]) => ({
    id,
    name: config.name,
    description: config.description,
    subscribeUrl: config.subscribeUrl,
    noApiKey: config.noApiKey,
  }));
}

export function getProviderModels(providerId: string): { id: string; name: string; description: string }[] {
  const provider = PROVIDERS[providerId];
  return provider ? provider.models : [];
}

export function isNoApiKeyProvider(providerId: string): boolean {
  return PROVIDERS[providerId]?.noApiKey === true;
}

export function isDynamicModelsProvider(providerId: string): boolean {
  return PROVIDERS[providerId]?.dynamicModels === true;
}

export function getProviderBaseUrl(providerId: string, protocol: 'openai' | 'anthropic'): string | null {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  return provider.protocols[protocol]?.baseUrl || null;
}

export function getProviderAuthHeader(providerId: string, protocol: 'openai' | 'anthropic'): 'Bearer' | 'x-api-key' {
  const provider = PROVIDERS[providerId];
  if (!provider) return 'Bearer';
  return provider.protocols[protocol]?.authHeader || 'Bearer';
}

export function getProviderMcpEndpoints(providerId: string): ProviderConfig['mcpEndpoints'] | null {
  const provider = PROVIDERS[providerId];
  return provider?.mcpEndpoints || null;
}

export function supportsNativeTools(providerId: string, protocol: 'openai' | 'anthropic'): boolean {
  const provider = PROVIDERS[providerId];
  if (!provider) return false;
  return provider.protocols[protocol]?.supportsNativeTools ?? false; // Default to false (safer)
}

/**
 * Returns true if the provider uses max_completion_tokens instead of max_tokens.
 */
export function usesMaxCompletionTokens(providerId: string): boolean {
  return PROVIDERS[providerId]?.useMaxCompletionTokens ?? false;
}

/**
 * Returns true if the provider rejects custom temperature values
 * (e.g. OpenAI GPT-5+ only accepts the default of 1).
 */
export function requiresDefaultTemperature(providerId: string): boolean {
  return PROVIDERS[providerId]?.requiresDefaultTemperature ?? false;
}

/**
 * Models that reject sampling parameters (temperature/top_p/top_k) with a 400.
 * Anthropic removed them on Fable 5 and Opus 4.7+; older Claude models still
 * accept them, so this must be a MODEL-level check, not a provider-level one
 * (requiresDefaultTemperature can't express it). Omitting the field is always
 * safe — the API treats omission as default.
 */
const SAMPLING_PARAMS_REJECTED = ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7'];

export function modelRejectsSamplingParams(model: string): boolean {
  return SAMPLING_PARAMS_REJECTED.some(id => model === id || model.startsWith(`${id}-`));
}

/**
 * Returns the effective max output tokens for a provider, capped by the provider's limit.
 * Falls back to the requested value if no provider limit is set.
 */
export function getEffectiveMaxTokens(providerId: string, requested: number): number {
  const provider = PROVIDERS[providerId];
  if (!provider?.maxOutputTokens) return requested;
  return Math.min(requested, provider.maxOutputTokens);
}
