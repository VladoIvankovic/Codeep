# Google AI Provider Design

**Date:** 2026-02-23
**Status:** Approved

## Summary

Add Google AI (Gemini) as a new provider in Codeep using Google's OpenAI-compatible endpoint. No changes required to core API or config logic — the existing provider pattern handles everything.

## Approach

Use Google's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai`) with `Bearer` auth. This allows the existing `chatOpenAI` code path to handle all requests without modification.

## Changes

**Only one file needs to be modified:** `src/config/providers.ts`

Add a new `google` entry to the `PROVIDERS` record:

```typescript
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
    { id: 'gemini-2.5-pro-exp-03-25', name: 'Gemini 2.5 Pro Experimental', description: 'Most capable, best reasoning' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Fast and capable, general use' },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', description: 'Fastest, lowest cost' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Long context (2M tokens)' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', description: 'Balanced speed and quality' },
    { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B', description: 'Ultra-fast, lightweight' },
  ],
  defaultModel: 'gemini-2.0-flash',
  defaultProtocol: 'openai',
  envKey: 'GOOGLE_API_KEY',
  subscribeUrl: 'https://aistudio.google.com/apikey',
}
```

## No Changes Required

- `src/api/index.ts` — existing `chatOpenAI` handles the request
- `src/config/index.ts` — `loadApiKey` already reads `envKey` and `providerApiKeys`
- Any UI/renderer code — provider list is dynamically generated from `PROVIDERS`
