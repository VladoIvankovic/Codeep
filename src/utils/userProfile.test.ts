import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs so we control which profile files "exist" and what they contain.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// In-memory config so we can flip `userProfile` / `autoLearnProfile` on/off.
vi.mock('../config/index.js', () => {
  const data: Record<string, unknown> = {};
  return {
    config: {
      get: (k: string) => data[k],
      set: (k: string, v: unknown) => { data[k] = v; },
    },
  };
});

// Mock the LLM call used by the auto-learn pass.
vi.mock('../api/index.js', () => ({ chat: vi.fn() }));

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import {
  loadUserProfilePrompt,
  getProfileStatus,
  scaffoldProfile,
  globalProfilePath,
  projectProfilePath,
  globalLearnedProfilePath,
  projectLearnedProfilePath,
  updateLearnedProfile,
  maybeLearnUserProfile,
  clearLearnedProfile,
} from './userProfile';
import { config } from '../config/index.js';
import { chat } from '../api/index.js';

const mockExists = existsSync as ReturnType<typeof vi.fn>;
const mockRead = readFileSync as ReturnType<typeof vi.fn>;
const mockWrite = writeFileSync as ReturnType<typeof vi.fn>;
const mockRm = rmSync as ReturnType<typeof vi.fn>;
const mockChat = chat as ReturnType<typeof vi.fn>;

const ROOT = '/my/project';

describe('userProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.set('userProfile', undefined); // undefined → enabled (only `false` disables)
  });

  it('returns empty string when no profile files exist', () => {
    mockExists.mockReturnValue(false);
    expect(loadUserProfilePrompt(ROOT)).toBe('');
  });

  it('injects the global profile under an "About the User" header', () => {
    mockExists.mockImplementation((p: string) => p === globalProfilePath());
    mockRead.mockReturnValue('Reply language: Croatian');
    const out = loadUserProfilePrompt(ROOT);
    expect(out).toContain('## About the User');
    expect(out).toContain('Reply language: Croatian');
  });

  it('includes both global and project profiles, global first, separated', () => {
    mockExists.mockImplementation((p: string) => p === globalProfilePath() || p === projectProfilePath(ROOT));
    mockRead.mockImplementation((p: string) => (p === globalProfilePath() ? 'GLOBAL_PREFS' : 'PROJECT_PREFS'));
    const out = loadUserProfilePrompt(ROOT);
    expect(out.indexOf('GLOBAL_PREFS')).toBeLessThan(out.indexOf('PROJECT_PREFS'));
    expect(out).toContain('---');
  });

  it('returns empty string when injection is disabled, even if files exist', () => {
    config.set('userProfile', false);
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('something');
    expect(loadUserProfilePrompt(ROOT)).toBe('');
  });

  it('trims surrounding whitespace from profile content', () => {
    mockExists.mockImplementation((p: string) => p === globalProfilePath());
    mockRead.mockReturnValue('\n\n  trimmed body  \n\n');
    const out = loadUserProfilePrompt();
    expect(out).toContain('trimmed body');
    expect(out).not.toContain('  trimmed body  ');
  });

  it('getProfileStatus reflects file existence and the enabled flag', () => {
    config.set('userProfile', false);
    mockExists.mockImplementation((p: string) => p === globalProfilePath());
    const st = getProfileStatus(ROOT);
    expect(st.enabled).toBe(false);
    expect(st.globalExists).toBe(true);
    expect(st.projectExists).toBe(false);
    expect(st.projectPath).toBe(projectProfilePath(ROOT));
  });

  it('scaffoldProfile never clobbers an existing file', () => {
    mockExists.mockReturnValue(true);
    expect(scaffoldProfile('global')).toEqual({ path: globalProfilePath(), created: false });
  });

  it('scaffoldProfile creates a template when missing', () => {
    mockExists.mockReturnValue(false);
    expect(scaffoldProfile('project', ROOT)).toEqual({ path: projectProfilePath(ROOT), created: true });
  });

  it('scaffoldProfile returns null for a project scope with no workspace root', () => {
    mockExists.mockReturnValue(false);
    expect(scaffoldProfile('project')).toBeNull();
  });
});

