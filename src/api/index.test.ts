import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── Mock setup ──────────────────────────────────────────────────────────────
// Mock config module
vi.mock('../config/index', () => ({
  config: {
    get: vi.fn((key: string) => {
      const defaults: Record<string, unknown> = {
        protocol: 'openai',
        model: 'gpt-4',
        provider: 'openai',
        language: 'en',
        apiTimeout: 30000,
        temperature: 0.7,
        maxTokens: 4096,
      };
      return defaults[key];
    }),
  },
  getApiKey: vi.fn(() => 'test-api-key'),
  Message: undefined,
}));

vi.mock('../config/providers', () => ({
  getProvider: vi.fn((id: string) => ({
    defaultProtocol: 'openai',
    defaultModel: 'gpt-4',
  })),
  getProviderBaseUrl: vi.fn((_id: string, _proto: string) => 'https://api.example.com'),
  getProviderAuthHeader: vi.fn(() => 'Bearer'),
}));

vi.mock('../utils/retry', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  isNetworkError: vi.fn((e: unknown) => (e as Error).message?.includes('fetch')),
  isTimeoutError: vi.fn(() => false),
}));

vi.mock('../utils/logger', () => ({
  logApiRequest: vi.fn(),
  logApiResponse: vi.fn(),
  logAppError: vi.fn(),
}));

vi.mock('../utils/projectIntelligence', () => ({
  loadProjectIntelligence: vi.fn(() => null),
  generateContextFromIntelligence: vi.fn(() => ''),
}));

vi.mock('../utils/agent', () => ({
  loadProjectRules: vi.fn(() => ''),
}));

vi.mock('../utils/tokenTracker', () => ({
  recordTokenUsage: vi.fn(),
  extractOpenAIUsage: vi.fn(() => null),
  extractAnthropicUsage: vi.fn(() => null),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { chat, validateApiKey, setProjectContext } from './index';
import { config, getApiKey } from '../config/index';
import { getProviderBaseUrl, getProviderAuthHeader, getProvider } from '../config/providers';
import { withRetry } from '../utils/retry';
import { recordTokenUsage, extractOpenAIUsage, extractAnthropicUsage } from '../utils/tokenTracker';

const mockConfig = config as { get: ReturnType<typeof vi.fn> };
const mockGetApiKey = getApiKey as ReturnType<typeof vi.fn>;
const mockGetProviderBaseUrl = getProviderBaseUrl as ReturnType<typeof vi.fn>;
const mockGetProviderAuthHeader = getProviderAuthHeader as ReturnType<typeof vi.fn>;
const mockGetProvider = getProvider as ReturnType<typeof vi.fn>;
const mockWithRetry = withRetry as ReturnType<typeof vi.fn>;
const mockRecordTokenUsage = recordTokenUsage as ReturnType<typeof vi.fn>;
const mockExtractOpenAIUsage = extractOpenAIUsage as ReturnType<typeof vi.fn>;
const mockExtractAnthropicUsage = extractAnthropicUsage as ReturnType<typeof vi.fn>;

// Helper to build a minimal JSON Response
function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseApiError (via chat() error path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('surfaces OpenAI JSON error message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })
    );
    await expect(chat('hi')).rejects.toThrow('invalid key');
  });

  it('surfaces Anthropic JSON error message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Not authorized' }), { status: 401 })
    );
    await expect(chat('hi')).rejects.toThrow('Not authorized');
  });

  it('truncates long non-JSON error bodies', async () => {
    const longBody = 'x'.repeat(300);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(longBody, { status: 500 })
    );
    await expect(chat('hi')).rejects.toThrow('...');
  });
});

