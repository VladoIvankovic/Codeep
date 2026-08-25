import * as http from 'node:http';
import * as https from 'node:https';
import { Message, config, getApiKey, resolveBaseUrl, describeUnsendableKey } from '../config/index';
import { withRetry, isNetworkError } from '../utils/retry';
import { checkApiRateLimit } from '../utils/ratelimit';
import { ProjectContext } from '../utils/project';
import { getProvider, getProviderBaseUrl, getProviderAuthHeader, usesMaxCompletionTokens, requiresDefaultTemperature, modelRejectsSamplingParams, reasoningParamsFor, type ReasoningTier } from '../config/providers';
import { logApiRequest, logApiResponse } from '../utils/logger';
import { loadProjectIntelligence, generateContextFromIntelligence, ProjectIntelligence } from '../utils/projectIntelligence';
import { loadProjectRules } from '../utils/agent';
import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from '../utils/tokenTracker';

/**
 * OpenRouter returns the authoritative per-call USD in `usage.cost` when
 * the request opts in via `usage: { include: true }`. Pull it here so
 * every chat() / streamChat() / etc. path records the real cost instead
 * of our local pricing estimate. Returns undefined for non-OpenRouter
 * providers or when the field is missing (older OpenRouter API responses).
 */
function openRouterReportedCost(providerId: string, data: unknown): number | undefined {
  if (providerId !== 'openrouter') return undefined;
  const cost = (data as { usage?: { cost?: unknown } } | null)?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}
import { getTaskContextPrompt } from '../utils/taskContext';

// Error messages by language
const ERROR_MESSAGES: Record<string, Record<string, string>> = {
  en: {
    noInternet: 'No internet connection. Please check your network.',
    timeout: 'Request timed out. Please try again.',
    retrying: 'Connection failed, retrying...',
    apiError: 'API error',
  },
  zh: {
    noInternet: '没有网络连接。请检查您的网络。',
    timeout: '请求超时。请重试。',
    retrying: '连接失败，正在重试...',
    apiError: 'API 错误',
  },
  es: {
    noInternet: 'Sin conexión a internet. Verifique su red.',
    timeout: 'La solicitud ha expirado. Inténtelo de nuevo.',
    retrying: 'Conexión fallida, reintentando...',
    apiError: 'Error de API',
  },
  hi: {
    noInternet: 'इंटरनेट कनेक्शन नहीं है। कृपया अपना नेटवर्क जाँचें।',
    timeout: 'अनुरोध का समय समाप्त हो गया। कृपया पुनः प्रयास करें।',
    retrying: 'कनेक्शन विफल, पुनः प्रयास हो रहा है...',
    apiError: 'API त्रुटि',
  },
  ar: {
    noInternet: 'لا يوجد اتصال بالإنترنت. يرجى التحقق من شبكتك.',
    timeout: 'انتهت مهلة الطلب. يرجى المحاولة مرة أخرى.',
    retrying: 'فشل الاتصال، جارٍ إعادة المحاولة...',
    apiError: 'خطأ في API',
  },
  pt: {
    noInternet: 'Sem conexão com a internet. Verifique sua rede.',
    timeout: 'A solicitação expirou. Tente novamente.',
    retrying: 'Conexão falhou, tentando novamente...',
    apiError: 'Erro de API',
  },
  fr: {
    noInternet: 'Pas de connexion internet. Vérifiez votre réseau.',
    timeout: 'La requête a expiré. Veuillez réessayer.',
    retrying: 'Connexion échouée, nouvelle tentative...',
    apiError: 'Erreur API',
  },
  de: {
    noInternet: 'Keine Internetverbindung. Überprüfen Sie Ihr Netzwerk.',
    timeout: 'Zeitüberschreitung der Anfrage. Bitte versuchen Sie es erneut.',
    retrying: 'Verbindung fehlgeschlagen, erneuter Versuch...',
    apiError: 'API-Fehler',
  },
  ja: {
    noInternet: 'インターネット接続がありません。ネットワークを確認してください。',
    timeout: 'リクエストがタイムアウトしました。もう一度お試しください。',
    retrying: '接続に失敗しました。再試行中...',
    apiError: 'APIエラー',
  },
  ru: {
    noInternet: 'Нет подключения к интернету. Проверьте сеть.',
    timeout: 'Время запроса истекло. Попробуйте снова.',
    retrying: 'Сбой подключения, повторная попытка...',
    apiError: 'Ошибка API',
  },
  hr: {
    noInternet: 'Nema internet konekcije. Provjerite mrežu.',
    timeout: 'Zahtjev je istekao. Pokušajte ponovo.',
    retrying: 'Konekcija nije uspjela, pokušavam ponovo...',
    apiError: 'API greška',
  },
};