describe('userProfile — auto-learn (Phase 2)', () => {
  const HISTORY = [
    { role: 'user', content: 'Please always reply in Croatian.' },
    { role: 'assistant', content: 'Razumijem.' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    config.set('userProfile', undefined);
    config.set('autoLearnProfile', undefined);
  });

  it('updateLearnedProfile writes merged facts and reports updated', async () => {
    mockExists.mockReturnValue(false); // no existing learned file
    mockChat.mockResolvedValue('- Prefers replies in Croatian\n- Works in TypeScript');
    const res = await updateLearnedProfile(HISTORY);
    expect(res).toEqual({ updated: true, facts: '- Prefers replies in Croatian\n- Works in TypeScript' });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const written = mockWrite.mock.calls[0][1] as string;
    expect(written).toContain('What Codeep has learned about me');
    expect(written).toContain('- Prefers replies in Croatian');
  });

  it('updateLearnedProfile reports no change when facts match existing', async () => {
    mockExists.mockImplementation((p: string) => p === globalLearnedProfilePath());
    mockRead.mockReturnValue('# header\n\n- Prefers replies in Croatian');
    mockChat.mockResolvedValue('- Prefers replies in Croatian');
    const res = await updateLearnedProfile(HISTORY);
    expect(res).toEqual({ updated: false, facts: '- Prefers replies in Croatian' });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('updateLearnedProfile returns null for empty history (no LLM call)', async () => {
    expect(await updateLearnedProfile([])).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('updateLearnedProfile returns null when the model returns no bullets', async () => {
    mockExists.mockReturnValue(false);
    mockChat.mockResolvedValue('I could not find anything durable.');
    expect(await updateLearnedProfile(HISTORY)).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('loadUserProfilePrompt injects the learned profile', () => {
    mockExists.mockImplementation((p: string) => p === globalLearnedProfilePath());
    mockRead.mockReturnValue('# What Codeep has learned about me\n\n- Prefers Croatian');
    const out = loadUserProfilePrompt('/my/project');
    expect(out).toContain('## About the User');
    expect(out).toContain('Prefers Croatian');
  });

  it('clearLearnedProfile deletes the file when present', () => {
    mockExists.mockReturnValue(true);
    expect(clearLearnedProfile()).toBe(true);
    expect(mockRm).toHaveBeenCalledWith(globalLearnedProfilePath());
  });

  it('clearLearnedProfile returns false when there is nothing to clear', () => {
    mockExists.mockReturnValue(false);
    expect(clearLearnedProfile()).toBe(false);
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('maybeLearnUserProfile is a no-op when auto-learn is off', async () => {
    config.set('autoLearnProfile', false);
    const many = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await maybeLearnUserProfile('sess-off', many);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('maybeLearnUserProfile triggers learning when enabled with enough new messages', async () => {
    config.set('autoLearnProfile', true);
    mockExists.mockReturnValue(false);
    mockChat.mockResolvedValue('- Prefers Croatian');
    const many = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await maybeLearnUserProfile('sess-on-unique', many);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('maybeLearnUserProfile respects the message throttle', async () => {
    config.set('autoLearnProfile', true);
    await maybeLearnUserProfile('sess-throttle', HISTORY); // only 2 non-system msgs → below +6
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('updateLearnedProfile writes to the project file when scope=project', async () => {
    mockExists.mockReturnValue(false);
    mockChat.mockResolvedValue('- Deploys to a Hostinger VPS');
    const res = await updateLearnedProfile(HISTORY, 'project', '/my/project');
    expect(res?.updated).toBe(true);
    expect(mockWrite.mock.calls[0][0]).toBe(projectLearnedProfilePath('/my/project'));
    expect(mockWrite.mock.calls[0][1] as string).toContain('learned about this project');
  });

  it('updateLearnedProfile project scope is a no-op without a workspace root', async () => {
    expect(await updateLearnedProfile(HISTORY, 'project')).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('maybeLearnUserProfile learns both global and project when in a workspace', async () => {
    config.set('autoLearnProfile', true);
    mockExists.mockReturnValue(false);
    mockChat.mockResolvedValue('- Prefers Croatian');
    const many = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await maybeLearnUserProfile('sess-both-unique', many, '/my/project');
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('loadUserProfilePrompt injects the project learned profile', () => {
    mockExists.mockImplementation((p: string) => p === projectLearnedProfilePath('/my/project'));
    mockRead.mockReturnValue('# What Codeep has learned about this project\n\n- Hostinger VPS');
    const out = loadUserProfilePrompt('/my/project');
    expect(out).toContain('Hostinger VPS');
  });

  it('clearLearnedProfile removes both global and project files', () => {
    mockExists.mockReturnValue(true);
    expect(clearLearnedProfile('/my/project')).toBe(true);
    expect(mockRm).toHaveBeenCalledWith(globalLearnedProfilePath());
    expect(mockRm).toHaveBeenCalledWith(projectLearnedProfilePath('/my/project'));
  });
});
