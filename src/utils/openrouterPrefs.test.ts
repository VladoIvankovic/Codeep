import { describe, it, expect, beforeEach, vi } from 'vitest';

const { configStore } = vi.hoisted(() => ({ configStore: new Map<string, unknown>() }));
vi.mock('../config/index.js', () => ({
  config: {
    get: (k: string) => configStore.get(k),
    set: (k: string, v: unknown) => {
      if (v === undefined) configStore.delete(k);
      else configStore.set(k, v);
    },
  },
}));

import {
  readOpenRouterPreferences,
  writeOpenRouterPreferences,
  formatOpenRouterPreferences,
} from './openrouterPrefs';

beforeEach(() => configStore.clear());

describe('readOpenRouterPreferences', () => {
  it('returns null when nothing stored', () => {
    expect(readOpenRouterPreferences()).toBeNull();
  });

  it('returns cleaned prefs when stored', () => {
    configStore.set('openrouterPreferences', {
      order: ['DeepInfra', 'Together'],
      ignore: ['OpenAI'],
      allow_fallbacks: true,
      data_collection: 'deny',
    });
    expect(readOpenRouterPreferences()).toEqual({
      order: ['DeepInfra', 'Together'],
      ignore: ['OpenAI'],
      allow_fallbacks: true,
      data_collection: 'deny',
    });
  });

  it('strips empty arrays so OpenRouter doesn\'t see "use nothing"', () => {
    configStore.set('openrouterPreferences', { order: [], ignore: ['X'] });
    expect(readOpenRouterPreferences()).toEqual({ ignore: ['X'] });
  });

  it('returns null when stored object has only empty arrays', () => {
    configStore.set('openrouterPreferences', { order: [], ignore: [] });
    expect(readOpenRouterPreferences()).toBeNull();
  });

  it('ignores unknown / malformed fields', () => {
    configStore.set('openrouterPreferences', {
      order: 'not-an-array',
      data_collection: 'maybe',  // invalid value
      foo: 'bar',
    });
    expect(readOpenRouterPreferences()).toBeNull();
  });
});

describe('writeOpenRouterPreferences', () => {
  it('stores prefs', () => {
    writeOpenRouterPreferences({ order: ['DeepInfra'], allow_fallbacks: false });
    expect(configStore.get('openrouterPreferences')).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
  });

  it('clears prefs when called with null', () => {
    configStore.set('openrouterPreferences', { order: ['X'] });
    writeOpenRouterPreferences(null);
    expect(configStore.has('openrouterPreferences')).toBe(false);
  });
});

describe('formatOpenRouterPreferences', () => {
  it('renders setup guide when no prefs', () => {
    const md = formatOpenRouterPreferences(null);
    expect(md).toMatch(/No routing preferences set/);
    expect(md).toMatch(/\/openrouter prefer/);
  });

  it('renders configured prefs', () => {
    const md = formatOpenRouterPreferences({
      order: ['DeepInfra', 'Together'],
      ignore: ['OpenAI'],
      allow_fallbacks: false,
      data_collection: 'deny',
    });
    expect(md).toMatch(/Prefer.*DeepInfra.*Together/);
    expect(md).toMatch(/Ignore.*OpenAI/);
    expect(md).toMatch(/Fallbacks.*disabled/);
    expect(md).toMatch(/Data collection.*deny/);
  });
});
