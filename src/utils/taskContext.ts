import type { CloudTask } from './codeepCloud';

let pendingTasks: CloudTask[] = [];

export function setTaskContext(tasks: CloudTask[]): void {
  pendingTasks = tasks;
}

export function clearTaskContext(): void {
  pendingTasks = [];
}

export function getTaskContextPrompt(): string {
  if (pendingTasks.length === 0) return '';
  const lines = ['\n\n## Pending Tasks (from codeep.dev dashboard)'];
  for (const t of pendingTasks) {
    const badge = t.type ? `[${t.type}]` : '[task]';
    lines.push(`- ${badge} ${t.title}${t.description ? ': ' + t.description : ''}${t.project_name ? ` (project: ${t.project_name})` : ''}`);
  }
  lines.push('\nWork on these tasks when the user asks.');
  return lines.join('\n');
}
