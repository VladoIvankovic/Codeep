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
  envKey?: string; // Environment variable name for API key
  subscribeUrl?: string; // URL to get API key
  noApiKey?: boolean; // Provider doesn't require an API key (e.g. Ollama)
  dynamicModels?: boolean; // Models are fetched dynamically at runtime
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
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Latest GLM model, available to all users' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant, available to all users' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM model (Pro/Max plan only)' },
    ],
    defaultModel: 'glm-5.1',
    defaultProtocol: 'openai',
    envKey: 'ZAI_API_KEY',
    subscribeUrl: 'https://z.ai/subscribe?ic=NXYNXZOV14',
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
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Latest GLM model' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM model' },
    ],
    defaultModel: 'glm-5.1',
    defaultProtocol: 'openai',
    envKey: 'ZAI_API_KEY',
    subscribeUrl: 'https://api.z.ai',
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
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Latest GLM model, available to all users' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant, available to all users' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM model (Pro/Max plan only)' },
    ],
    defaultModel: 'glm-5.1',
    defaultProtocol: 'openai',
    envKey: 'ZAI_CN_API_KEY',
    subscribeUrl: 'https://open.bigmodel.cn/glm-coding',
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
      { id: 'glm-5.1', name: 'GLM-5.1', description: 'Latest GLM model' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM model' },
    ],
    defaultModel: 'glm-5.1',
    defaultProtocol: 'openai',
    envKey: 'ZAI_CN_API_KEY',
    subscribeUrl: 'https://open.bigmodel.cn',
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
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', description: 'Latest MiniMax model' },
    ],
    defaultModel: 'MiniMax-M2.7',
    defaultProtocol: 'anthropic',
    envKey: 'MINIMAX_API_KEY',
    subscribeUrl: 'https://platform.minimax.io/subscribe/coding-plan?code=2lWvoWUhrp&source=link',
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
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', description: 'Latest MiniMax model' },
    ],
    defaultModel: 'MiniMax-M2.7',
    defaultProtocol: 'openai',
    envKey: 'MINIMAX_API_KEY',
    subscribeUrl: 'https://platform.minimax.io',
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
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', description: 'Latest MiniMax model' },
    ],
    defaultModel: 'MiniMax-M2.7',
    defaultProtocol: 'anthropic',
    envKey: 'MINIMAX_CN_API_KEY',
    subscribeUrl: 'https://platform.minimaxi.com',
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
    },
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3.2', description: 'Latest general-purpose model' },
      { id: 'deepseek-reasoner', name: 'DeepSeek V3.2 Reasoner', description: 'Reasoning model with chain-of-thought' },
    ],
    defaultModel: 'deepseek-chat',
    defaultProtocol: 'openai',
    maxOutputTokens: 8192, // DeepSeek API limit
    envKey: 'DEEPSEEK_API_KEY',
    subscribeUrl: 'https://platform.deepseek.com/sign_up',
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
      { id: 'gpt-5.4',      name: 'GPT-5.4',       description: 'Latest GPT model — best for coding' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini',  description: 'Faster and cheaper GPT-5.4' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano',  description: 'Most affordable, great for simple tasks' },
    ],
    defaultModel: 'gpt-5.4',
    defaultProtocol: 'openai',
    useMaxCompletionTokens: true,
    envKey: 'OPENAI_API_KEY',
    subscribeUrl: 'https://platform.openai.com/api-keys',
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
      { id: 'claude-opus-4-6',          name: 'Claude Opus',   description: 'Most capable Claude model' },
      { id: 'claude-sonnet-4-6',        name: 'Claude Sonnet', description: 'Best balance of speed and intelligence' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku',  description: 'Fastest and most affordable' },
    ],
    defaultModel: 'claude-opus-4-6',
    defaultProtocol: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
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
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash',   description: 'Pro-level intelligence at Flash speed' },
    ],
    defaultModel: 'gemini-3.1-pro-preview',
    defaultProtocol: 'openai',
    envKey: 'GOOGLE_API_KEY',
    subscribeUrl: 'https://aistudio.google.com/apikey',
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
  },
};

export type ProviderId = keyof typeof PROVIDERS;

export function getProvider(id: string): ProviderConfig | null {
  return PROVIDERS[id] || null;
}

export function getProviderList(): { id: string; name: string; description: string; subscribeUrl?: string; noApiKey?: boolean }[] {
  return Object.entries(PROVIDERS).map(([id, config]) => ({
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
 * Returns the effective max output tokens for a provider, capped by the provider's limit.
 * Falls back to the requested value if no provider limit is set.
 */
export function getEffectiveMaxTokens(providerId: string, requested: number): number {
  const provider = PROVIDERS[providerId];
  if (!provider?.maxOutputTokens) return requested;
  return Math.min(requested, provider.maxOutputTokens);
}
