import { describe, it, expect } from 'vitest';
import { welcomeContent, type WelcomeState } from './welcome';

const base: WelcomeState = {
  version: '3.9.1', providerName: 'Z.AI (ZhipuAI)', model: 'glm-5.3', projectPath: '/home/vi/Work',
  hasProjectContext: false, hasWriteAccess: false, accessPending: false, agentMode: 'on',
  yolo: false, accountLinked: false, notices: [],
};

describe('welcomeContent', () => {
  it('says chat only when no access was granted', () => {
    expect(welcomeContent(base)).toContain('  Mode     Chat only  ·  no project context');
  });

  it('claims no mode while Folder Access is still being asked', () => {
    const text = welcomeContent({ ...base, accessPending: true });
    expect(text).toContain('  Project  /home/vi/Work');
    expect(text).toContain('Waiting for folder access');
    expect(text).not.toContain('Chat only');
    expect(text).not.toContain('Access ');
  });

  it('shows read & write, with the Agent Mode warning that goes with it', () => {
    const text = welcomeContent({ ...base, hasProjectContext: true, hasWriteAccess: true });
    expect(text).toContain('  Access   Read & Write  ·  Agent enabled');
    expect(text).toContain('Agent Mode ON');
  });

  it('shows read only, without the Agent Mode warning', () => {
    const text = welcomeContent({ ...base, hasProjectContext: true });
    expect(text).toContain('  Access   Read Only  ·  /grant to enable Agent');
    expect(text).not.toContain('Agent Mode ON');
  });

  it('keeps the workspace notices, each after a blank line, before the shortcuts', () => {
    const text = welcomeContent({ ...base, notices: [['  ⚠  hooks'], ['  ℹ  bundles']] });
    expect(text.split('\n').slice(-6)).toEqual(['', '  ⚠  hooks', '', '  ℹ  bundles', '', '  /help  ·  Ctrl+L clear  ·  Esc cancel']);
  });
});
