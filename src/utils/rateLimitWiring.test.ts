import { describe, it, expect, beforeEach, vi } from 'vitest';

// Guards for the P0 rate-limit wiring (see CHANGELOG 2.18.2):
//   - api/chat() must throw before any HTTP request when the API limiter blocks
//   - agentChat()/agentChatFallback() must do the same (agent loop path)
//   - executeTool('execute_command') must fail closed when the command
//     limiter blocks
// These are source-level contract tests: they assert the guard call is
// present on the path (grep-style), so a refactor that silently drops it
// fails the suite. The behavioral side of the limiters themselves is covered
// in ratelimit.test.ts.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

const apiSource = readFileSync(join(here, '..', 'api', 'index.ts'), 'utf-8');
const agentChatSource = readFileSync(join(here, 'agentChat.ts'), 'utf-8');
const toolExecutionSource = readFileSync(join(here, 'toolExecution.ts'), 'utf-8');

describe('rate-limit wiring (P0 regression)', () => {
  it('api/chat() checks the API rate limit before dispatching', () => {
    // The guard must appear inside chat() — i.e. before withRetry/chatFn use.
    expect(apiSource).toContain('checkApiRateLimit');
    const chatFn = apiSource.slice(
      apiSource.indexOf('export async function chat('),
      apiSource.indexOf('async function chatOpenAI'),
    );
    expect(chatFn).toContain('checkApiRateLimit');
  });

  it('agentChat() checks the API rate limit (agent loop choke point)', () => {
    const start = agentChatSource.indexOf('export async function agentChat(');
    const end = agentChatSource.indexOf('export async function agentChatFallback(');
    const fn = agentChatSource.slice(start, end > start ? end : undefined);
    expect(fn).toContain('checkApiRateLimit');
  });

  it('agentChatFallback() checks the API rate limit', () => {
    const fn = agentChatSource.slice(agentChatSource.indexOf('export async function agentChatFallback('));
    expect(fn).toContain('checkApiRateLimit');
  });

  it('local (no-key) providers bypass the API limiter in agentChat', () => {
    // Ollama & co must not consume shared quota — there is none to protect.
    expect(agentChatSource).toMatch(/isNoApiKeyProvider\(providerId\)[\s\S]{0,200}checkApiRateLimit|checkApiRateLimit[\s\S]{0,200}isNoApiKeyProvider/);
  });

  it('execute_command goes through the command rate limiter', () => {
    const fn = toolExecutionSource.slice(
      toolExecutionSource.indexOf("case 'execute_command'"),
      toolExecutionSource.indexOf("case 'search_code'"),
    );
    expect(fn).toContain('checkCommandRateLimit');
  });
});