function getErrorMessage(key: string): string {
  const lang = config.get('language');
  const messages = ERROR_MESSAGES[lang] || ERROR_MESSAGES['en'];
  return messages[key] || ERROR_MESSAGES['en'][key];
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
    delta?: {
      content?: string;
    };
  }>;
}

interface AnthropicResponse {
  content: Array<{
    text: string;
  }>;
  delta?: {
    text?: string;
  };
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// Store project context for use in system prompt
let currentProjectContext: ProjectContext | null = null;
let cachedIntelligence: ProjectIntelligence | null = null;

export function setProjectContext(ctx: ProjectContext | null): void {
  currentProjectContext = ctx;
  // Try to load cached intelligence when project context is set
  if (ctx) {
    cachedIntelligence = loadProjectIntelligence(ctx.root);
  } else {
    cachedIntelligence = null;
  }
}

/**
 * Parse API error response body into a human-readable message.
 * Handles JSON error responses from OpenAI, Anthropic, and other providers.
 */
function parseApiError(status: number, body: string): string {
  try {
    const json = JSON.parse(body);
    // OpenAI format: { error: { message: "..." } }
    if (json.error?.message) return `${status} - ${json.error.message}`;
    // Anthropic format: { error: { type: "...", message: "..." } }
    if (json.message) return `${status} - ${json.message}`;
    // Other: { detail: "..." }
    if (json.detail) return `${status} - ${json.detail}`;
  } catch {
    // Not JSON — use raw body but truncate
  }
  // Truncate long raw error bodies
  const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
  return `${status} - ${truncated}`;
}

/**
 * Put the key in the right header, refusing early if it cannot be sent.
 *
 * `fetch` throws "Cannot convert argument to a ByteString because the character
 * at index N…" for a header value outside Latin-1, counting from the start of
 * `Bearer <key>` — so the index points four characters left of where anyone
 * would look, and the message never mentions the key at all. Worse, the caller
 * treats it as a transient API error and retries twice more, which cannot
 * possibly help.
 */
function applyAuthHeader(
  headers: Record<string, string>,
  apiKey: string,
  authHeader: string,
): void {
  const problem = describeUnsendableKey(apiKey);
  if (problem) {
    throw new ApiError(`This API key cannot be used: ${problem}. Re-copy it and run /login to set it again.`, 400);
  }
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }
}

