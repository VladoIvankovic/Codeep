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
  envKey?: string; // Environment variable name for API key
  subscribeUrl?: string; // URL to get API key
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
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', description: 'Best balance of speed and intelligence' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fastest and most affordable' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most capable model' },
    ],
    defaultModel: 'claude-sonnet-4-5-20250929',
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

export function supportsNativeTools(providerId: string, protocol: 'openai' | 'anthropic'): boolean {
  const provider = PROVIDERS[providerId];
  if (!provider) return false;
  return provider.protocols[protocol]?.supportsNativeTools ?? true; // Default to true
}