describe('chat() — OpenAI protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();

    mockConfig.get.mockImplementation((key: string) => {
      const vals: Record<string, unknown> = {
        protocol: 'openai',
        model: 'gpt-4',
        provider: 'openai',
        language: 'en',
        apiTimeout: 30000,
        temperature: 0.7,
        maxTokens: 4096,
      };
      return vals[key];
    });

    mockGetApiKey.mockReturnValue('test-key');
    mockGetProviderBaseUrl.mockReturnValue('https://api.example.com');
    mockGetProviderAuthHeader.mockReturnValue('Bearer');

    // Let withRetry pass-through by default
    mockWithRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('throws if API key is missing', async () => {
    mockGetApiKey.mockReturnValue('');
    await expect(chat('hello')).rejects.toThrow('API key not configured');
  });

  it('calls /chat/completions with correct headers and returns content', async () => {
    const body = { choices: [{ message: { content: 'Hello!' } }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));

    const result = await chat('hi');

    expect(result).toBe('Hello!');
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/chat/completions');
    expect(opts.headers['Authorization']).toBe('Bearer test-key');
  });

  it('uses x-api-key header when authHeader is not Bearer', async () => {
    mockGetProviderAuthHeader.mockReturnValue('x-api-key');
    const body = { choices: [{ message: { content: 'ok' } }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));

    await chat('hi');

    const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.headers['x-api-key']).toBe('test-key');
    expect(opts.headers['Authorization']).toBeUndefined();
  });

  it('strips <think> tags from response', async () => {
    const body = { choices: [{ message: { content: '<think>internal</think>Final answer' } }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));

    const result = await chat('hi');
    expect(result).toBe('Final answer');
    expect(result).not.toContain('<think>');
  });

  it('records token usage when API returns usage', async () => {
    const body = {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));
    mockExtractOpenAIUsage.mockReturnValueOnce({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });

    await chat('hi');

    expect(mockRecordTokenUsage).toHaveBeenCalledWith(
      { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      'gpt-4',
      'openai'
    );
  });

  it('throws user-friendly network error on fetch failure', async () => {
    const netErr = new TypeError('Failed to fetch');
    mockWithRetry.mockRejectedValueOnce(netErr);

    // isNetworkError mock needs to return true for this
    const { isNetworkError } = await import('../utils/retry');
    (isNetworkError as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    await expect(chat('hi')).rejects.toThrow(/internet|network/i);
  });

  it('re-throws timeout error without wrapping', async () => {
    const timeoutErr = new Error('timed out');
    (timeoutErr as any).isTimeout = true;
    mockWithRetry.mockRejectedValueOnce(timeoutErr);

    await expect(chat('hi')).rejects.toMatchObject({ isTimeout: true });
  });

  it('re-throws AbortError without network-error wrapping', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockWithRetry.mockRejectedValueOnce(abortErr);

    await expect(chat('hi')).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('chat() — Anthropic protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();

    mockConfig.get.mockImplementation((key: string) => {
      const vals: Record<string, unknown> = {
        protocol: 'anthropic',
        model: 'claude-3',
        provider: 'anthropic',
        language: 'en',
        apiTimeout: 30000,
        temperature: 0.7,
        maxTokens: 4096,
      };
      return vals[key];
    });

    mockGetApiKey.mockReturnValue('test-key');
    mockGetProviderBaseUrl.mockReturnValue('https://api.anthropic.com');
    mockGetProviderAuthHeader.mockReturnValue('x-api-key');
    mockWithRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('calls /v1/messages with anthropic-version header', async () => {
    const body = { content: [{ text: 'Hi there' }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));

    const result = await chat('hello');

    expect(result).toBe('Hi there');
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/v1/messages');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    expect(opts.headers['x-api-key']).toBe('test-key');
  });

  it('strips <think> tags from Anthropic response', async () => {
    const body = { content: [{ text: '<think>reasoning</think>Result' }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));

    const result = await chat('hi');
    expect(result).toBe('Result');
  });

  it('records token usage from Anthropic response', async () => {
    const body = { content: [{ text: 'ok' }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeResponse(body));
    mockExtractAnthropicUsage.mockReturnValueOnce({ promptTokens: 5, completionTokens: 15, totalTokens: 20 });

    await chat('hi');

    expect(mockRecordTokenUsage).toHaveBeenCalledWith(
      { promptTokens: 5, completionTokens: 15, totalTokens: 20 },
      'claude-3',
      'anthropic'
    );
  });
});

describe('chat() — shouldRetry predicate', () => {
  let capturedShouldRetry: ((e: Error) => boolean) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();

    mockConfig.get.mockImplementation((key: string) => {
      const vals: Record<string, unknown> = {
        protocol: 'openai', model: 'gpt-4', provider: 'openai',
        language: 'en', apiTimeout: 30000, temperature: 0.7, maxTokens: 4096,
      };
      return vals[key];
    });
    mockGetApiKey.mockReturnValue('key');
    mockGetProviderBaseUrl.mockReturnValue('https://api.example.com');
    mockGetProviderAuthHeader.mockReturnValue('Bearer');

    // Capture shouldRetry so we can test it
    mockWithRetry.mockImplementation(async (fn: () => Promise<unknown>, opts: { shouldRetry?: (e: Error) => boolean }) => {
      capturedShouldRetry = opts?.shouldRetry;
      return fn();
    });

    // Fake a successful fetch so the wrapping succeeds
    const successBody = { choices: [{ message: { content: 'ok' } }] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse(successBody));
  });

  it('does not retry on AbortError', async () => {
    await chat('hi');
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(capturedShouldRetry?.(abortErr)).toBe(false);
  });

  it('does not retry on timeout errors', async () => {
    await chat('hi');
    const timeoutErr = Object.assign(new Error('timeout'), { isTimeout: true });
    expect(capturedShouldRetry?.(timeoutErr)).toBe(false);
  });

  it('does not retry on 400 client errors', async () => {
    await chat('hi');
    const err = Object.assign(new Error('bad request'), { status: 400 });
    expect(capturedShouldRetry?.(err)).toBe(false);
  });

  it('does not retry on 401 client errors', async () => {
    await chat('hi');
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    expect(capturedShouldRetry?.(err)).toBe(false);
  });

  it('retries on 429 rate limit', async () => {
    await chat('hi');
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    expect(capturedShouldRetry?.(err)).toBe(true);
  });

  it('retries on 500 server error', async () => {
    await chat('hi');
    const err = Object.assign(new Error('server error'), { status: 500 });
    expect(capturedShouldRetry?.(err)).toBe(true);
  });

  it('retries on network errors', async () => {
    await chat('hi');
    // status undefined — treated as retryable
    const err = new Error('network failure');
    expect(capturedShouldRetry?.(err)).toBe(true);
  });
});