export async function chat(
  message: string,
  history: Message[] = [],
  onChunk?: (chunk: string) => void,
  onRetry?: (attempt: number) => void,
  projectContext?: ProjectContext | null,
  abortSignal?: AbortSignal
): Promise<string> {
  // Update project context if provided
  if (projectContext !== undefined) {
    currentProjectContext = projectContext;
  }

  const protocol = config.get('protocol');
  const model = config.get('model');
  const providerId = config.get('provider');

  // Global API throttle — the single choke point every surface funnels
  // through (TUI chat, agent loop, ACP sessions, sub-agents, session
  // titles). Without this, a runaway agent loop burns provider quota and
  // hits provider-side 429s with nothing on our side slowing it down.
  const rateCheck = checkApiRateLimit();
  if (!rateCheck.allowed) {
    throw new ApiError(rateCheck.message || 'API rate limit exceeded', 429);
  }

  const { isNoApiKeyProvider } = await import('../config/providers.js');
  const apiKey = getApiKey() || (isNoApiKeyProvider(providerId) ? 'ollama' : null);

  if (!apiKey) {
    throw new Error('API key not configured');
  }

  // Log API request
  logApiRequest(providerId, model, history.length + 1);

  const chatFn = protocol === 'anthropic' 
    ? () => chatAnthropic(message, history, model, apiKey, onChunk, abortSignal)
    : () => chatOpenAI(message, history, model, apiKey, onChunk, abortSignal);

  try {
    const response = await withRetry(chatFn, {
      maxAttempts: 3,
      baseDelay: 1000,
      onRetry: (attempt, error) => {
        if (onRetry) {
          onRetry(attempt);
        }
      },
      shouldRetry: (error) => {
        // Don't retry on user abort or timeout
        if (error.name === 'AbortError' || error instanceof TimeoutError) return false;
        // Don't retry on 4xx client errors (except 429 rate limit)
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) return false;
        // Retry on network errors, 5xx, and rate limits
        return true;
      },
    });

    // Log successful response
    logApiResponse(providerId, true, response.length);
    return response;
  } catch (error: unknown) {
    const err = error as Error;

    // Timeout errors (from chatOpenAI/chatAnthropic) — show user-friendly message
    if (error instanceof TimeoutError) {
      logApiResponse(providerId, false, undefined, 'timeout');
      throw error;
    }

    // User cancel (Escape key) — re-throw silently without logging
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      throw error;
    }

    // Log error
    const e = error as any;
    const errDetail = [
      err.message || '(no message)',
      e?.code ? `code=${e.code}` : '',
      e?.cause ? `cause=${e.cause?.message || e.cause?.code || String(e.cause)}` : '',
      e?.errors ? `errors=${JSON.stringify(e.errors?.map((x: any) => x?.message || x?.code))}` : '',
    ].filter(Boolean).join(' | ');
    logApiResponse(providerId, false, undefined, errDetail);
    
    // Translate errors to user-friendly messages
    if (isNetworkError(error)) {
      const providerId = config.get('provider');
      if (providerId === 'ollama') {
        const ollamaUrl = config.get('ollamaUrl') || 'http://localhost:11434';
        throw new Error(`Cannot connect to Ollama at ${ollamaUrl}. Make sure Ollama is running and OLLAMA_HOST=0.0.0.0 is set.`);
      }
      throw new Error(getErrorMessage('noInternet'));
    }
    throw error;
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English',
  'zh': 'Chinese (中文)',
  'es': 'Spanish (Español)',
  'hi': 'Hindi (हिन्दी)',
  'ar': 'Arabic (العربية)',
  'pt': 'Portuguese (Português)',
  'fr': 'French (Français)',
  'de': 'German (Deutsch)',
  'ja': 'Japanese (日本語)',
  'ru': 'Russian (Русский)',
  'hr': 'Croatian (Hrvatski)',
};

/**
 * Build the agent's identity sentence from the active provider + model.
 * Codeep is the product; the model underneath varies. Stating it
 * explicitly stops models from guessing their own identity (GLM and
 * others often claim to be Claude because their training data includes
 * Claude transcripts).
 */
function buildIdentityLine(): string {
  const model = String(config.get('model') || '');
  const providerId = String(config.get('provider') || '');
  const known: Record<string, string> = {
    'z.ai': 'Z.AI', 'z.ai-api': 'Z.AI', 'z.ai-cn': 'Z.AI', 'z.ai-cn-api': 'Z.AI',
    openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google',
    minimax: 'MiniMax', 'minimax-api': 'MiniMax', 'minimax-cn': 'MiniMax',
    openrouter: 'OpenRouter', ollama: 'Ollama (local)',
  };
  const providerName = known[providerId] || providerId || 'your configured provider';
  if (model) {
    return `You are Codeep, an AI coding assistant. You are running on the \`${model}\` model via ${providerName}. If asked which model or provider you are, answer truthfully with these details — do not claim to be a different model.`;
  }
  return `You are Codeep, an AI coding assistant.`;
}

