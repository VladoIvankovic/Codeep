/**
 * The welcome block at the top of the chat: version, provider and model,
 * what Codeep may do in this folder, and the workspace's own notices.
 *
 * Built from the state it describes, and built again when that changes. It
 * used to be written once, before the startup questions were answered, so
 * after "Set as Project? → Yes" and "Folder Access → Read & Write" it still
 * said "Chat only · no project context". WelcomeFormatter colours it.
 */

export interface WelcomeState {
  version: string;
  providerName: string | undefined;
  model: string;
  projectPath: string;
  /** A project context is loaded (access was granted). */
  hasProjectContext: boolean;
  hasWriteAccess: boolean;
  /** Folder Access has been asked and not answered yet. */
  accessPending: boolean;
  agentMode: string;
  yolo: boolean;
  accountLinked: boolean;
  /** Workspace notices (custom commands, hooks, skill bundles), each a block of lines. */
  notices: string[][];
}

export function welcomeContent(state: WelcomeState): string {
  const lines: string[] = [`Codeep v${state.version}  ·  ${state.providerName}  ·  ${state.model}`, ''];
  if (state.accessPending) {
    lines.push(`  Project  ${state.projectPath}`);
    lines.push('  Mode     Waiting for folder access  ·  answer below');
  } else if (state.hasProjectContext) {
    lines.push(`  Project  ${state.projectPath}`);
    lines.push(state.hasWriteAccess
      ? '  Access   Read & Write  ·  Agent enabled'
      : '  Access   Read Only  ·  /grant to enable Agent');
  } else {
    lines.push('  Mode     Chat only  ·  no project context');
  }
  if (state.agentMode === 'on' && state.hasWriteAccess && !state.accessPending) {
    lines.push('');
    lines.push('  ⚠  Agent Mode ON  —  messages auto-execute as agent tasks');
  }
  if (state.yolo) {
    lines.push('');
    lines.push('  ⚠  YOLO  —  agent actions run without asking, for this launch only');
  }
  lines.push('');
  lines.push(state.accountLinked
    ? '  Account  codeep.dev linked'
    : '  Account  not linked  ·  run: codeep account');
  for (const notice of state.notices) {
    lines.push('');
    lines.push(...notice);
  }
  lines.push('');
  lines.push('  /help  ·  Ctrl+L clear  ·  Esc cancel');
  return lines.join('\n');
}
