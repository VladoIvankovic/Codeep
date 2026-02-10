import { Message, config, getApiKey } from '../config/index';
import { withRetry, isNetworkError, isTimeoutError } from '../utils/retry';
import { ProjectContext } from '../utils/project';
import { getProvider, getProviderBaseUrl, getProviderAuthHeader } from '../config/providers';
import { logApiRequest, logApiResponse, logAppError } from '../utils/logger';
import { loadProjectIntelligence, generateContextFromIntelligence, ProjectIntelligence } from '../utils/projectIntelligence';
import { loadProjectRules } from '../utils/agent';
import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from '../utils/tokenTracker';

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
  const apiKey = getApiKey();
  const providerId = config.get('provider');

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
        // Don't retry on user abort
        if (error.name === 'AbortError') return false;
        // Don't retry on 4xx client errors (except 429 rate limit)
        if (error.status >= 400 && error.status < 500 && error.status !== 429) return false;
        // Retry on network errors, timeouts, 5xx, and rate limits
        return true;
      },
    });
    
    // Log successful response
    logApiResponse(providerId, true, response.length);
    return response;
  } catch (error: unknown) {
    const err = error as Error;
    // Don't log or throw if request was aborted by user
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      throw error; // Re-throw abort errors silently
    }
    
    // Log error
    logApiResponse(providerId, false, undefined, err.message);
    
    // Translate errors to user-friendly messages
    if (isNetworkError(error)) {
      throw new Error(getErrorMessage('noInternet'));
    }
    if (isTimeoutError(error)) {
      throw new Error(getErrorMessage('timeout'));
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

function getSystemPrompt(): string {
  const language = config.get('language');
  
  let basePrompt: string;
  if (language === 'auto') {
    basePrompt = `You are a helpful AI coding assistant. Always respond in the same language as the user's message. Detect the language of the user's input and reply in that same language.`;
  } else {
    const langName = LANGUAGE_NAMES[language] || 'English';
    basePrompt = `You are a helpful AI coding assistant. Always respond in ${langName}, regardless of what language the user writes in.`;
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

    return basePrompt + projectInfo + loadProjectRules(currentProjectContext.root);
  }

  return basePrompt;
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
  
  // Get provider-specific URL and auth
  const providerId = config.get('provider');
  const baseUrl = getProviderBaseUrl(providerId, 'openai');
  const authHeader = getProviderAuthHeader(providerId, 'openai');

  if (!baseUrl) {
    throw new Error(`Provider ${providerId} does not support OpenAI protocol`);
  }

  // Create abort controller for timeout or use provided one
  const controller = abortSignal ? new AbortController() : new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  // Listen to external abort signal if provided
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

  // Build headers based on auth type
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      const err = new Error(`${getErrorMessage('apiError')}: ${response.status} - ${error}`);
      (err as any).status = response.status;
      throw err;
    }

    if (stream && response.body) {
      return handleOpenAIStream(response.body, onChunk!);
    } else {
      const data = await response.json() as OpenAIResponse;
      const usage = extractOpenAIUsage(data);
      if (usage) recordTokenUsage(usage, model, config.get('provider'));
      const content = data.choices[0]?.message?.content || '';
      return stripThinkTags(content);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = '';

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
        } catch {
          // Ignore parse errors
        }
      }
    }
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
  const messages = [
    { role: 'user' as const, content: systemPrompt },
    { role: 'assistant' as const, content: 'Understood. I will follow your language instructions.' },
    ...history,
    { role: 'user' as const, content: message },
  ];

  const stream = Boolean(onChunk);
  const timeout = config.get('apiTimeout');
  const temperature = config.get('temperature');
  const maxTokens = config.get('maxTokens');

  // Get provider-specific URL and auth
  const providerId = config.get('provider');
  const baseUrl = getProviderBaseUrl(providerId, 'anthropic');
  const authHeader = getProviderAuthHeader(providerId, 'anthropic');

  if (!baseUrl) {
    throw new Error(`Provider ${providerId} does not support Anthropic protocol`);
  }

  // Create abort controller for timeout or use provided one
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  // Listen to external abort signal if provided
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

  // Build headers based on auth type
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      const err = new Error(`${getErrorMessage('apiError')}: ${response.status} - ${error}`);
      (err as any).status = response.status;
      throw err;
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
  } finally {
    clearTimeout(timeoutId);
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
        } catch {
          // Ignore parse errors
        }
      }
    }
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
  const baseUrl = getProviderBaseUrl(provider, protocol);
  const authHeader = getProviderAuthHeader(provider, protocol);
  const model = providerConfig.defaultModel;

  if (!baseUrl) {
    return { valid: false, error: `No endpoint configured for ${provider}` };
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader === 'Bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }

  // Build request based on protocol
  const endpoint = protocol === 'openai' ? '/chat/completions' : '/v1/messages';
  const body = protocol === 'openai' 
    ? {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }
    : {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
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
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}