function getSystemPrompt(): string {
  const language = config.get('language');

  // Identity line so the model doesn't hallucinate its name when asked
  // "what model are you" — without it, models guess from their training
  // data (e.g. GLM claiming to be Claude). State the truth: the product
  // is Codeep, the underlying model + provider come from config.
  const identity = buildIdentityLine();

  let basePrompt: string;
  if (language === 'auto') {
    basePrompt = `${identity} Always respond in the same language as the user's message. Detect the language of the user's input and reply in that same language.`;
  } else {
    const langName = LANGUAGE_NAMES[language] || 'English';
    basePrompt = `${identity} Always respond in ${langName}, regardless of what language the user writes in.`;
  }
  
  // Important: This is CHAT mode, not agent mode
  // The model should NOT pretend to execute tools or create files
  basePrompt += `

IMPORTANT: You are in CHAT mode, NOT agent mode. You do NOT have the ability to:
- Create, edit, or delete files directly
- Execute shell commands
- Use tools or tool_calls

If the conversation history contains messages about file creation or tool execution, those were from a previous agent session. In chat mode, you can only provide advice, explanations, and code suggestions that the user must manually apply.`;

  // Add project context if available
  if (currentProjectContext) {
    const writeInfo = currentProjectContext.hasWriteAccess 
      ? `

**Write Access:** ENABLED - You can suggest file modifications. Format them as:
\`\`\`filepath:path/to/file.ts
// modified code here
\`\`\`
The user will review and approve changes before they are applied.`
      : `

**Write Access:** READ-ONLY - You can analyze code but cannot suggest file modifications.`;

    // Use cached intelligence if available (from /scan command)
    // This provides richer context than basic project structure
    if (cachedIntelligence) {
      const intelligenceContext = generateContextFromIntelligence(cachedIntelligence);
      const projectInfo = `

## Project Intelligence (cached)
${intelligenceContext}
${writeInfo}

When the user mentions a file path, the file content will be automatically attached to their message.
You can analyze, explain, or suggest improvements to the code.`;
      
      return basePrompt + projectInfo + loadProjectRules(currentProjectContext.root);
    }

    // Fallback to basic project context
    const projectInfo = `

## Project Context
You are working with a ${currentProjectContext.type} project called "${currentProjectContext.name}".

**Project Structure:**
\`\`\`
${currentProjectContext.structure}
\`\`\`

**Key Files:** ${currentProjectContext.keyFiles.join(', ')}${writeInfo}

When the user mentions a file path, the file content will be automatically attached to their message.
You can analyze, explain, or suggest improvements to the code.`;

    return basePrompt + projectInfo + loadProjectRules(currentProjectContext.root) + getTaskContextPrompt();
  }

  return basePrompt + getTaskContextPrompt();
}

