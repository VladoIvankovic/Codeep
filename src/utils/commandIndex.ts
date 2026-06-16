/**
 * Curated, agent-facing index of the most useful Codeep slash-commands.
 *
 * Injected into the agent's system prompt (see `getAgentSystemPrompt`) so the
 * model knows these exist and can point the user at the right one. Deliberately
 * a CURATED subset — not the full ~60-command registry in
 * `renderer/commands.ts` — to keep the prompt small; every entry here must be
 * a real command. Single source for this list so it doesn't drift across the
 * places that describe Codeep to the model.
 */
export const COMMAND_INDEX: { cmd: string; desc: string }[] = [
  { cmd: '/scan', desc: 'analyze the project (structure, frameworks, conventions) into .codeep/intelligence.json' },
  { cmd: '/plan', desc: 'plan a task before executing it (plan mode)' },
  { cmd: '/skills', desc: 'browse, add, or run reusable skill bundles' },
  { cmd: '/mcp', desc: 'connect external tools & data via MCP servers (Postgres, GitHub, a browser, the iOS simulator…)' },
  { cmd: '/agents', desc: 'manage sub-agents you can delegate focused subtasks to' },
  { cmd: '/personality', desc: 'switch the agent persona / working style' },
  { cmd: '/review', desc: 'code-review the current changes' },
  { cmd: '/commit', desc: 'write a commit message from the current diff' },
  { cmd: '/pr', desc: 'open a pull request' },
  { cmd: '/checkpoint', desc: 'save a restore point (/rewind rolls back to it)' },
  { cmd: '/memory', desc: 'add or list project memory notes the agent remembers' },
  { cmd: '/cost', desc: 'show token usage and estimated cost for the session' },
  { cmd: '/settings', desc: 'change models, providers, confirmation policy, and limits' },
];

/** Render the index as Markdown bullets for the system prompt. */
export function formatCommandIndex(): string {
  return COMMAND_INDEX.map(c => `- \`${c.cmd}\` — ${c.desc}`).join('\n');
}
