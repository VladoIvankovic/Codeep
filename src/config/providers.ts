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
  envKey?: string; // Environment variable name for API key
  subscribeUrl?: string; // URL to get API key
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
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM model (Pro/Max subscription)' },
      { id: 'glm-4.7', name: 'GLM-4.7', description: 'Latest GLM model' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', description: 'Faster, lighter version' },
    ],
    defaultModel: 'glm-4.7',
    defaultProtocol: 'openai',
    envKey: 'ZAI_API_KEY',
    subscribeUrl: 'https://z.ai/subscribe?ic=NXYNXZOV14',
    mcpEndpoints: {
      webSearch: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
      webReader: 'https://api.z.ai/api/mcp/web_reader/mcp',
      zread: 'https://api.z.ai/api/mcp/zread/mcp',
    },
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
      { id: 'glm-5', name: 'GLM-5', description: 'Most capable GLM model (Pro/Max subscription)' },
      { id: 'glm-4.7', name: 'GLM-4.7', description: 'Latest GLM model' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', description: 'Faster, lighter version' },
    ],
    defaultModel: 'glm-4.7',
    defaultProtocol: 'openai',
    envKey: 'ZAI_CN_API_KEY',
    subscribeUrl: 'https://open.bigmodel.cn/glm-coding',
    mcpEndpoints: {
      webSearch: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
      webReader: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
      zread: 'https://open.bigmodel.cn/api/mcp/zread/mcp',
    },
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
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', description: 'Latest MiniMax coding model' },
    ],
    defaultModel: 'MiniMax-M2.5',
    defaultProtocol: 'anthropic',
    envKey: 'MINIMAX_API_KEY',
    subscribeUrl: 'https://platform.minimax.io/subscribe/coding-plan?code=2lWvoWUhrp&source=link',
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
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', description: 'Latest MiniMax coding model' },
    ],
    defaultModel: 'MiniMax-M2.5',
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
      { id: 'deepseek-chat', name: 'DeepSeek V3', description: 'Latest general-purpose model' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', description: 'Reasoning model with chain-of-thought' },
    ],
    defaultModel: 'deepseek-chat',
    defaultProtocol: 'openai',
    maxOutputTokens: 8192, // DeepSeek API limit
    envKey: 'DEEPSEEK_API_KEY',
    subscribeUrl: 'https://platform.deepseek.com/sign_up',
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
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Latest Sonnet — best balance of speed and intelligence' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most capable model' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', description: 'Previous generation Sonnet' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fastest and most affordable' },
    ],
    defaultModel: 'claude-sonnet-4-6',
    defaultProtocol: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
  },
};

export type ProviderId = keyof typeof PROVIDERS;

export function getProvider(id: string): ProviderConfig | null {
  return PROVIDERS[id] || null;
}

export function getProviderList(): { id: string; name: string; description: string; subscribeUrl?: string }[] {
  return Object.entries(PROVIDERS).map(([id, config]) => ({
    id,
    name: config.name,
    description: config.description,
    subscribeUrl: config.subscribeUrl,
  }));
}

export function getProviderModels(providerId: string): { id: string; name: string; description: string }[] {
  const provider = PROVIDERS[providerId];
  return provider ? provider.models : [];
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
  return provider.protocols[protocol]?.supportsNativeTools ?? true; // Default to true
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