async function chatOpenAI(
  message: string,
  history: Message[],
  model: string,
  apiKey: string,
  onChunk?: (chunk: string)  => void,
  abortSignal?: AbortSignal
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: getSystemPrompt() },
    ...history,
    { role: 'user' as const, content: message },
  ];

  const stream = Boolean(onChunk);
  const timeout = config.get('apiTimeout');
  const temperature = config.get('temperature');
  const maxTokens = config.get('maxTokens');

  // Get provider-specific URL and auth. resolveBaseUrl applies user
  // overrides: Ollama (ollamaUrl), Custom (customBaseUrl), and OpenAI
  // (OPENAI_BASE_URL env) — so self-hosted / OpenAI-compatible endpoints work.
  const providerId = config.get('provider');
  let baseUrl = resolveBaseUrl(providerId, 'openai');
  const authHeader = getProviderAuthHeader(providerId, 'openai');
  const useCompletionTokens = usesMaxCompletionTokens(providerId);
  // Two independent reasons to leave temperature out, and both must be checked
  // here: the provider-level flag (endpoints that only accept the default) and
  // the per-model one (generations that removed the sampling params outright,
  // e.g. gemini-3.7-flash). Testing only the provider flag let a rejecting
  // model through, because every model this rule covers is served over the
  // OpenAI-compatible path, not the Anthropic one.
  const omitTemperature = requiresDefaultTemperature(providerId) || modelRejectsSamplingParams(model);

  if (!baseUrl) {
    throw new Error(`Provider ${providerId} does not support OpenAI protocol`);
  }

  // Create abort controller with timeout flag to distinguish from user cancel
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);

  // Listen to external abort signal if provided (user cancel).
  // Named handler + explicit removal in `finally` — `{ once: true }` alone leaks
  // when the request completes normally, piling up listeners across agent iterations.
  const onExternalAbort = () => controller.abort();
  if (abortSignal) {
    abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Build headers based on auth type
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  applyAuthHeader(headers, apiKey, authHeader);
  // OpenRouter: branding headers + opt in to `usage.cost` so the
  // chat path reports authoritative per-call cost just like agentChat
  // does. Kept identical to the agentChat block so the two paths stay
  // in lockstep.
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://codeep.dev';
    headers['X-Title'] = 'Codeep';
  }

  // Lazy-loaded preferences object — only attached for openrouter so we
  // never send the field to providers that don't understand it.
  let openRouterProvider: unknown = undefined;
  if (providerId === 'openrouter') {
    const { readOpenRouterPreferences } = await import('../utils/openrouterPrefs');
    openRouterProvider = readOpenRouterPreferences() ?? undefined;
  }

  const requestBody = JSON.stringify({
    model,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(omitTemperature ? {} : { temperature }),
    ...(useCompletionTokens ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...reasoningParamsFor(providerId, model, config.get('reasoningEffort') as ReasoningTier),
    ...(providerId === 'openrouter' ? { usage: { include: true } } : {}),
    ...(openRouterProvider ? { provider: openRouterProvider } : {}),
  });

  try {
    // Opt-in native Ollama transport (plain chat). When `ollamaNativeApi` is on,
    // route through /api/chat so num_ctx + keep_alive apply and the real context
    // window is used. OFF by default → falls through to the /v1 shim below
    // unchanged. Plain chat sends no tools, so the native call is simple here.
    if (providerId === 'ollama' && config.get('ollamaNativeApi') === true) {
      const { streamOllamaNativeChat, getOllamaContextLength } = await import('./ollamaNative.js');
      const ollamaUrl = (config.get('ollamaUrl') as string) || 'http://localhost:11434';
      const cfgCtx = Number(config.get('ollamaNumCtx')) || 0;
      const numCtx = cfgCtx > 0 ? cfgCtx : ((await getOllamaContextLength(model, ollamaUrl)) ?? undefined);
      const result = await streamOllamaNativeChat({
        baseUrl: ollamaUrl,
        model,
        messages,
        numCtx,
        keepAlive: (config.get('ollamaKeepAlive') as string) || undefined,
        temperature: omitTemperature ? undefined : temperature,
        timeoutMs: timeout,
        onChunk: stream ? onChunk : undefined,
      });
      if (result.promptTokens != null && result.completionTokens != null) {
        recordTokenUsage(
          { promptTokens: result.promptTokens, completionTokens: result.completionTokens, totalTokens: result.promptTokens + result.completionTokens },
          model, providerId,
        );
      }
      return stripThinkTags(result.text);
    }

    // Use node:http for Ollama — bypasses undici connection pooling (AggregateError in Node v24)
    if (providerId === 'ollama') {
      const nodeStream = await httpRequest(`${baseUrl}/chat/completions`, {
        method: 'POST', headers, body: requestBody, timeout,
      });
      if (stream) {
        return handleNodeStream(nodeStream, onChunk!, model);
      } else {
        const text = await new Promise<string>((resolve, reject) => {
          let data = '';
          nodeStream.on('data', (c: Buffer) => data += c.toString());
          nodeStream.on('end', () => resolve(data));
          nodeStream.on('error', reject);
        });
        const parsed = JSON.parse(text) as OpenAIResponse;
        const usage = extractOpenAIUsage(parsed);
        if (usage) recordTokenUsage(usage, model, providerId, openRouterReportedCost(providerId, parsed));
        return stripThinkTags(parsed.choices[0]?.message?.content || '');
      }
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ApiError(`${getErrorMessage('apiError')}: ${parseApiError(response.status, body)}`, response.status);
    }

    if (stream && response.body) {
      return handleOpenAIStream(response.body, onChunk!, providerId, model);
    } else {
      const data = await response.json() as OpenAIResponse;
      const usage = extractOpenAIUsage(data);
      if (usage) recordTokenUsage(usage, model, providerId, openRouterReportedCost(providerId, data));
      const content = data.choices[0]?.message?.content || '';
      return stripThinkTags(content);
    }
  } catch (error) {
    if (timedOut) {
      throw new TimeoutError(getErrorMessage('timeout'));
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (abortSignal) abortSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * HTTP request using node:http/https — bypasses undici connection pooling.
 * Used for Ollama to avoid AggregateError in Node v24.
 */
function httpRequest(url: string, options: { method: string; headers: Record<string, string>; body: string; timeout: number }): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method,
      headers: { ...options.headers, 'Connection': 'close' },
      timeout: options.timeout,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => reject(new ApiError(`${getErrorMessage('apiError')}: ${res.statusCode} ${body}`, res.statusCode!)));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(options.body);
    req.end();
  });
}

