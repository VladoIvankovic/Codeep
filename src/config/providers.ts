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
      /** The provider also serves a Responses API (`POST {baseUrl}/responses`)
       *  in this dialect, and agent turns may use it — see openAIWireApi(). Only
       *  a provider that declares it can ever leave /chat/completions. */
      responses?: { dialect: 'openai' | 'xai' };
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
  /** Billed as a flat subscription (or free) — token counts are real, per-token
   *  cost is not. Cost surfaces must say "included in plan" instead of pricing
   *  these tokens at the provider's pay-per-use rates. */
  flatFee?: boolean;
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
    // The plan accepts exactly these two ("Only the following two models can be
    // called: GLM-5.3, GLM-5.3-Flash" — docs.z.ai/devpack/faq, 2026-09-23). It
    // routes GLM-5.2/5.1 to 5.3, so a 5.2 entry labelled 5.3 as an older model,
    // and Turbo is not on the plan at all: Z.AI warns other models risk
    // "unexpected charges", which a flat-fee surface would never show in /cost.
    // Stored ids migrate via RETIRED_MODEL_REPLACEMENTS.
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', description: 'Latest flagship for project-scale engineering (1M context)' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Same 1M context at roughly a ninth of the price' },
    ],
    defaultModel: 'glm-5.3',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
    envKey: 'ZAI_API_KEY',
    subscribeUrl: 'https://z.ai/subscribe?ic=NXYNXZOV14',
    groupLabel: 'Z.AI — Subscription (GLM Coding Plan)',
    flatFee: true,
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
      // GLM-5.3 reached the standalone pay-per-use API on 2026-08-18 and is
      // priced on docs.z.ai/guides/overview/pricing, as is FlashX (not on
      // either Coding Plan). GLM-5-Turbo is no longer on that price list, the
      // models overview or the OpenAPI model enum — it was last listed on
      // 2026-07-31, with no deprecation notice — so it is not offered here;
      // stored configs move to Flash. China (`z.ai-cn-api`) still sells it.
      { id: 'glm-5.3', name: 'GLM-5.3', description: 'Latest flagship for project-scale engineering (1M context)' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Same 1M context at roughly a ninth of the price' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', description: 'Faster GLM-5.3 Flash (about 200 tokens/s), 1M context' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Previous flagship for project-scale engineering (1M context)' },
    ],
    defaultModel: 'glm-5.3',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
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
    // The China plan now carries the same two models on every tier ("所有套餐均
    // 支持 GLM-5.3、GLM-5.3-Flash" — docs.bigmodel.cn/cn/coding-plan/overview) and
    // switches GLM-5.2/5.1 to 5.3 and GLM-5-Turbo to 5.3-Flash. FlashX is not on
    // the plan. Stored ids migrate via RETIRED_MODEL_REPLACEMENTS.
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', description: 'Latest flagship for project-scale engineering (1M context)' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Same 1M context, much lighter on plan quota' },
    ],
    defaultModel: 'glm-5.3',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
    envKey: 'ZAI_CN_API_KEY',
    subscribeUrl: 'https://open.bigmodel.cn/glm-coding',
    groupLabel: 'Z.AI China — Subscription (GLM Coding Plan)',
    flatFee: true,
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
      { id: 'glm-5.3', name: 'GLM-5.3', description: 'Latest flagship for project-scale engineering (1M context)' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Same 1M context at a tenth of the price' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', description: 'Faster GLM-5.3 Flash (about 200 tokens/s), 1M context' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Previous flagship for project-scale engineering (1M context)' },
      // Still listed and priced on BigModel pay-per-use (CNY 5/22 below 32K
      // input); only the China Coding Plan reroutes it.
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', description: 'Fast GLM-5 variant' },
    ],
    defaultModel: 'glm-5.3',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
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
    flatFee: true,
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
    flatFee: true,
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
    // DeepSeek's pricing page names `deepseek-flash` (V4.1 Flash) as the model
    // to use, so it stays the default; the retired `deepseek-v4-flash` ids are
    // served by it and migrate via RETIRED_MODEL_REPLACEMENTS.
    //
    // V4 Pro was announced to route to Flash from 2026-09-14, and Codeep 3.3.0
    // migrated it away. DeepSeek reversed that on 2026-09-11, before the
    // cutover: the changelog's 09-10 entry now says V4 Pro service continues
    // "with the billing method remaining unchanged", and the pricing page and
    // API reference list `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) beside Flash.
    // The 09-10 news post still carries the old routing text; the changelog is
    // the newer source. So Pro is a separate, separately billed model again.
    //
    // The ids differ on OpenRouter: `deepseek/deepseek-v4.1-flash`, and
    // `deepseek/deepseek-v4-pro-0813` for this Pro (see the fallback list).
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', description: 'Current DeepSeek model — thinking on by default, vision, 1M context, 384K output' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Larger V4 model (V4-Pro-0813) — thinking on, 1M context, no vision, about 4x Flash\'s price' },
    ],
    defaultModel: 'deepseek-flash',
    defaultProtocol: 'openai',
    maxOutputTokens: 384_000, // DeepSeek V4 max output
    envKey: 'DEEPSEEK_API_KEY',
    subscribeUrl: 'https://platform.deepseek.com/sign_up',
    groupLabel: 'DeepSeek',
    hint: 'Pay-per-use via DeepSeek API key (platform.deepseek.com).',
  },
  // ── Kimi (Moonshot AI) ────────────────────────────────────────────
  // Subscription (Kimi Code) mirrors the Z.AI GLM-Coding-Plan shape: a
  // dedicated coding base URL + a separate key. Model availability depends
  // on the user's plan, so the picker labels the restricted K3/high-speed ids
  // instead of pretending every subscription includes them.
  'kimi': {
    name: 'Kimi (Moonshot) — Coding Plan',
    description: 'Kimi Code subscription',
    protocols: {
      openai: { baseUrl: 'https://api.kimi.com/coding/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    // Kimi Code upgraded `kimi-for-coding` in place to K2.8 Preview on
    // 2026-09-11 (1,048,576 context on every tier, effort low/high/max). The
    // plans were then renamed: Plus ≈ Moderato, Pro ≈ Allegretto, and the new Go
    // tier has no coding quota. K3 reaches 1M context only on Pro/Allegretto; on
    // Plus/Moderato it is capped at 256K, and going past that returns HTTP 401
    // "Your current plan supports only kimi-k3 up to 256K context"
    // (kimi.com/code/docs/en/kimi-code/models.html, error-reference.html).
    models: [
      { id: 'kimi-for-coding', name: 'Kimi Code', description: 'K2.8 Preview, 1M context — every Kimi Code plan (Plus/Andante and above)' },
      { id: 'k3', name: 'Kimi K3', description: 'Flagship — 1M context on Pro/Allegretto and above; Plus/Moderato is capped at 256K (use K3 256K there)' },
      { id: 'k3-256k', name: 'Kimi K3 (256K)', description: 'K3 with a 256K context window — Plus/Moderato plan or higher' },
      { id: 'kimi-for-coding-highspeed', name: 'Kimi Code (High-Speed)', description: 'K2.7 Code HighSpeed, 256K context — Pro/Allegretto plan or higher' },
    ],
    defaultModel: 'kimi-for-coding',
    defaultProtocol: 'openai',
    maxOutputTokens: 32_768,
    envKey: 'KIMI_CODE_API_KEY',
    subscribeUrl: 'https://www.kimi.com/code',
    groupLabel: 'Kimi — Subscription (Kimi Code)',
    flatFee: true,
    hint: 'Uses your Kimi Code subscription — no per-token charges. Key from kimi.com/code/console.',
  },
  'kimi-api': {
    name: 'Kimi (Moonshot) API (pay-per-use)',
    description: 'Moonshot AI Kimi models via API key',
    protocols: {
      openai: { baseUrl: 'https://api.moonshot.ai/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'kimi-k3',                   name: 'Kimi K3',                   description: 'Latest flagship for software engineering and deep reasoning (1M context)' },
      { id: 'kimi-k2.7-code',           name: 'Kimi K2.7 Code',           description: 'Coding-specialized model (256K context)' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code (High-Speed)', description: 'Throughput-tuned K2.7 Code for latency-sensitive loops' },
      { id: 'kimi-k2.6',                name: 'Kimi K2.6',                description: 'General-purpose multimodal reasoning model' },
    ],
    defaultModel: 'kimi-k3',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
    envKey: 'MOONSHOT_API_KEY',
    subscribeUrl: 'https://platform.kimi.ai/console/api-keys',
    groupLabel: 'Kimi — API (pay-per-use)',
    hint: 'Pay-per-use via Moonshot API key (platform.kimi.ai). Kimi K3 supports 1M context and graded reasoning.',
  },
  'kimi-cn': {
    name: 'Kimi China (Moonshot)',
    description: 'Moonshot AI Kimi models (China)',
    protocols: {
      openai: { baseUrl: 'https://api.moonshot.cn/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'kimi-k3',                   name: 'Kimi K3',                   description: 'Latest flagship for software engineering and deep reasoning (1M context)' },
      { id: 'kimi-k2.7-code',           name: 'Kimi K2.7 Code',           description: 'Coding-specialized model (256K context)' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code (High-Speed)', description: 'Throughput-tuned K2.7 Code' },
      { id: 'kimi-k2.6',                name: 'Kimi K2.6',                description: 'General-purpose multimodal reasoning model' },
    ],
    defaultModel: 'kimi-k3',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
    envKey: 'MOONSHOT_CN_API_KEY',
    subscribeUrl: 'https://platform.moonshot.cn/console/api-keys',
    groupLabel: 'Kimi China — API (pay-per-use)',
    hint: 'Pay-per-use via Moonshot China API key (platform.moonshot.cn). Kimi K3 supports 1M context.',
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
      { id: 'grok-4.7',              name: 'Grok 4.7',              description: 'Flagship reasoning model — xAI recommends it for code, 500K context' },
      { id: 'grok-4.6',              name: 'Grok 4.6',              description: 'Previous flagship reasoning model, 500K context' },
      { id: 'grok-4.5',              name: 'Grok 4.5',              description: 'Older flagship reasoning model, 500K context' },
      { id: 'grok-build-0.1',        name: 'Grok Build 0.1',        description: 'Agentic coding model — fast, 256K context' },
      { id: 'grok-4.3',              name: 'Grok 4.3',              description: 'Older flagship, 1M context' },
    ],
    // Stays on the agentic coder, not the new flagship. grok-4.7 is the better
    // model — xAI's models page recommends only it, "including code", and it is
    // the default of xAI's own Grok Build agent — but it bills 2x input and 3x
    // output against grok-build-0.1, so moving every unpinned user onto it
    // silently is not ours to decide. It is one `/model` away.
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
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', description: 'Recommended current model for coding, reasoning, and vision' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', description: 'Fast multimodal model with a 1M context window' },
      { id: 'qwen3.5-plus', name: 'Qwen3.5-Plus', description: 'Efficient general-purpose Coding Plan model' },
    ],
    defaultModel: 'qwen3.7-plus',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'BAILIAN_CODING_PLAN_API_KEY',
    subscribeUrl: 'https://www.alibabacloud.com/help/en/model-studio/qwen-code-coding-plan',
    groupLabel: 'Qwen — Subscription (Coding Plan)',
    flatFee: true,
    hint: 'Uses your Qwen Coding Plan — no per-token charges. sk-sp-… key from Model Studio. Interactive coding use only.',
  },
  'qwen-api': {
    name: 'Qwen (Alibaba) API (pay-per-use)',
    description: 'Alibaba Model Studio Qwen models via API key',
    protocols: {
      openai: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    // 3.8 Max and Flash are GA on Model Studio international and cost less
    // than the 3.7 Max / 3.6 Flash they sit above.
    models: [
      { id: 'qwen3.8-max',   name: 'Qwen3.8-Max',   description: 'Latest flagship for complex coding and reasoning (1M context)' },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', description: 'Low-latency, low-cost multimodal model (1M context)' },
      { id: 'qwen3.7-max',   name: 'Qwen3.7-Max',   description: 'Previous flagship for complex coding and reasoning' },
      { id: 'qwen3.7-plus',  name: 'Qwen3.7-Plus',  description: 'Balanced quality, speed, and price (1M context)' },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', description: 'Previous low-latency, low-cost multimodal model' },
    ],
    defaultModel: 'qwen3.8-max',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'DASHSCOPE_API_KEY',
    subscribeUrl: 'https://modelstudio.console.alibabacloud.com/',
    groupLabel: 'Qwen — API (pay-per-use)',
    hint: 'Pay-per-use via Alibaba Model Studio key (DASHSCOPE_API_KEY).',
  },
  'qwen-token-plan': {
    name: 'Qwen (Alibaba) — Token Plan',
    description: 'Qwen Token Plan subscription (international)',
    protocols: {
      openai: { baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    // qwen3.8-max-preview is retired here: Alibaba routes it to qwen3.8-max,
    // bills it at that rate and says to update the id (token-plan-personal-
    // overview, 2026-09-23); stored configs migrate. The plan now has Personal
    // and Team editions on this same URL and key format, with different
    // allowlists — qwen3.6-plus is Team-only, and a Personal key gets
    // "403 AccessDenied.Unpurchased" for it. Nothing here can tell the two
    // editions apart, so the entry says so rather than disappearing on Team.
    models: [
      { id: 'qwen3.8-max',   name: 'Qwen3.8-Max',   description: 'Token Plan flagship for complex agentic work (1M context)' },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', description: 'Low-latency, credit-efficient model (1M context)' },
      { id: 'qwen3.7-max',   name: 'Qwen3.7-Max',   description: 'Previous flagship for complex coding and reasoning' },
      { id: 'qwen3.7-plus',  name: 'Qwen3.7-Plus',  description: 'Balanced quality and throughput' },
      { id: 'qwen3.6-plus',  name: 'Qwen3.6-Plus',  description: 'Team edition only — a Personal plan returns 403 for it' },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', description: 'Previous low-latency, credit-efficient model' },
    ],
    defaultModel: 'qwen3.8-max',
    defaultProtocol: 'openai',
    maxOutputTokens: 131_072,
    noStreamWithTools: true,
    envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
    subscribeUrl: 'https://modelstudio.console.alibabacloud.com/',
    groupLabel: 'Qwen — Subscription (Token Plan)',
    flatFee: true,
    hint: 'Uses monthly Token Plan credits. Requires a separate sk-sp-… Token Plan key.',
  },
  'qwen-cn': {
    name: 'Qwen China — Coding Plan',
    description: 'Qwen Coding Plan subscription (China)',
    protocols: {
      openai: { baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    models: [
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', description: 'Recommended current model for coding, reasoning, and vision' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', description: 'Fast multimodal model with a 1M context window' },
      { id: 'qwen3.5-plus', name: 'Qwen3.5-Plus', description: 'Efficient general-purpose Coding Plan model' },
    ],
    defaultModel: 'qwen3.7-plus',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    envKey: 'BAILIAN_CODING_PLAN_CN_API_KEY',
    subscribeUrl: 'https://bailian.console.aliyun.com/',
    groupLabel: 'Qwen China — Subscription (Coding Plan)',
    flatFee: true,
    hint: 'Uses your Qwen Coding Plan (China). sk-sp-… key from Bailian.',
  },
  'qwen-cn-api': {
    name: 'Qwen China API (pay-per-use)',
    description: 'Alibaba Model Studio Qwen models via API key (China)',
    protocols: {
      openai: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    // 3.8 Max and Flash have been GA in China (Beijing) since 2026-08-02 and
    // 2026-08-26, at CNY 12/36 and 0.8/2.7 (help.aliyun.com/zh/model-studio/
    // qwen3-8-max, qwen3-8-flash). Pricing is keyed by id, so they reuse the
    // international USD rows — an over-estimate, the same policy as z.ai-cn.
    // The default is unchanged: 3.8 Max costs the same as 3.7 Max in Beijing,
    // and moving unpinned users was not part of adding it.
    models: [
      { id: 'qwen3.8-max',   name: 'Qwen3.8-Max',   description: 'Latest flagship for complex coding and reasoning (1M context)' },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', description: 'Low-latency, low-cost multimodal model (1M context)' },
      { id: 'qwen3.7-max',   name: 'Qwen3.7-Max',   description: 'Previous flagship for complex coding and reasoning' },
      { id: 'qwen3.7-plus',  name: 'Qwen3.7-Plus',  description: 'Balanced quality, speed, and price (1M context)' },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', description: 'Previous low-latency, low-cost multimodal model' },
    ],
    defaultModel: 'qwen3.7-max',
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
    description: 'Live free-model catalog via ModelScope',
    protocols: {
      openai: { baseUrl: 'https://api-inference.modelscope.cn/v1', authHeader: 'Bearer', supportsNativeTools: true },
    },
    // Shown only until the live catalogue loads. The previous fallback,
    // Qwen/Qwen3-Coder-480B-A35B-Instruct, is no longer served: it is absent from
    // api-inference.modelscope.cn/v1/models (2026-09-23) and its hub entry has
    // SupportApiInference false. ModelScope names no successor, so this pick is
    // Codeep's: the largest Qwen in the live list, whose model card documents
    // tool calling ("Qwen3.5 excels in tool calling capabilities").
    models: [
      { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5 397B', description: 'Fallback model shown until the live catalog loads' },
    ],
    defaultModel: 'Qwen/Qwen3.5-397B-A17B',
    defaultProtocol: 'openai',
    maxOutputTokens: 65_536,
    noStreamWithTools: true,
    dynamicModels: true,
    envKey: 'MODELSCOPE_API_KEY',
    subscribeUrl: 'https://modelscope.cn/my/myaccesstoken',
    groupLabel: 'ModelScope — Free (Qwen)',
    flatFee: true,
    hint: 'Fetches the live free catalog for your ModelScope token; availability and limits vary by account.',
  },
  'openai': {
    name: 'OpenAI',
    description: 'GPT models',
    protocols: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        authHeader: 'Bearer',
        supportsNativeTools: true,
        // Agent turns go over the Responses API, where GPT-6 reasons AND calls
        // tools — on by default since the owner's live run of 2026-09-26
        // (DEFAULT_OPENAI_WIRE_API is 'auto'; openAIWireApi() decides per turn).
        responses: { dialect: 'openai' },
      },
    },
    // GPT-6 has a documented tool restriction on Chat Completions
    // (developers.openai.com guides/latest-model and reasoning): Sol and Luna
    // call tools only with reasoning_effort "none", and "Chat Completions does
    // not support function calling with GPT-6 Astra" at all. Agent turns avoid
    // it by going over the Responses API, which the live run of 2026-09-26
    // confirmed (scripts/record-responses-fixture.mjs; recordings in
    // utils/__fixtures__/responses/recorded): Astra called tools, Sol at effort
    // high made two calls in parallel, and replayed reasoning was accepted
    // under store:false. So Astra is offered again, and the default is GPT-6 Sol.
    //
    // Chat Completions remains for an OPENAI_BASE_URL proxy and for the switch
    // forced to 'chat'. There the old rules still hold, keyed to the wire:
    // Sol/Luna agent turns send "none" (toolsForceReasoningOff, which /thinking
    // reports) and Astra's agent turns fall back to text tools (a one-time
    // notice says so — agentToolsNote). 5.6 Sol is the GPT that reasons with
    // tools on either API ("The Chat Completions examples use GPT-5.6 for
    // compatibility" — function-calling guide).
    models: [
      { id: 'gpt-6-astra',   name: 'GPT-6 Astra',   description: 'Frontier GPT-6 ($10/$50), 1M context — calls tools over the Responses API only; through a Chat Completions proxy, agent turns use text tools' },
      { id: 'gpt-6-sol',     name: 'GPT-6 Sol',     description: 'GPT-6 at $2/$10, 1M context — reasons and calls tools together' },
      { id: 'gpt-6-luna',    name: 'GPT-6 Luna',    description: 'Cheapest GPT-6 ($0.10/$0.50), 1M context' },
      { id: 'gpt-5.6-sol',   name: 'GPT-5.6 Sol',   description: 'GPT-5.6 flagship ($4/$20) — reasons with tools on Chat Completions too, e.g. through a proxy' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Balanced — GPT-5.5 quality at about half the price' },
      { id: 'gpt-5.6-luna',  name: 'GPT-5.6 Luna',  description: 'Fast and cheap — high-volume workloads' },
    ],
    defaultModel: 'gpt-6-sol',
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
      { id: 'claude-fable-5-1',          name: 'Claude Fable 5.1',      description: 'Most capable — hardest reasoning & long-horizon agentic work' },
      { id: 'claude-opus-5-5',           name: 'Claude Opus 5.5',       description: 'Complex agentic coding & deep reasoning — $4/$20, 1M context' },
      { id: 'claude-fable-5',            name: 'Claude Fable 5',        description: 'Superseded by 5.1 — same price, kept for pinned configs' },
      { id: 'claude-opus-5',             name: 'Claude Opus 5',         description: 'Legacy since Opus 5.5 — kept for pinned configs' },
      { id: 'claude-sonnet-5',           name: 'Claude Sonnet 5',       description: 'Best balance of speed and intelligence' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku',          description: 'Fastest and most affordable' },
    ],
    // Anthropic's models overview now says to "start with Claude Opus 5.5 for
    // most workloads", and it is 20% cheaper than Opus 5 (now "Active
    // (legacy)", retiring no sooner than 2027-07-24 — so no migration). One
    // behaviour change comes with it: Opus 5.5 defaults to MEDIUM effort where
    // Opus 5 defaulted to high, and /thinking auto sends no effort, so an
    // unpinned user runs one level lower than before. It also thinks more per
    // turn at a given effort — see minResponseTokensFor.
    defaultModel: 'claude-opus-5-5',
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
      { id: 'gemini-3.8-flash',       name: 'Gemini 3.8 Flash',      description: 'Latest production Flash model — adjustable thinking, 64K output' },
      { id: 'gemini-3.7-flash',       name: 'Gemini 3.7 Flash',      description: 'Previous production Flash model' },
      { id: 'gemini-3.6-flash',       name: 'Gemini 3.6 Flash',      description: 'Earlier production Flash model' },
      { id: 'gemini-3.5-flash',       name: 'Gemini 3.5 Flash',      description: 'Stable frontier Flash model for coding and long agentic tasks' },
      { id: 'gemini-3.5-flash-lite',  name: 'Gemini 3.5 Flash-Lite', description: 'Latest low-latency, low-cost workhorse' },
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
    // A short fallback — the full catalog (100+) is fetched lazily via
    // fetchOpenRouterModels() because dynamicModels is true.
    // We keep these hardcoded so first-time users without network
    // get a working dropdown.
    models: [
      { id: 'openrouter/auto',                  name: 'Auto-route',         description: 'OpenRouter picks the best model for the task' },
      // Dotted, as OpenRouter's /api/v1/models lists them. The hyphenated
      // `anthropic/claude-fable-5-1` this used to carry resolves on OpenRouter's
      // metadata lookup but is absent from the models list, so a pick made
      // before the live catalogue loaded matched nothing in it.
      { id: 'anthropic/claude-fable-5.1',       name: 'Claude Fable 5.1',   description: 'Anthropic — most capable' },
      { id: 'anthropic/claude-opus-5.5',        name: 'Claude Opus 5.5',    description: 'Anthropic — current Opus' },
      { id: 'anthropic/claude-fable-5',         name: 'Claude Fable 5',     description: 'Anthropic — superseded by 5.1' },
      { id: 'anthropic/claude-opus-5',          name: 'Claude Opus 5',      description: 'Anthropic — legacy Opus' },
      { id: 'anthropic/claude-sonnet-5',        name: 'Claude Sonnet 5',    description: 'Anthropic — balanced' },
      { id: 'openai/gpt-6-astra',               name: 'GPT-6 Astra',        description: 'OpenAI — frontier' },
      { id: 'openai/gpt-6-sol',                 name: 'GPT-6 Sol',          description: 'OpenAI — GPT-6, balanced' },
      { id: 'openai/gpt-6-luna',                name: 'GPT-6 Luna',         description: 'OpenAI — GPT-6, fast/cheap' },
      { id: 'openai/gpt-5.6-sol',               name: 'GPT-5.6 Sol',        description: 'OpenAI — flagship' },
      { id: 'openai/gpt-5.6-luna',              name: 'GPT-5.6 Luna',       description: 'OpenAI — fast/efficient' },
      { id: 'google/gemini-3.8-flash',          name: 'Gemini 3.8 Flash',   description: 'Google — latest production Flash' },
      { id: 'google/gemini-3.7-flash',          name: 'Gemini 3.7 Flash',   description: 'Google — previous production Flash' },
      { id: 'deepseek/deepseek-v4.1-flash',     name: 'DeepSeek V4.1 Flash', description: 'DeepSeek — current model' },
      // The GA Pro, with a DeepSeek-hosted endpoint. `deepseek/deepseek-v4-pro`
      // is the April 0423 preview, served only by third parties.
      { id: 'deepseek/deepseek-v4-pro-0813',    name: 'DeepSeek V4 Pro',    description: 'DeepSeek — larger V4 model' },
      { id: 'moonshotai/kimi-k3',               name: 'Kimi K3',            description: 'Moonshot — long-horizon coding' },
      // Dated on purpose: OpenRouter lists only the snapshot. The undated
      // `qwen/qwen3.8-max` this used to carry does not exist there, so picking
      // it before the live catalogue loaded was an error.
      { id: 'qwen/qwen3.8-max-0902',            name: 'Qwen 3.8 Max',       description: 'Alibaba — latest flagship' },
      { id: 'x-ai/grok-4.7',                    name: 'Grok 4.7',           description: 'xAI — flagship reasoning' },
    ],
    defaultModel: 'openrouter/auto',
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
 * Exact migrations for curated model ids that vendors replaced.
 *
 * Keep this deliberately narrower than the provider catalogue. Dynamic
 * OpenRouter/Ollama/custom ids are user-controlled and must never be rewritten;
 * ModelScope's one entry is the exception, explained where it sits.
 */
const RETIRED_MODEL_REPLACEMENTS: Record<string, Record<string, string>> = {
  // Both GLM Coding Plans accept exactly GLM-5.3 and GLM-5.3-Flash. Z.AI routes
  // 5.2 and 5.1 to 5.3 on both, and the China plan routes Turbo to 5.3-Flash.
  // Plain glm-5, and Turbo on the international plan, are Codeep's extension of
  // the same routing: neither plan's text names them.
  'z.ai':        { 'glm-5.2': 'glm-5.3', 'glm-5.1': 'glm-5.3', 'glm-5': 'glm-5.3', 'glm-5-turbo': 'glm-5.3-flash' },
  // Pay-per-use still sells 5.2 as its own id. Turbo left the international
  // price list and model enum with no notice and no named successor, so it
  // follows the China plan's routing to Flash.
  'z.ai-api':    { 'glm-5.1': 'glm-5.2', 'glm-5': 'glm-5.2', 'glm-5-turbo': 'glm-5.3-flash' },
  'z.ai-cn':     { 'glm-5.2': 'glm-5.3', 'glm-5.1': 'glm-5.3', 'glm-5': 'glm-5.3', 'glm-5-turbo': 'glm-5.3-flash' },
  'z.ai-cn-api': { 'glm-5.1': 'glm-5.2', 'glm-5': 'glm-5.2' },
  google: {
    'gemini-3.1-flash-lite': 'gemini-3.5-flash-lite',
    // Google's deprecations table names 3.6 Flash (no shutdown date yet). Its
    // /whats-new-gemini-3.5 guide suggests 3.5 Flash instead; the lifecycle
    // table is the dedicated source, and 3.5 Flash would cost twice as much.
    'gemini-3-flash-preview': 'gemini-3.6-flash',
    // Shut down 2026-03-09; the server already aliases the id to 3.1 Pro.
    'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  },
  // The V4 Flash ids are retired and served by V4.1 Flash. There is no V4 Pro
  // entry: DeepSeek cancelled its routing to Flash (see the catalogue above),
  // and rewriting it moved users off a live, separately billed model.
  deepseek: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
  grok: {
    'grok-code-fast-1': 'grok-build-0.1',
    'grok-4-fast-reasoning': 'grok-4.3',
  },
  openai: {
    'gpt-5.5': 'gpt-5.6-sol',
    'gpt-5.4': 'gpt-5.6-terra',
    'gpt-5.4-mini': 'gpt-5.6-luna',
    // No gpt-6-astra entry. It moved Astra to Sol while Chat Completions was
    // the only transport (Astra cannot call tools there); agent turns go over
    // the Responses API since 2026-09-26 and Astra is offered again. The map
    // runs on every load, so the entry would move anyone who picks Astra back
    // to Sol. Configs it already moved stay on Sol — a valid model.
  },
  'kimi-api': {
    'kimi-k3-code': 'kimi-k3',
    'kimi-k3-code-highspeed': 'kimi-k3',
    'kimi-k3-thinking': 'kimi-k3',
    'kimi-k2.5': 'kimi-k2.6',
  },
  'kimi-cn': {
    'kimi-k3-code': 'kimi-k3',
    'kimi-k3-code-highspeed': 'kimi-k3',
    'kimi-k3-thinking': 'kimi-k3',
    'kimi-k2.5': 'kimi-k2.6',
  },
  // Alibaba retires qwen3-coder-plus, qwen3-coder-next and bare qwen3-max on
  // 2026-10-10, on the plans as well (notices 1949 and 1950). It names
  // qwen3.7-plus for both coders and qwen3.7-max for qwen3-max — but 3.7 Max is
  // not on the Coding Plan allowlist, so the two Coding Plan surfaces land
  // qwen3-max on 3.7 Plus, exactly as their own qwen3.7-max entry does.
  qwen: {
    'qwen3-coder-plus': 'qwen3.7-plus',
    'qwen3-coder-next': 'qwen3.7-plus',
    'qwen3.7-max': 'qwen3.7-plus',
    'qwen3-max': 'qwen3.7-plus',
  },
  // The coders used to go to qwen3.7-max here, which bills 6.25x the input rate
  // of the qwen3.7-plus Alibaba names. Configs already moved stay where they
  // are: 3.7 Max is a valid model.
  'qwen-api': {
    'qwen3-coder-plus': 'qwen3.7-plus',
    'qwen3-coder-next': 'qwen3.7-plus',
    'qwen3-coder-flash': 'qwen3.6-flash',
    'qwen3-max': 'qwen3.7-max',
  },
  // The preview is retired and routed to qwen3.8-max, which Alibaba says to use.
  'qwen-token-plan': {
    'qwen3.8-max-preview': 'qwen3.8-max',
    'qwen3-coder-plus': 'qwen3.7-plus',
    'qwen3-coder-next': 'qwen3.7-plus',
    'qwen3-max': 'qwen3.7-max',
  },
  'qwen-cn': {
    'qwen3-coder-plus': 'qwen3.7-plus',
    'qwen3-coder-next': 'qwen3.7-plus',
    'qwen3.7-max': 'qwen3.7-plus',
    'qwen3-max': 'qwen3.7-plus',
  },
  'qwen-cn-api': {
    'qwen3-coder-plus': 'qwen3.7-plus',
    'qwen3-coder-next': 'qwen3.7-plus',
    'qwen3-coder-flash': 'qwen3.6-flash',
    'qwen3-max': 'qwen3.7-max',
  },
  // The one entry on a dynamic catalogue, and the exception to the rule above:
  // the 480B coder was Codeep's own fallback default, so most configs holding
  // it never chose it, and ModelScope stopped serving it (see the catalogue
  // entry). Exact id only; every other ModelScope id stays the user's. Drop
  // this if ModelScope serves the 480B again.
  modelscope: {
    'Qwen/Qwen3-Coder-480B-A35B-Instruct': 'Qwen/Qwen3.5-397B-A17B',
  },
};

/**
 * One exact lookup, never followed further: every target must already be a
 * model its own provider offers (providers.test.ts holds the map to that), so a
 * chain can never be needed and the macOS mirror stays a flat table too.
 */
export function replacementModelFor(providerId: string, modelId: string): string | undefined {
  return RETIRED_MODEL_REPLACEMENTS[providerId]?.[modelId];
}

/** The whole map, read-only — for the invariant test and nothing else. */
export function retiredModelReplacements(): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return RETIRED_MODEL_REPLACEMENTS;
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
  'qwen-token-plan',
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

/**
 * Returns true if the provider bills a flat subscription (or is free), so any
 * per-token dollar figure we compute for it is invented — see `flatFee`.
 */
export function isFlatFeeProvider(providerId: string): boolean {
  return PROVIDERS[providerId]?.flatFee === true;
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
 * internally and 400 on any custom value, so they're here too. Google removed
 * the deprecated sampling parameters outright in the Gemini 3.7 generation.
 * GPT-6 takes temperature/top_p only at reasoning_effort "none" (Astra never):
 * the direct `openai` provider already omits them for every model through
 * requiresDefaultTemperature, so this entry is for `openai/gpt-6-*` on
 * OpenRouter, the one path where a GPT-6 id could still be sent one.
 */
const SAMPLING_PARAMS_REJECTED = [
  'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5',
  'kimi-k3', 'kimi-k2.7-code', 'kimi-for-coding', 'k3',
  'gemini-3.7-flash', 'gemini-3.8-flash',
  'gpt-6',
];

export function modelRejectsSamplingParams(model: string): boolean {
  // Canonicalize both sides. OpenRouter routes these as `google/gemini-3.7-flash`
  // and `anthropic/claude-opus-4.8`, which a raw comparison misses — so the model
  // gets a temperature it rejects, on the one path where the id is namespaced.
  const id = canonicalModelId(model);
  return SAMPLING_PARAMS_REJECTED.some(entry => {
    const canonical = canonicalModelId(entry);
    return id === canonical || id.startsWith(`${canonical}-`);
  });
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

/**
 * The smallest response budget (`max_tokens`) worth sending this model, or 0
 * for no floor. Callers take the larger of this and whatever they would have
 * sent, then apply getEffectiveMaxTokens as usual.
 *
 * Claude Opus 5.5 thinks on every request — adaptive thinking cannot be turned
 * off — and "tends to think more per turn than Claude Opus 5" at the same
 * effort; Anthropic's notes say to "leave room in max_tokens for the thinking",
 * which spends the same limit as the answer. The task planner's 2048, or a
 * maxTokens lowered in /settings, could go on thinking alone and cut the reply
 * off. 32K is Codeep's own default; the Max tier gets 64K, where Anthropic's
 * advice for max effort on Opus 5 is "starting at 64k tokens". Matched on the
 * canonical id, so `anthropic/claude-opus-5.5` on OpenRouter is covered too.
 */
export function minResponseTokensFor(model: string, tier: ReasoningTier | undefined): number {
  if (!idMatches(canonicalModelId(model), 'claude-opus-5-5')) return 0;
  return tier === 'max' ? 65_536 : 32_768;
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
 * value that would 400 (e.g. Gemini has no "max"; GPT-5.5 tops out at "xhigh").
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

// ---------------------------------------------------------------------------
// Wire API for OpenAI-protocol agent turns: Chat Completions or Responses
// ---------------------------------------------------------------------------

/** The endpoint an OpenAI-protocol agent turn goes to. */
export type OpenAIWire = 'chat' | 'responses';

/**
 * The user-facing switch (hidden config key `openaiWireApi`, env
 * CODEEP_OPENAI_WIRE_API over it):
 *   'auto'      — Responses for a catalogue model of a provider that declares
 *                 it, at its official base URL; everything else on Chat
 *                 Completions.
 *   'chat'      — Chat Completions everywhere (the kill switch).
 *   'responses' — also force Responses through an OPENAI_BASE_URL override
 *                 (Azure, LiteLLM, other proxies) and for model ids the
 *                 catalogue does not list, for providers that declare it.
 */
export type OpenAIWireSetting = 'auto' | 'chat' | 'responses';

const OPENAI_WIRE_SETTINGS: readonly OpenAIWireSetting[] = ['auto', 'chat', 'responses'];

/**
 * What an unset switch means: 'auto', since the owner's live verification run
 * of 2026-09-26 (scripts/record-responses-fixture.mjs, recordings in
 * utils/__fixtures__/responses/recorded) — GPT-6 Astra called tools, Sol at
 * effort high called two in parallel, and replayed reasoning items were
 * accepted under store:false. The config key is deliberately absent from
 * Conf's defaults (Conf writes defaults to disk), so this reaches every
 * existing install that never set the key.
 *
 * 'chat' stays a valid setting for one release, as the kill switch. An
 * OPENAI_BASE_URL proxy stays on Chat Completions under 'auto' either way, so
 * the chat-wire rules below (toolsForceReasoningOff, agentToolsNote) stay too.
 */
export const DEFAULT_OPENAI_WIRE_API: OpenAIWireSetting = 'auto';

/**
 * The effective switch: CODEEP_OPENAI_WIRE_API, then the config value, then
 * DEFAULT_OPENAI_WIRE_API. An unrecognised value at either level is ignored
 * rather than trusted, so a typo can never route traffic somewhere new.
 */
export function openAIWireSetting(configValue?: unknown): OpenAIWireSetting {
  const env = (process.env.CODEEP_OPENAI_WIRE_API ?? '').trim().toLowerCase();
  if ((OPENAI_WIRE_SETTINGS as readonly string[]).includes(env)) return env as OpenAIWireSetting;
  const cfg = typeof configValue === 'string' ? configValue.trim().toLowerCase() : '';
  if ((OPENAI_WIRE_SETTINGS as readonly string[]).includes(cfg)) return cfg as OpenAIWireSetting;
  return DEFAULT_OPENAI_WIRE_API;
}

/**
 * Whether `model` is one of the ids the provider's catalogue lists, exactly.
 * The static list: for a provider with `dynamicModels` it is only the
 * fallback shown before the live catalogue loads, so openAIWireApi() would
 * need another source of truth before such a provider declares `responses`.
 */
function isCatalogueModel(providerId: string, model: string): boolean {
  return PROVIDERS[providerId]?.models.some(m => m.id === model) ?? false;
}

/** The Responses dialect a provider declares, or null when it has none. */
export function responsesDialectFor(providerId: string): 'openai' | 'xai' | null {
  return PROVIDERS[providerId]?.protocols.openai?.responses?.dialect ?? null;
}

/**
 * Which endpoint an agent turn for this provider goes to. 'responses' only
 * when the switch is not 'chat', the provider declares a Responses dialect
 * (today only `openai`; `grok` gets one after its own verification), and —
 * unless the switch forces 'responses' — the model is in the provider's
 * catalogue and the request goes to the provider's own base URL. A user-set
 * override (Azure, LiteLLM, another proxy) and a model id Codeep does not
 * list stay on Chat Completions. Everything else — other providers, custom,
 * OpenRouter, Ollama — is 'chat', byte-for-byte as before.
 *
 * The catalogue check is there because an id can reach an agent turn without
 * being offered: an old config or saved profile with `gpt-4.1` or `gpt-4o`
 * (applyProfile keeps unknown ids), or the ACP set-model handler, which takes
 * any id. Those are not reasoning models — GPT-4o's output limit (16,384) is
 * below responsesMaxOutputTokens()'s 32K floor, and non-reasoning models are
 * reported to reject the encrypted-reasoning `include` — and the Responses
 * path has no text-tool fallback, so their agent turns would stop on a 400.
 * Chat Completions is the path that works for them today. A dated snapshot
 * of a listed model is not listed either, and stays there too.
 */
export function openAIWireApi(
  providerId: string,
  model: string,
  resolvedBaseUrl: string | null | undefined,
  setting: OpenAIWireSetting = DEFAULT_OPENAI_WIRE_API,
): OpenAIWire {
  if (setting === 'chat') return 'chat';
  if (!responsesDialectFor(providerId)) return 'chat';
  if (setting === 'responses') return 'responses';
  if (!isCatalogueModel(providerId, model)) return 'chat';
  const official = (PROVIDERS[providerId]?.protocols.openai?.baseUrl ?? '').replace(/\/+$/, '');
  const resolved = (resolvedBaseUrl ?? '').trim().replace(/\/+$/, '');
  return official !== '' && resolved === official ? 'responses' : 'chat';
}

/**
 * The response budget for a Responses turn. `max_output_tokens` there counts
 * reasoning too, and OpenAI advises reserving at least 25,000 tokens for
 * reasoning plus output, so the floor is 32K — 64K at the Max tier — above
 * whatever the config asks for.
 */
export function responsesMaxOutputTokens(configMaxTokens: number, tier: ReasoningTier | undefined): number {
  const floor = tier === 'max' ? 65_536 : 32_768;
  const configured = Number.isFinite(configMaxTokens) ? configMaxTokens : 0;
  return Math.max(configured, floor);
}

/**
 * GPT-6 Sol and Luna on Chat Completions support function calling "only with
 * `reasoning_effort` set to `none`" (developers.openai.com models/gpt-6-sol,
 * guides/latest-model). So a request that carries tools to them must send
 * "none", whatever /thinking says. Direct `openai` only: OpenRouter may reach
 * OpenAI through the Responses API, where the rule does not apply, and Astra
 * rejects "none" with a 400 (and has no tool calls on Chat Completions at all
 * — see agentToolsNote).
 *
 * Keyed to the WIRE: the rule is Chat Completions', so over Responses — where
 * `openai` agent turns go by default — it never applies and /thinking reaches
 * agent turns. `wire` defaults to 'chat': OPENAI_BASE_URL proxies and the
 * switch forced to 'chat' still send tools there.
 */
export function toolsForceReasoningOff(providerId: string, model: string, wire: OpenAIWire = 'chat'): boolean {
  if (wire !== 'chat') return false;
  if (providerId !== 'openai') return false;
  const id = canonicalModelId(model);
  return idMatches(id, 'gpt-6-sol') || idMatches(id, 'gpt-6-luna');
}

/**
 * What /thinking must tell the user when the tier does not reach every request
 * for this model, or null. Without it the setting would look applied while
 * agent turns quietly ran at "none". Null on the Responses wire, where agent
 * turns take the tier like any other request.
 */
export function agentTurnReasoningNote(providerId: string, model: string, wire: OpenAIWire = 'chat'): string | null {
  if (!toolsForceReasoningOff(providerId, model, wire)) return null;
  return `Agent turns on ${model} send reasoning_effort "none" whatever the tier — OpenAI's Chat Completions API lets GPT-6 Sol and Luna call tools only with reasoning off. The tier applies to plain chat.`;
}

/**
 * GPT-6 Astra on Chat Completions: "Chat Completions does not support function
 * calling with GPT-6 Astra" (developers.openai.com guides/latest-model). Over
 * Responses — the default for `openai` at its official URL — it calls tools
 * (live run, 2026-09-26). Through an OPENAI_BASE_URL proxy, or with the switch
 * forced to 'chat', its agent turns stay on Chat Completions: the tools
 * request comes back 400 and agentChat drops to the text-tool fallback, which
 * works but used to happen without a word. Direct `openai` only, as for
 * toolsForceReasoningOff; `wire` defaults to 'chat' likewise.
 */
export function chatCompletionsCannotCallTools(providerId: string, model: string, wire: OpenAIWire = 'chat'): boolean {
  if (wire !== 'chat') return false;
  if (providerId !== 'openai') return false;
  return idMatches(canonicalModelId(model), 'gpt-6-astra');
}

/**
 * The one-time notice runAgent gives when this model's agent turns cannot call
 * tools natively on the wire they go to, or null. It names how to get native
 * tool calls back, since each way out is a setting the user controls.
 */
export function agentToolsNote(providerId: string, model: string, wire: OpenAIWire = 'chat'): string | null {
  if (!chatCompletionsCannotCallTools(providerId, model, wire)) return null;
  return `${model} cannot call tools over Chat Completions, and its agent turns go there (an OPENAI_BASE_URL proxy, or openaiWireApi / CODEEP_OPENAI_WIRE_API set to "chat"), so they use Codeep's text tool format instead. For native tool calls use the official base URL with the switch on auto, set it to "responses" if your proxy serves /v1/responses, or pick GPT-6 Sol.`;
}

/**
 * What our Max tier sends as OpenRouter's unified `reasoning.effort`.
 *
 * OpenRouter accepts "xhigh" and "max", but only where the model does. Its
 * /api/v1/models `reasoning.supported_efforts` (read 2026-09-23) lists "max"
 * for GPT-5.6 and GPT-6, the Claude 5 family and Opus 4.7/4.8, DeepSeek V4.1
 * Flash and V4 Pro 0813, and Kimi K3; "xhigh" is the ceiling for GPT-5.4/5.5,
 * Grok 4.6/4.7 and Qwen 3.8 Max. Everything else keeps the old "high" cap —
 * including the 0423 `deepseek/deepseek-v4-pro` preview (xhigh|high only) and
 * Grok 4.5/4.3, which list no xhigh — because OpenRouter does not document what
 * happens to a level a model does not list.
 */
function openRouterMaxEffort(model: string): 'max' | 'xhigh' | 'high' {
  const id = canonicalModelId(model);
  const max = ['gpt-5-6', 'gpt-6', 'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5',
    'claude-opus-4-7', 'claude-opus-4-8', 'deepseek-v4-1-flash', 'deepseek-v4-pro-0813', 'kimi-k3'];
  if (max.some(prefix => idMatches(id, prefix))) return 'max';
  const xhigh = ['gpt-5-5', 'gpt-5-4', 'grok-4-6', 'grok-4-7', 'qwen3-8-max'];
  if (xhigh.some(prefix => idMatches(id, prefix))) return 'xhigh';
  return 'high';
}

/**
 * Grok models whose ceiling is "xhigh". xAI's reasoning guide: "`xhigh` is
 * available on `grok-4.6` and later", and grok-4.7 lists it. grok-4.5 and
 * grok-4.3 are disputed — their model pages list xhigh, while the guide says 4.5
 * treats it as "high" and the May-15 page gives 4.3 four levels ending at high —
 * so they keep the high ceiling until a live request settles it.
 */
function grokHasXhigh(model: string): boolean {
  const id = canonicalModelId(model);
  return idMatches(id, 'grok-4-6') || idMatches(id, 'grok-4-7');
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
      // GPT-5.x and GPT-6.x are reasoning models — reasoning_effort across both
      // families (incl. mini). Written as two prefixes rather than `gpt-`
      // because GPT-4 and earlier are not reasoning models and must not be
      // offered the parameter.
      return id.startsWith('gpt-5') || id.startsWith('gpt-6');
    case 'google':
      // Gemini 3.x thinking_level via the OpenAI-compat reasoning_effort mapping.
      return id.startsWith('gemini-3');
    case 'deepseek':
      // `deepseek-flash` does not start with `deepseek-v4` — a prefix check
      // alone would ship the current model with /thinking hidden, the same
      // trap GPT-6 nearly fell into behind `gpt-5`.
      return id.startsWith('deepseek-v4') || idMatches(id, 'deepseek-flash');
    case 'z.ai': case 'z.ai-api': case 'z.ai-cn': case 'z.ai-cn-api':
      // GLM-5.2 exposes graded High/Max effort; GLM-5.3 adds a distinct Low.
      // Turbo is a plain toggle.
      return idMatches(id, 'glm-5-2') || idMatches(id, 'glm-5-3');
    case 'kimi':
      // `kimi-for-coding` is K2.8 Preview since 2026-09-11 and takes low/high/max
      // (default max). Matched EXACTLY: idMatches would also take in
      // `kimi-for-coding-highspeed`, which is K2.7 Code HighSpeed — thinking
      // always on, no effort ladder.
      return idMatches(id, 'k3') || id === 'kimi-for-coding';
    case 'kimi-api': case 'kimi-cn':
      return idMatches(id, 'kimi-k3');
    case 'grok':
      // Grok reasoning models accept reasoning_effort (low/medium/high, plus
      // xhigh from grok-4.6; 4.3 also takes none, which no tier sends). The
      // coders (grok-code-fast, grok-build — the default) reason internally but
      // have no effort control and 400 on the parameter; a 400 here silently
      // drops the whole turn into the weaker text-tool fallback (agentChat.ts),
      // so exclude them alongside the explicit *-non-reasoning variants.
      if (id.startsWith('grok-build') || id.startsWith('grok-code')) return false;
      return id.startsWith('grok') && !id.includes('non-reasoning');
    // GLM Turbo and Qwen coders expose thinking on/off, not a graded knob.
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
  /** `tools`: the request carries a non-empty `tools` array (native tool
   *  calling). `wire`: the endpoint it goes to — 'responses' returns the
   *  Responses shape `{ reasoning: { effort } }` from the same per-model
   *  ladder; omitted means Chat Completions, as before. */
  opts: { tools?: boolean; wire?: OpenAIWire } = {},
): Record<string, unknown> {
  const wire = opts.wire ?? 'chat';
  if (wire === 'responses') {
    // Same ladder, Responses shape. No tools-force-"none" here: that is a Chat
    // Completions restriction, and GPT-6 Astra would 400 on "none" anyway.
    const chatShaped = reasoningParamsFor(providerId, model, tier, { tools: false });
    const effort = chatShaped.reasoning_effort;
    return typeof effort === 'string' ? { reasoning: { effort } } : {};
  }
  // Before the 'auto' return on purpose: auto sends nothing, GPT-6 Sol/Luna then
  // run at their default "medium", and that is exactly the combination OpenAI
  // documents as unable to call tools on Chat Completions.
  if (opts.tools && toolsForceReasoningOff(providerId, model, wire)) return { reasoning_effort: 'none' };
  // 'auto', or any unexpected value from an older/garbled config, → no param.
  // (Guards against ever emitting e.g. `effort: undefined`, which could 400.)
  if (tier === 'auto' || !REASONING_TIERS.includes(tier)) return {};
  if (!modelSupportsReasoningEffort(providerId, model)) return {};

  switch (providerId) {
    case 'anthropic':
      // low / medium / high / max — all valid on the capable Claude models.
      return { output_config: { effort: tier } };
    case 'openai': {
      // Chat Completions takes none/minimal/low/medium/high/xhigh/max, but "max"
      // is per model: it arrived with GPT-5.6 (changelog 2026-07-09) and every
      // GPT-6 page lists it. GPT-5.5 and earlier top out at xhigh.
      const id = canonicalModelId(model);
      const hasMax = idMatches(id, 'gpt-5-6') || idMatches(id, 'gpt-6');
      return { reasoning_effort: tier === 'max' ? (hasMax ? 'max' : 'xhigh') : tier };
    }
    case 'google':
      // Gemini's OpenAI-compat layer maps reasoning_effort onto thinking_level
      // and documents low | medium | high. (Medium 400'd on Gemini 3 Preview,
      // which is why this used to collapse it — that was a preview-era bug and
      // is fixed.) 'max' has no Gemini equivalent, so it tops out at high.
      // 'minimal' is deliberately not emitted: 3.7 Flash rejects it outright.
      return { reasoning_effort: tier === 'max' ? 'high' : tier };
    case 'deepseek':
      // V4.1 Flash and V4 Pro both distinguish low / high / max — "The thinking
      // modes of V4-Pro and V4-Flash now support three thinking effort levels"
      // (changelog 2026-08-13; mapping table: minimal+low→low,
      // medium+high+xhigh→high, max+ultra→max). Always an effort, never a
      // disabled block.
      return { reasoning_effort: tier === 'low' ? 'low' : tier === 'max' ? 'max' : 'high' };
    case 'z.ai': case 'z.ai-api': case 'z.ai-cn': case 'z.ai-cn-api':
      // GLM-5.3 accepts low/high/max; GLM-5.2 grades only high|max, so lower
      // tiers collapse to high there. Either way we always send an effort and
      // never a disabled thinking block — GLM-5.3 rejects "disabled" outright.
      if (idMatches(canonicalModelId(model), 'glm-5-3')) {
        return { reasoning_effort: tier === 'low' ? 'low' : tier === 'max' ? 'max' : 'high' };
      }
      return { reasoning_effort: tier === 'max' ? 'max' : 'high' };
    case 'kimi': case 'kimi-api': case 'kimi-cn':
      // Kimi K3 accepts low/high/max; collapse our medium tier to high.
      return { reasoning_effort: tier === 'low' ? 'low' : tier === 'max' ? 'max' : 'high' };
    case 'grok':
      // No "max" on xAI; our Max maps to the model's own ceiling — xhigh from
      // grok-4.6, high below it (see grokHasXhigh).
      return { reasoning_effort: tier === 'max' ? (grokHasXhigh(model) ? 'xhigh' : 'high') : tier };
    case 'openrouter':
      // Unified reasoning object; Max goes as high as the model lists.
      return { reasoning: { effort: tier === 'max' ? openRouterMaxEffort(model) : tier } };
    default:
      return {};
  }
}

/**
 * The DISTINCT tiers a given provider+model actually exposes — used to build a
 * per-model picker that only offers levels the model can tell apart (e.g.
 * GLM-5.2 grades only high|max; Gemini via the OpenAI-compat layer has no max).
 * Always leads with 'auto'. `[]` for models with no graded knob.
 *
 * GPT-6 Sol/Luna list their full set: plain chat and agent turns over the
 * Responses API (the default) both take it. Only agent turns on Chat
 * Completions — a proxy, or the switch forced to 'chat' — send "none"
 * regardless (toolsForceReasoningOff), and /thinking says so there.
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
      // low | medium | high, per Gemini's OpenAI-compat mapping table. Medium
      // is 3.7 Flash's own default and the tier Google recommends for agentic
      // coding, so collapsing it hid the setting most users want.
      return ['auto', 'low', 'medium', 'high'];
    case 'deepseek':
      return ['auto', 'low', 'high', 'max'];
    case 'z.ai': case 'z.ai-api': case 'z.ai-cn': case 'z.ai-cn-api':
      // GLM-5.3 distinguishes a Low tier; GLM-5.2 grades only high|max.
      return idMatches(canonicalModelId(model), 'glm-5-3')
        ? ['auto', 'low', 'high', 'max']
        : ['auto', 'high', 'max'];
    case 'kimi': case 'kimi-api': case 'kimi-cn':
      return ['auto', 'low', 'high', 'max'];
    case 'grok':
      return grokHasXhigh(model)
        ? ['auto', 'low', 'medium', 'high', 'max']
        : ['auto', 'low', 'medium', 'high'];
    case 'openrouter':
      return openRouterMaxEffort(model) === 'high'
        ? ['auto', 'low', 'medium', 'high']
        : ['auto', 'low', 'medium', 'high', 'max'];
    default:
      return [];
  }
}

/**
 * Map a (possibly out-of-range) tier to the tier this model actually distinguishes,
 * for display — the chip + the checked menu row. The effort setting is global, so
 * a tier picked on Opus ('medium') may not exist on Kimi K3; we show the level
 * Kimi will really run (its 'medium' clamps to 'high'). Picks the tier whose
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