describe('validateApiKey()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();

    mockConfig.get.mockImplementation((key: string) => {
      const vals: Record<string, unknown> = { provider: 'openai' };
      return vals[key];
    });
    mockGetProviderBaseUrl.mockReturnValue('https://api.example.com');
    mockGetProviderAuthHeader.mockReturnValue('Bearer');
    mockGetProvider.mockReturnValue({ defaultProtocol: 'openai', defaultModel: 'gpt-4' });
  });

  it('returns valid:true when API responds 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('{}', { status: 200 })
    );

    const result = await validateApiKey('my-key');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns valid:false with error on non-200 response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    const result = await validateApiKey('bad-key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns valid:false when provider is unknown', async () => {
    mockGetProvider.mockReturnValue(null);

    const result = await validateApiKey('any-key', 'nonexistent-provider');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown provider');
  });

  it('returns valid:false when baseUrl is missing', async () => {
    mockGetProviderBaseUrl.mockReturnValue(null);

    const result = await validateApiKey('any-key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No endpoint');
  });

  it('returns valid:false on fetch error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await validateApiKey('my-key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('sends anthropic-version header for anthropic protocol', async () => {
    mockGetProvider.mockReturnValue({ defaultProtocol: 'anthropic', defaultModel: 'claude-3' });
    mockGetProviderBaseUrl.mockReturnValue('https://api.anthropic.com');
    mockGetProviderAuthHeader.mockReturnValue('x-api-key');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('{}', { status: 200 })
    );

    await validateApiKey('claude-key');

    const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    expect(opts.headers['x-api-key']).toBe('claude-key');
  });
});

describe('setProjectContext()', () => {
  it('sets project context to null without error', () => {
    expect(() => setProjectContext(null)).not.toThrow();
  });

  it('accepts a valid ProjectContext without error', () => {
    const ctx = {
      root: '/my/project',
      name: 'my-project',
      type: 'node',
      structure: 'src/',
      keyFiles: ['package.json'],
      fileCount: 10,
      summary: 'A test project',
    };
    expect(() => setProjectContext(ctx)).not.toThrow();
  });
});