async function handleNodeStream(
  nodeStream: NodeJS.ReadableStream,
  onChunk: (chunk: string) => void,
  model: string
): Promise<string> {
  const chunks: string[] = [];
  let buffer = '';

  return new Promise((resolve, reject) => {
    nodeStream.on('data', (raw: Buffer) => {
      buffer += raw.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) { chunks.push(content); onChunk(content); }
          if (parsed.usage) {
            const usage = extractOpenAIUsage(parsed);
            const provider = config.get('provider');
            if (usage) recordTokenUsage(usage, parsed.model || model, provider, openRouterReportedCost(provider, parsed));
          }
        } catch { /* ignore parse errors */ }
      }
    });
    nodeStream.on('end', () => resolve(stripThinkTags(chunks.join(''))));
    nodeStream.on('error', (err) => {
      if (chunks.length > 0) resolve(stripThinkTags(chunks.join('')));
      else reject(err);
    });
  });
}

async function handleOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
  providerId?: string,
  modelOverride?: string,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              chunks.push(content);
              onChunk(content);
            }
            // Capture usage from final chunk (stream_options: include_usage)
            if (parsed.usage) {
              const usage = extractOpenAIUsage(parsed);
              const provider = providerId ?? config.get('provider');
              const m = parsed.model || modelOverride || 'unknown';
              if (usage) recordTokenUsage(usage, m, provider, openRouterReportedCost(provider, parsed));
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } catch (e: any) {
    // AggregateError / undici stream close — if we already have content, treat as complete
    if (chunks.length > 0) {
      return stripThinkTags(chunks.join(''));
    }
    throw e;
  }

  // Strip <think> tags from MiniMax and other providers
  return stripThinkTags(chunks.join(''));
}

