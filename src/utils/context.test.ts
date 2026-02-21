import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync,
        mockReaddirSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReaddirSync: vi.fn(() => [] as string[]),
  mockUnlinkSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    readdirSync: mockReaddirSync,
    unlinkSync: mockUnlinkSync,
  };
});

vi.mock('../config/index', () => ({ Message: {} }));
vi.mock('./logger', () => ({ logger: { error: vi.fn(), debug: vi.fn() } }));

import {
  saveContext,
  loadContext,
  clearContext,
  getAllContexts,
  summarizeContext,
  mergeContext,
  formatContextInfo,
  clearAllContexts,
  ConversationContext,
} from './context';

const PROJECT_PATH = '/home/user/myproject';
const SAMPLE_MESSAGES = [
  { role: 'user' as const, content: 'Hello' },
  { role: 'assistant' as const, content: 'Hi there' },
];

function makeContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    id: 'abc123',
    projectPath: PROJECT_PATH,
    projectName: 'myproject',
    createdAt: 1000,
    updatedAt: 2000,
    messages: SAMPLE_MESSAGES,
    ...overrides,
  };
}

describe('loadContext', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null when context file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadContext(PROJECT_PATH);
    expect(result).toBeNull();
  });

  it('parses and returns context from file', () => {
    const ctx = makeContext();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(ctx));
    const result = loadContext(PROJECT_PATH);
    expect(result).toMatchObject({ projectPath: PROJECT_PATH, projectName: 'myproject' });
  });

  it('returns null on corrupt JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ corrupt json');
    const result = loadContext(PROJECT_PATH);
    expect(result).toBeNull();
  });

  it('returns null when readFileSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('perm denied'); });
    const result = loadContext(PROJECT_PATH);
    expect(result).toBeNull();
  });
});

describe('saveContext', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes context JSON to file', () => {
    mockExistsSync.mockReturnValue(false); // loadContext → no existing file
    mockReaddirSync.mockReturnValue([]);
    saveContext(PROJECT_PATH, SAMPLE_MESSAGES);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.projectPath).toBe(PROJECT_PATH);
    expect(parsed.messages).toHaveLength(2);
  });

  it('preserves createdAt from existing context', () => {
    const existing = makeContext({ createdAt: 999 });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));
    saveContext(PROJECT_PATH, SAMPLE_MESSAGES);
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.createdAt).toBe(999);
  });

  it('saves optional summary', () => {
    mockExistsSync.mockReturnValue(false);
    saveContext(PROJECT_PATH, SAMPLE_MESSAGES, 'Old conversation about X');
    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.summary).toBe('Old conversation about X');
  });

  it('returns true on success', () => {
    mockExistsSync.mockReturnValue(false);
    const result = saveContext(PROJECT_PATH, SAMPLE_MESSAGES);
    expect(result).toBe(true);
  });

  it('returns false when write fails', () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => { throw new Error('disk full'); });
    const result = saveContext(PROJECT_PATH, SAMPLE_MESSAGES);
    expect(result).toBe(false);
  });
});

describe('clearContext', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes context file when it exists', () => {
    mockExistsSync.mockReturnValue(true);
    clearContext(PROJECT_PATH);
    expect(mockUnlinkSync).toHaveBeenCalledOnce();
  });

  it('does not call unlinkSync when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    clearContext(PROJECT_PATH);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('returns true on success', () => {
    mockExistsSync.mockReturnValue(false);
    expect(clearContext(PROJECT_PATH)).toBe(true);
  });

  it('returns false when unlink throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => { throw new Error('perm'); });
    expect(clearContext(PROJECT_PATH)).toBe(false);
  });
});

