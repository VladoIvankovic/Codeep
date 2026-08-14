import { App } from '../src/renderer/App';

const previewProjectPath = process.cwd();

const app = new App({
  onSubmit: async () => {},
  onCommand: () => {},
  onExit: () => process.exit(0),
  onStopAgent: () => process.exit(0),
  getStatus: () => ({
    version: '2.16.0',
    provider: 'OpenAI',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'high',
    agentMode: 'on',
    projectPath: previewProjectPath,
    branch: 'codex/tui-agent-timeline',
    hasWriteAccess: true,
    sessionId: '7c2f19a4-redesign',
    messageCount: 2,
    tokenStats: {
      totalTokens: 48_720,
      promptTokens: 37_140,
      completionTokens: 11_580,
      requestCount: 9,
      estimatedCost: 0.2846,
    },
  }),
});

app.start();
app.setMessages([
  {
    role: 'welcome',
    content: `Codeep is ready in ${previewProjectPath}`,
  },
  {
    role: 'user',
    content: 'Redesign the TUI around an agent timeline with clear file changes, checks, and session impact.',
  },
]);

app.setAgentRunning(true);
app.setAgentMaxIterations(8);
app.updateAgentProgress(1, {
  type: 'search',
  target: 'src/renderer/**/*.ts',
  result: 'success',
});
app.updateAgentProgress(2, {
  type: 'read',
  target: 'src/renderer/App.ts',
  result: 'success',
});
app.updateAgentProgress(3, {
  type: 'edit',
  target: 'src/renderer/components/AgentTimeline.ts',
  result: 'success',
});
app.updateAgentProgress(4, {
  type: 'edit',
  target: 'src/renderer/App.ts',
  result: 'success',
});
app.updateAgentProgress(5, {
  type: 'write',
  target: 'src/renderer/components/AgentTimeline.test.ts',
  result: 'success',
});
app.updateAgentProgress(6, {
  type: 'command',
  target: 'npm test -- AgentTimeline.test.ts',
  result: 'success',
});
app.setAgentThinking('edit: src/renderer/App.ts');
app.setAgentWaitingForAI(false);
app.addAgentLog('✓ Read src/renderer/App.ts');
app.addAgentLog('✓ Edit src/renderer/components/AgentTimeline.ts');
app.addAgentLog('✓ Edit src/renderer/App.ts');
app.addAgentLog('✓ Write src/renderer/components/AgentTimeline.test.ts');
app.addAgentLog('◆ Edit src/renderer/App.ts');

app.render();

process.on('SIGINT', () => {
  app.stop();
  process.exit(0);
});