async function chatAnthropic(
  message: string,
  history: Message[],
  model: string,
  apiKey: string,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  const systemPrompt = getSystemPrompt();
  const providerId = config.get('provider');
  
  // Use native system parameter for Anthropic, fake turns for other providers
  const useNativeSystem = providerId === 'anthropic';
  const messages = useNativeSystem
    ? [...history, { role: 'user' as const, content: message }]
    : [
        { role: 'user' as const, content: systemPrompt },
        { role: 'assistant' as const, content: 'Understood.' },
        ...history,
        { role: 'user' as const, content: message },
      ];

  const stream = Boolean(onChunk);
  const timeout = config.get('apiTimeout');
  const temperature = config.get('temperature');
  const maxTokens = config.get('maxTokens');
  const baseUrl = getProviderBaseUrl(providerId, 'anthropic');
  const authHeader = getProviderAuthHeader(providerId, 'anthropic');

  if (!baseUrl) {
    throw new Error(`Provider ${providerId} does not support Anthropic protocol`);
  }

  // Create abort controller with timeout flag to distinguish from user cancel
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);

  // Listen to external abort signal if provided (user cancel).
  // Named handler + explicit removal in `finally` — `{ once: true }` alone leaks
  // when the request completes normally, piling up listeners across agent iterations.
  const onExternalAbort = () => controller.abort();
  if (abortSignal) {
    abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Build headers based on auth type
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  applyAuthHeader(headers, apiKey, authHeader);

  try {
    // Anthropic prompt caching: wrap system as an array with a
    // `cache_control` marker so the static system prompt (typically large
    // and stable across a session) is cached. Below 1024 input tokens
    // Anthropic silently skips caching — no error.
    const cachedSystem = useNativeSystem
      ? { system: [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }] }
      : {};
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        // Fable 5 / Opus 4.7+ reject temperature with a 400 — omit it there
        // (omission means API default on every Claude model).
        ...(modelRejectsSamplingParams(model) ? {} : { temperature }),
        ...reasoningParamsFor(providerId, model, config.get('reasoningEffort') as ReasoningTier),
        stream,
        ...cachedSystem,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ApiError(`${getErrorMessage('apiError')}: ${parseApiError(response.status, body)}`, response.status);
    }

    if (stream && response.body) {
      return handleAnthropicStream(response.body, onChunk!);
    } else {
      const data = await response.json() as AnthropicResponse;
      const usage = extractAnthropicUsage(data);
      if (usage) recordTokenUsage(usage, model, config.get('provider'));
      const content = data.content[0]?.text || '';
      return stripThinkTags(content);
    }
  } catch (error) {
    if (timedOut) {
      throw new TimeoutError(getErrorMessage('timeout'));
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (abortSignal) abortSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Remove <think>...</think> tags from response
 * Some providers (MiniMax, DeepSeek) include internal reasoning in these tags
 * which should not be shown to users
 */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function handleAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let streamModel = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            const text = parsed.delta?.text;
            if (text) {
              chunks.push(text);
              onChunk(text);
            }
          }
          // message_start contains input_tokens (and cache create/read
          // when prompt caching is in play).
          if (parsed.type === 'message_start' && parsed.message?.usage) {
            const u = parsed.message.usage;
            inputTokens = u.input_tokens || 0;
            cacheCreationTokens = u.cache_creation_input_tokens || 0;
            cacheReadTokens = u.cache_read_input_tokens || 0;
            streamModel = parsed.message.model || '';
          }
          // message_delta contains output_tokens
          if (parsed.type === 'message_delta' && parsed.usage) {
            outputTokens = parsed.usage.output_tokens || 0;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  // Record token usage
  if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0) {
    const totalPrompt = inputTokens + cacheCreationTokens + cacheReadTokens;
    recordTokenUsage(
      {
        promptTokens: totalPrompt,
        completionTokens: outputTokens,
        totalTokens: totalPrompt + outputTokens,
        cacheCreationTokens: cacheCreationTokens || undefined,
        cacheReadTokens: cacheReadTokens || undefined,
      },
      streamModel || 'unknown',
      config.get('provider')
    );
  }

  // Strip <think> tags from MiniMax responses
  return stripThinkTags(chunks.join(''));
}

export async function validateApiKey(apiKey: string, providerId?: string): Promise<{ valid: boolean; error?: string }> {
  const provider = providerId || config.get('provider');
  const providerConfig = getProvider(provider);
  
  if (!providerConfig) {
    return { valid: false, error: `Unknown provider: ${provider}` };
  }

  // Determine which protocol to use for validation
  const protocol = providerConfig.defaultProtocol;
  const baseUrl = resolveBaseUrl(provider, protocol);
  const authHeader = getProviderAuthHeader(provider, protocol);
  const model = providerConfig.defaultModel;

  if (!baseUrl) {
    return { valid: false, error: `No endpoint configured for ${provider}` };
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  applyAuthHeader(headers, apiKey, authHeader);
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }

  // Build request based on protocol
  const endpoint = protocol === 'openai' ? '/chat/completions' : '/v1/messages';
  const tokenParam = protocol === 'openai' && usesMaxCompletionTokens(provider)
    ? { max_completion_tokens: 5 }
    : { max_tokens: 5 };
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...tokenParam,
  };

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return { valid: true };
    } else {
      const errorText = await response.text();
      return { valid: false, error: `${response.status}: ${errorText}` };
    }
  } catch (err: unknown) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
