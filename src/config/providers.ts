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
  /** Provider's OpenAI-compatible endpoint rejects `tools` together with
   *  `stream: true` (Alibaba/Qwen DashScope). When true, agent turns that send
   *  tools are issued non-streamed (we buffer the full response). */
  noStreamWithTools?: boolean;
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
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model, available to all users' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant, available to all users' },
    ],
    defaultModel: 'glm-5.2',
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
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
    ],
    defaultModel: 'glm-5.2',
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
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model, available to all users' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant, available to all users' },
    ],
    defaultModel: 'glm-5.2',
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
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Latest GLM model' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
    ],
    defaultModel: 'glm-5.2',
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
  // ── Kimi (Moonshot AI) ────────────────────────────────────────────
  // Subscription (Kimi Code) mirrors the Z.AI GLM-Coding-Plan shape: a
  // dedicated coding base URL + a separate key, model id ALWAYS
  // `kimi-for-coding` (a backend alias). OpenAI-compatible is the
  // battle-tested path so we don't expose the Anthropic surface here.
  'kimi': {
    name: 'Kimi (Moonshot) — Coding Plan',
    description: 'Kimi Code subscription',
    protocols: {
      openai: { baseUrl: 'https://api.kimi.com/coding/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'kimi-for-coding', name: 'Kimi Code', description: 'Subscription alias — auto-maps to the latest Kimi coding model (K2.7 Code)' },
    ],
    defaultModel: 'kimi-for-coding',
    defaultProtocol: 'openai',
    maxOutputTokens: 32_768,
    envKey: 'KIMI_CODE_API_KEY',
    subscribeUrl: 'https://www.kimi.com/code',
    groupLabel: 'Kimi — Subscription (Kimi Code)',
    hint: 'Uses your Kimi Code subscription — no per-token charges. Key from kimi.com/code/console.',
  },
  'kimi-api': {
    name: 'Kimi (Moonshot) API (pay-per-use)',
    description: 'Moonshot AI Kimi models via API key',
    protocols: {
      openai: { baseUrl: 'https://api.moonshot.ai/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'kimi-k3-code',           name: 'Kimi K3 Code',            description: 'Newest flagship agentic coding model (1M context, deep reasoning)' },
      { id: 'kimi-k3-code-highspeed', name: 'Kimi K3 Code (High-Speed)', description: 'Throughput-tuned K3 Code for latency-sensitive loops' },
      { id: 'kimi-k3-thinking',       name: 'Kimi K3 Thinking',        description: 'K3 with explicit reasoning traces (highest quality, slower)' },
      { id: 'kimi-k2.7-code',           name: 'Kimi K2.7 Code',            description: 'Previous-gen flagship agentic coding model (256K context)' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code (High-Speed)', description: 'Throughput-tuned K2.7 Code for latency-sensitive loops' },
      { id: 'kimi-k2.6',                name: 'Kimi K2.6',                 description: 'Previous-gen multimodal reasoning model' },
      { id: 'kimi-k2.5',                name: 'Kimi K2.5',                 description: 'Older general-purpose model (cheaper)' },
    ],
    defaultModel: 'kimi-k3-code',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    envKey: 'MOONSHOT_API_KEY',
    subscribeUrl: 'https://platform.kimi.ai/console/api-keys',
    groupLabel: 'Kimi — API (pay-per-use)',
    hint: 'Pay-per-use via Moonshot API key (platform.kimi.ai). K3 models support 1M context and explicit reasoning.',
  },
  'kimi-cn': {
    name: 'Kimi China (Moonshot)',
    description: 'Moonshot AI Kimi models (China)',
    protocols: {
      openai: { baseUrl: 'https://api.moonshot.cn/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'kimi-k3-code',           name: 'Kimi K3 Code',            description: 'Newest flagship agentic coding model (1M context, deep reasoning)' },
      { id: 'kimi-k3-code-highspeed', name: 'Kimi K3 Code (High-Speed)', description: 'Throughput-tuned K3 Code' },
      { id: 'kimi-k3-thinking',       name: 'Kimi K3 Thinking',        description: 'K3 with explicit reasoning traces' },
      { id: 'kimi-k2.7-code',           name: 'Kimi K2.7 Code',            description: 'Previous-gen flagship agentic coding model (256K context)' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code (High-Speed)', description: 'Throughput-tuned K2.7 Code' },
      { id: 'kimi-k2.6',                name: 'Kimi K2.6',                 description: 'Previous-gen multimodal reasoning model' },
      { id: 'kimi-k2.5',                name: 'Kimi K2.5',                 description: 'Older general-purpose model' },
    ],
    defaultModel: 'kimi-k3-code',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    envKey: 'MOONSHOT_CN_API_KEY',
    subscribeUrl: 'https://platform.moonshot.cn/console/api-keys',
    groupLabel: 'Kimi China — API (pay-per-use)',
    hint: 'Pay-per-use via Moonshot China API key (platform.moonshot.cn). K3 models support 1M context.',
  },
  // ── Grok (xAI) ────────────────────────────────────────────────────
  // Pay-per-use today (console.x.ai key). The SuperGrok / X Premium+
  // subscription is OAuth-based — added separately. Reasoning models
  // require max_completion_tokens (like GPT-5), so useMaxCompletionTokens.
  'grok': {
    name: 'Grok (xAI)',
    description: 'xAI Grok models',
    protocols: {
      openai: { baseUrl: 'https://api.x.ai/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'grok-4.5',              name: 'Grok 4.5',              description: 'Flagship reasoning model — highest quality, 500K context' },
      { id: 'grok-build-0.1',        name: 'Grok Build 0.1',        description: 'Agentic coding model — fast, 256K context' },
      { id: 'grok-4.3',              name: 'Grok 4.3',              description: 'Previous flagship, 1M context' },
      { id: 'grok-code-fast-1',      name: 'Grok Code Fast 1',      description: 'Low-cost speed-first coder (alias of Build 0.1)' },
      { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast (reasoning)', description: 'Cheap reasoning model, very large context' },
    ],
    defaultModel: 'grok-build-0.1',
    defaultProtocol: 'openai',
    useMaxCompletionTokens: true, // reasoning models reject max_tokens
    envKey: 'XAI_API_KEY',
    subscribeUrl: 'https://console.x.ai',
    groupLabel: 'xAI Grok',
    hint: 'Pay-per-use via xAI API key (console.x.ai).',
  },
  // ── Qwen (Alibaba Model Studio / DashScope) ───────────────────────
  // Coding Plan subscription = dedicated base URL + sk-sp- key (mirrors
  // Z.AI). Qwen's OpenAI-compatible surface CANNOT combine tools with
  // streaming, so all Qwen entries set noStreamWithTools.
  'qwen': {
    name: 'Qwen (Alibaba) — Coding Plan',
    description: 'Qwen Coding Plan subscription',
    protocols: {
      openai: { baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'qwen3-coder-plus', name: 'Qwen3-Coder Plus', description: 'Flagship coding model — best quality' },
      { id: 'qwen3-coder-next', name: 'Qwen3-Coder Next', description: 'Balanced quality/speed/cost' },
      { id: 'qwen3.7-max',        name: 'Qwen3.7-Max',        description: 'Flagship general model (code + reasoning)' },
    ],
    defaultModel: 'qwen3-coder-plus',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'BAILIAN_CODING_PLAN_API_KEY',
    subscribeUrl: 'https://www.alibabacloud.com/help/en/model-studio/qwen-code-coding-plan',
    groupLabel: 'Qwen — Subscription (Coding Plan)',
    hint: 'Uses your Qwen Coding Plan — no per-token charges. sk-sp-… key from Model Studio. Interactive coding use only.',
  },
  'qwen-api': {
    name: 'Qwen (Alibaba) API (pay-per-use)',
    description: 'Alibaba Model Studio Qwen models via API key',
    protocols: {
      openai: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'qwen3-coder-plus',  name: 'Qwen3-Coder Plus',  description: 'Flagship coding model (256K, up to 1M)' },
      { id: 'qwen3-coder-next',  name: 'Qwen3-Coder Next',  description: 'Balanced quality/speed/cost' },
      { id: 'qwen3-coder-flash', name: 'Qwen3-Coder Flash', description: 'Fast/cheap coder' },
      { id: 'qwen3.7-max',         name: 'Qwen3.7-Max',         description: 'Flagship general model' },
    ],
    defaultModel: 'qwen3-coder-plus',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'DASHSCOPE_API_KEY',
    subscribeUrl: 'https://modelstudio.console.alibabacloud.com/',
    groupLabel: 'Qwen — API (pay-per-use)',
    hint: 'Pay-per-use via Alibaba Model Studio key (DASHSCOPE_API_KEY).',
  },
  'qwen-cn': {
    name: 'Qwen China — Coding Plan',
    description: 'Qwen Coding Plan subscription (China)',
    protocols: {
      openai: { baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'qwen3-coder-plus', name: 'Qwen3-Coder Plus', description: 'Flagship coding model — best quality' },
      { id: 'qwen3-coder-next', name: 'Qwen3-Coder Next', description: 'Balanced quality/speed/cost' },
      { id: 'qwen3.7-max',        name: 'Qwen3.7-Max',        description: 'Flagship general model' },
    ],
    defaultModel: 'qwen3-coder-plus',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'BAILIAN_CODING_PLAN_CN_API_KEY',
    subscribeUrl: 'https://bailian.console.aliyun.com/',
    groupLabel: 'Qwen China — Subscription (Coding Plan)',
    hint: 'Uses your Qwen Coding Plan (China). sk-sp-… key from Bailian.',
  },
  'qwen-cn-api': {
    name: 'Qwen China API (pay-per-use)',
    description: 'Alibaba Model Studio Qwen models via API key (China)',
    protocols: {
      openai: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'qwen3-coder-plus',  name: 'Qwen3-Coder Plus',  description: 'Flagship coding model' },
      { id: 'qwen3-coder-next',  name: 'Qwen3-Coder Next',  description: 'Balanced quality/speed/cost' },
      { id: 'qwen3-coder-flash', name: 'Qwen3-Coder Flash', description: 'Fast/cheap coder' },
      { id: 'qwen3.7-max',         name: 'Qwen3.7-Max',         description: 'Flagship general model' },
    ],
    defaultModel: 'qwen3-coder-plus',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'DASHSCOPE_CN_API_KEY',
    subscribeUrl: 'https://bailian.console.aliyun.com/',
    groupLabel: 'Qwen China — API (pay-per-use)',
    hint: 'Pay-per-use via Alibaba Model Studio China key.',
  },
  'modelscope': {
    name: 'ModelScope (free Qwen)',
    description: 'Free Qwen3-Coder inference via ModelScope',
    protocols: {
      openai: { baseUrl: 'https://api-inference.modelscope.cn/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3-Coder 480B', description: 'Open MoE coder — free tier (~2000 req/day)' },
    ],
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'MODELSCOPE_API_KEY',
    subscribeUrl: 'https://modelscope.cn/my/myaccesstoken',
    groupLabel: 'ModelScope — Free (Qwen)',
    hint: 'Free tier (~2000 req/day) via ModelScope token (modelscope.cn). Needs a bound Aliyun account.',
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
      { id: 'gpt-5.6-sol',   name: 'GPT-5.6 Sol',   description: 'Most capable GPT — best for coding & agentic work' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Balanced — GPT-5.5 quality at about half the price' },
      { id: 'gpt-5.6-luna',  name: 'GPT-5.6 Luna',  description: 'Fast and cheap — high-volume workloads' },
      { id: 'gpt-5.5',       name: 'GPT-5.5',       description: 'Previous flagship GPT' },
      { id: 'gpt-5.4',       name: 'GPT-5.4',       description: 'Older generation GPT' },
      { id: 'gpt-5.4-mini',  name: 'GPT-5.4 Mini',  description: 'Faster and cheaper GPT-5.4' },
    ],
    defaultModel: 'gpt-5.6-sol',
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
      { id: 'claude-fable-5',            name: 'Claude Fable 5',        description: 'Most capable — hardest reasoning & long-horizon agentic work' },
      { id: 'claude-opus-5',             name: 'Claude Opus 5',         description: 'Complex agentic coding & deep reasoning — the Opus workhorse' },
      { id: 'claude-sonnet-5',           name: 'Claude Sonnet 5',       description: 'Best balance of speed and intelligence' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku',          description: 'Fastest and most affordable' },
    ],
    defaultModel: 'claude-opus-5',
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
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro',        description: 'Most capable Gemini model' },
      { id: 'gemini-3.5-flash',       name: 'Gemini 3.5 Flash',      description: 'Pro-level intelligence at Flash speed' },
      { id: 'gemini-3.1-flash-lite',  name: 'Gemini 3.1 Flash-Lite', description: 'Low-latency, low-cost workhorse (1M context)' },
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
      { id: 'anthropic/claude-fable-5',         name: 'Claude Fable 5',     description: 'Anthropic — most capable' },
      { id: 'anthropic/claude-opus-4',          name: 'Claude Opus 4',      description: 'Anthropic — Opus tier' },
      { id: 'anthropic/claude-sonnet-5',        name: 'Claude Sonnet 5',    description: 'Anthropic — balanced' },
      { id: 'openai/gpt-5.6-sol',               name: 'GPT-5.6 Sol',        description: 'OpenAI — flagship' },
      { id: 'openai/gpt-5.4-mini',              name: 'GPT-5.4 Mini',       description: 'OpenAI — fast/cheap' },
      { id: 'google/gemini-3.1-pro',            name: 'Gemini 3.1 Pro',     description: 'Google — multimodal' },
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B',   description: 'Meta — open weights, largest' },
      { id: 'meta-llama/llama-3.1-70b-instruct',  name: 'Llama 3.1 70B',    description: 'Meta — open weights, fast' },
      { id: 'deepseek/deepseek-v4',             name: 'DeepSeek V4',        description: 'DeepSeek via OpenRouter' },
      { id: 'mistralai/mistral-large',          name: 'Mistral Large',      description: 'Mistral — flagship' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', description: 'Alibaba — coding-tuned' },
      { id: 'x-ai/grok-4.5',                    name: 'Grok 4.5',           description: 'xAI — flagship reasoning' },
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
  'kimi',
  'kimi-api',
  'qwen',
  'qwen-api',
  'grok',
  'deepseek',
  'google',
  'minimax',
  'minimax-api',
  'modelscope',
  'ollama',
  'custom',
  // Regional + parameter-variant entries trail.
  'z.ai-cn',
  'z.ai-cn-api',
  'kimi-cn',
  'qwen-cn',
  'qwen-cn-api',
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
 * Returns true if the provider's OpenAI-compatible endpoint rejects `tools`
 * together with `stream: true` (Alibaba/Qwen) — callers must issue tool-bearing
 * agent turns non-streamed.
 */
export function providerNoStreamWithTools(providerId: string): boolean {
  return PROVIDERS[providerId]?.noStreamWithTools ?? false;
}

/**
 * Models that reject sampling parameters (temperature/top_p/top_k) with a 400.
 * Anthropic removed them on Fable 5 and Opus 4.7+, and Sonnet 5 rejects any
 * non-default value; older Claude models still accept them, so this must be a
 * MODEL-level check, not a provider-level one (requiresDefaultTemperature
 * can't express it). Omitting the field is always safe — the API treats
 * omission as default. Kimi K2.x code/thinking models fix temperature
 * internally and 400 on any custom value, so they're here too.
 */
const SAMPLING_PARAMS_REJECTED = [
  'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5',
  'kimi-k3-code', 'kimi-k3-thinking', 'kimi-k2.7-code', 'kimi-for-coding',
];

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

// ---------------------------------------------------------------------------
// Thinking / reasoning-effort tiers
// ---------------------------------------------------------------------------

/**
 * Unified, user-facing thinking-effort tiers (the `/thinking` setting).
 *
 *   'auto'  — omit the param entirely → each provider's own default.
 *   low / medium / high / max — four explicit depth tiers.
 *
 * The four tiers are CONCEPTUAL. `reasoningParamsFor()` clamps each one to the
 * nearest level the active provider+model actually accepts, so we never send a
 * value that would 400 (e.g. Gemini rejects "medium"; OpenAI has no "max").
 * The control is a pure DEPTH knob on models that already think — it never
 * toggles thinking on/off, which keeps us clear of the reasoning_content-replay
 * contract that DeepSeek/GLM impose when thinking mode is flipped.
 */
export type ReasoningTier = 'auto' | 'low' | 'medium' | 'high' | 'max';

export const REASONING_TIERS: ReasoningTier[] = ['auto', 'low', 'medium', 'high', 'max'];

/**
 * Canonicalize a model id for capability matching: lowercase, drop any
 * `vendor/` namespace (OpenRouter sends `anthropic/claude-opus-4.8`), and
 * normalize `.` version separators to `-` (`glm-5.2` → `glm-5-2`,
 * `claude-opus-4.8` → `claude-opus-4-8`). Mirrors macOS `ModelTuning.canonicalModelID`.
 */
export function canonicalModelId(model: string): string {
  let id = model.toLowerCase();
  const slash = id.lastIndexOf('/');
  if (slash !== -1) id = id.slice(slash + 1);
  return id.replace(/\./g, '-');
}

/** True when `id` equals `prefix` or starts with `prefix-` (catches dated variants). */
function idMatches(id: string, prefix: string): boolean {
  return id === prefix || id.startsWith(`${prefix}-`);
}

/**
 * Does this provider+model expose a GRADED thinking-effort control we can drive?
 * Used to gate the `/thinking` UI — hidden entirely for models without one.
 * Keep in lockstep with macOS `ModelTuning.reasoningEffortSupported`.
 */
export function modelSupportsReasoningEffort(providerId: string, model: string): boolean {
  const id = canonicalModelId(model);
  switch (providerId) {
    case 'anthropic':
      // Effort is GA on Opus 5, Opus 4.5+, Sonnet 4.6/5, Fable 5 — NOT Haiku or Sonnet 4.5.
      if (idMatches(id, 'claude-haiku-4-5') || idMatches(id, 'claude-sonnet-4-5')) return false;
      return /^claude-(opus-5|opus-4-([5-9]|\d\d)|sonnet-(4-6|5)|fable-5)/.test(id);
    case 'openai':
      // GPT-5.x are reasoning models — reasoning_effort across the family (incl. mini).
      return id.startsWith('gpt-5');
    case 'google':
      // Gemini 3.x thinking_level via the OpenAI-compat reasoning_effort mapping.
      return id.startsWith('gemini-3');
    case 'deepseek':
      return id.startsWith('deepseek-v4');
    case 'z.ai': case 'z.ai-api': case 'z.ai-cn': case 'z.ai-cn-api':
      // GLM-5.2 added graded High/Max effort. glm-5-turbo is a plain thinking
      // toggle (no graded levels) so it stays out.
      return idMatches(id, 'glm-5-2');
    case 'grok':
      // Grok reasoning models accept reasoning_effort (none/low/medium/high).
      // The coders (grok-code-fast, grok-build — the default) are NON-reasoning
      // and 400 on reasoning_effort; a 400 here silently drops the whole turn
      // into the weaker text-tool fallback (agentChat.ts), so exclude them
      // alongside the explicit *-non-reasoning variants.
      if (id.startsWith('grok-build') || id.startsWith('grok-code')) return false;
      return id.startsWith('grok') && !id.includes('non-reasoning');
    // Kimi (thinking on/off, not graded) and Qwen coders (non-thinking) have
    // no graded knob → fall through to default false.
    case 'openrouter':
      // OpenRouter normalizes a unified `reasoning` field and silently ignores
      // it for non-reasoning models, so the control is always safe to expose.
      return true;
    default:
      // minimax (toggle only), ollama, custom — no graded depth knob.
      return false;
  }
}

/**
 * Build the request-body fields that carry the chosen effort tier for the
 * active provider+model+protocol. Returns `{}` for 'auto', unsupported
 * models, or providers without a graded knob — so callers can spread it
 * unconditionally. Keep in lockstep with macOS `ModelTuning.reasoningParams`.
 */
export function reasoningParamsFor(
  providerId: string,
  model: string,
  tier: ReasoningTier,
): Record<string, unknown> {
  // 'auto', or any unexpected value from an older/garbled config, → no param.
  // (Guards against ever emitting e.g. `effort: undefined`, which could 400.)
  if (tier === 'auto' || !REASONING_TIERS.includes(tier)) return {};
  if (!modelSupportsReasoningEffort(providerId, model)) return {};

  switch (providerId) {
    case 'anthropic':
      // low / medium / high / max — all valid on the capable Claude models.
      return { output_config: { effort: tier } };
    case 'openai':
      // none/low/medium/high/xhigh — no "max"; map our Max → xhigh (the ceiling).
      return { reasoning_effort: tier === 'max' ? 'xhigh' : tier };
    case 'google':
      // Gemini 3 (OpenAI-compat) accepts ONLY low/high — "medium" 400s.
      return { reasoning_effort: tier === 'low' ? 'low' : 'high' };
    case 'deepseek':
    case 'z.ai': case 'z.ai-api': case 'z.ai-cn': case 'z.ai-cn-api':
      // Graded thinking depth: high (default) or max. Lower tiers collapse to high.
      return { reasoning_effort: tier === 'max' ? 'max' : 'high' };
    case 'grok':
      // none/low/medium/high — no "max"; map our Max → high (the ceiling).
      return { reasoning_effort: tier === 'max' ? 'high' : tier };
    case 'openrouter':
      // Unified reasoning object; no "max" effort → cap at high.
      return { reasoning: { effort: tier === 'max' ? 'high' : tier } };
    default:
      return {};
  }
}

/**
 * The DISTINCT tiers a given provider+model actually exposes — used to build a
 * per-model picker that only offers levels the model can tell apart (e.g.
 * GLM-5.2/DeepSeek grade only high|max; Gemini via the OpenAI-compat layer only
 * low|high). Always leads with 'auto'. `[]` for models with no graded knob.
 *
 * Kept in lockstep with `reasoningParamsFor` (the providers-test asserts every
 * listed tier yields a DISTINCT param, so this can't silently drift). Mirrors
 * macOS `ModelTuning.availableReasoningTiers`.
 */
export function availableReasoningTiers(providerId: string, model: string): ReasoningTier[] {
  if (!modelSupportsReasoningEffort(providerId, model)) return [];
  switch (providerId) {
    case 'anthropic':
    case 'openai':
      return ['auto', 'low', 'medium', 'high', 'max'];
    case 'google':
      // OpenAI-compat layer accepts only low/high — "medium" 400s.
      return ['auto', 'low', 'high'];
    case 'deepseek':
    case 'z.ai': case 'z.ai-api': case 'z.ai-cn': case 'z.ai-cn-api':
      return ['auto', 'high', 'max'];
    case 'grok':
      return ['auto', 'low', 'medium', 'high'];
    case 'openrouter':
      return ['auto', 'low', 'medium', 'high'];
    default:
      return [];
  }
}

/**
 * Map a (possibly out-of-range) tier to the tier this model actually distinguishes,
 * for display — the chip + the checked menu row. The effort setting is global, so
 * a tier picked on Opus ('low') may not exist on GLM-5.2; we show the level GLM
 * will really run (its 'low' clamps to 'high'). Picks the available tier whose
 * effective param equals the requested one. 'auto' (or unsupported) → 'auto'.
 */
export function resolveReasoningTier(providerId: string, model: string, tier: ReasoningTier): ReasoningTier {
  if (tier === 'auto') return 'auto';
  const avail = availableReasoningTiers(providerId, model);
  if (avail.length === 0) return 'auto';
  if (avail.includes(tier)) return tier;
  const target = JSON.stringify(reasoningParamsFor(providerId, model, tier));
  for (const t of avail) {
    if (t === 'auto') continue;
    if (JSON.stringify(reasoningParamsFor(providerId, model, t)) === target) return t;
  }
  return 'auto';
}