describe('getAllContexts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty array when no context files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    expect(getAllContexts()).toEqual([]);
  });

  it('returns parsed contexts sorted by updatedAt desc', () => {
    const old = makeContext({ updatedAt: 1000, projectName: 'old' });
    const newer = makeContext({ updatedAt: 5000, projectName: 'newer' });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['a.json', 'b.json']);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(old))
      .mockReturnValueOnce(JSON.stringify(newer));
    const result = getAllContexts();
    expect(result[0].projectName).toBe('newer');
    expect(result[1].projectName).toBe('old');
  });

  it('skips non-.json files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['file.txt', 'ctx.json']);
    const ctx = makeContext();
    mockReadFileSync.mockReturnValue(JSON.stringify(ctx));
    const result = getAllContexts();
    expect(result).toHaveLength(1);
  });

  it('skips corrupt context files silently', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['bad.json', 'good.json']);
    mockReadFileSync
      .mockReturnValueOnce('{ bad json')
      .mockReturnValueOnce(JSON.stringify(makeContext()));
    const result = getAllContexts();
    expect(result).toHaveLength(1);
  });
});

describe('summarizeContext', () => {
  it('returns messages unchanged when under limit', () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    const result = summarizeContext(msgs, 20);
    expect(result.messages).toEqual(msgs);
    expect(result.summary).toBeUndefined();
  });

  it('keeps most recent messages and summarizes older ones', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i + 1}`,
    }));
    const result = summarizeContext(msgs, 10);
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0].content).toBe('Message 21');
    expect(result.summary).toContain('Previous conversation summary');
  });

  it('includes user messages in summary', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({
      role: 'user' as const,
      content: `User question ${i + 1}`,
    }));
    const result = summarizeContext(msgs, 20);
    expect(result.summary).toContain('User:');
  });

  it('notes file changes in assistant messages that are in the old section', () => {
    // Need 25 messages total so that the first 5 go to summary, including the assistant at index 0
    const msgs = [
      { role: 'assistant' as const, content: 'I created and modified the files' },
      ...Array.from({ length: 24 }, () => ({ role: 'user' as const, content: 'hi' })),
    ];
    const result = summarizeContext(msgs, 20);
    expect(result.summary).toContain('Made file changes');
  });
});

describe('mergeContext', () => {
  it('returns current messages when loaded context is null', () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    expect(mergeContext(null, msgs)).toEqual(msgs);
  });

  it('prepends loaded messages before current messages', () => {
    const loaded = makeContext({ messages: [{ role: 'user', content: 'old' }] });
    const current = [{ role: 'user' as const, content: 'new' }];
    const result = mergeContext(loaded, current);
    expect(result[0].content).toBe('old');
    expect(result[result.length - 1].content).toBe('new');
  });

  it('inserts summary context message when summary exists', () => {
    const loaded = makeContext({ summary: 'Old summary', messages: [] });
    const current = [{ role: 'user' as const, content: 'continue' }];
    const result = mergeContext(loaded, current);
    expect(result[0].content).toContain('Old summary');
    expect(result[0].content).toContain('[Context from previous session]');
  });
});

describe('formatContextInfo', () => {
  it('includes project name and message count', () => {
    const ctx = makeContext({ messages: SAMPLE_MESSAGES });
    const result = formatContextInfo(ctx);
    expect(result).toContain('myproject');
    expect(result).toContain('2');
  });

  it('mentions summary when present', () => {
    const ctx = makeContext({ summary: 'Old stuff' });
    const result = formatContextInfo(ctx);
    expect(result).toContain('summary');
  });

  it('does not mention summary when absent', () => {
    const ctx = makeContext({ summary: undefined });
    const result = formatContextInfo(ctx);
    expect(result).not.toContain('summary');
  });
});

describe('clearAllContexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(true);
  });

  it('calls unlinkSync for each .json file', () => {
    mockReaddirSync.mockReturnValue(['a.json', 'b.json', 'note.txt']);
    clearAllContexts();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when no files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    expect(clearAllContexts()).toBe(0);
  });

  it('skips files that fail to delete', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['a.json', 'b.json']);
    mockUnlinkSync
      .mockImplementationOnce(() => { throw new Error('perm'); })
      .mockImplementationOnce(() => undefined);
    const result = clearAllContexts();
    expect(result).toBe(1);
  });
});
