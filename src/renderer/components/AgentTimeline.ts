import { charWidth, stringWidth } from '../ansi';

export type TimelineStageId = 'PLAN' | 'READ' | 'EDIT' | 'VERIFY' | 'SUMMARY';
export type TimelineStageStatus = 'done' | 'active' | 'pending';

export interface TimelineAction {
  type: string;
  target: string;
  result: string;
}

export interface TimelineStage {
  id: TimelineStageId;
  status: TimelineStageStatus;
  summary: string;
  detail: string;
}

export interface TimelineFile {
  type: 'write' | 'edit' | 'delete' | 'mkdir';
  target: string;
  result: string;
}

export interface TimelineCheck {
  target: string;
  result: string;
}

export interface AgentTimelineModel {
  currentStage: TimelineStageId;
  currentTarget: string;
  stages: TimelineStage[];
  files: TimelineFile[];
  checks: TimelineCheck[];
  progress: number;
}

const READ_TYPES = new Set(['read', 'search', 'list', 'fetch']);
const EDIT_TYPES = new Set(['write', 'edit', 'delete', 'mkdir']);

function stageForAction(type: string): TimelineStageId | null {
  if (READ_TYPES.has(type)) return 'READ';
  if (EDIT_TYPES.has(type)) return 'EDIT';
  if (type === 'command') return 'VERIFY';
  return null;
}

function parseThinking(thinking: string): { type: string; target: string } {
  const separator = thinking.indexOf(':');
  if (separator < 0) return { type: '', target: '' };
  const type = thinking.slice(0, separator).trim().toLowerCase();
  const knownType = READ_TYPES.has(type) || EDIT_TYPES.has(type) || type === 'command';
  if (!knownType) return { type: '', target: '' };
  return {
    type,
    target: thinking.slice(separator + 1).trim(),
  };
}

function uniqueByTarget<T extends { target: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item.target || seen.has(item.target)) continue;
    seen.add(item.target);
    result.unshift(item);
  }
  return result;
}

export function buildAgentTimelineModel(args: {
  actions: TimelineAction[];
  thinking: string;
  waitingForAI: boolean;
  iteration: number;
  maxIterations: number;
}): AgentTimelineModel {
  const thinking = parseThinking(args.thinking);
  const lastAction = args.actions[args.actions.length - 1];
  const explicitStage = !args.waitingForAI ? stageForAction(thinking.type) : null;
  const lastStage = lastAction ? stageForAction(lastAction.type) : null;
  const currentStage = explicitStage
    ?? lastStage
    ?? 'PLAN';
  const currentTarget = explicitStage
    ? thinking.target
    : (lastAction?.target || thinking.target);

  const readActions = args.actions.filter(action => READ_TYPES.has(action.type));
  const fileActions = args.actions.filter(
    (action): action is TimelineAction & { type: TimelineFile['type'] } =>
      EDIT_TYPES.has(action.type),
  );
  const commandActions = args.actions.filter(action => action.type === 'command');

  const stageStatus = (
    id: TimelineStageId,
    hasCompletedAction: boolean,
  ): TimelineStageStatus => {
    if (id === currentStage) return 'active';
    if (id === 'PLAN' && (args.iteration > 0 || args.actions.length > 0)) return 'done';
    if (hasCompletedAction) return 'done';
    return 'pending';
  };

  const stages: TimelineStage[] = [
    {
      id: 'PLAN',
      status: stageStatus('PLAN', args.iteration > 0),
      summary: 'Understand the request and choose the next safe step',
      detail: args.iteration > 0 ? `${args.iteration} model step${args.iteration === 1 ? '' : 's'}` : 'Building execution plan',
    },
    {
      id: 'READ',
      status: stageStatus('READ', readActions.length > 0),
      summary: 'Inspect project context and relevant files',
      detail: readActions.length > 0
        ? `${readActions.length} read/search action${readActions.length === 1 ? '' : 's'}`
        : 'Waiting for project inspection',
    },
    {
      id: 'EDIT',
      status: stageStatus('EDIT', fileActions.some(action => action.result === 'success')),
      summary: 'Apply focused changes to the workspace',
      detail: fileActions.length > 0
        ? `${uniqueByTarget(fileActions).length} file${uniqueByTarget(fileActions).length === 1 ? '' : 's'} touched`
        : 'No file changes yet',
    },
    {
      id: 'VERIFY',
      status: stageStatus('VERIFY', commandActions.some(action => action.result === 'success')),
      summary: 'Run commands and confirm the result',
      detail: commandActions.length > 0
        ? `${commandActions.length} command${commandActions.length === 1 ? '' : 's'} run`
        : 'Checks pending',
    },
    {
      id: 'SUMMARY',
      status: 'pending',
      summary: 'Summarize changes and next steps',
      detail: 'Appears when the run completes',
    },
  ];

  return {
    currentStage,
    currentTarget,
    stages,
    files: uniqueByTarget(fileActions) as TimelineFile[],
    checks: commandActions.slice(-4).map(action => ({
      target: action.target,
      result: action.result,
    })),
    progress: args.maxIterations > 0
      ? Math.min(Math.max(args.iteration / args.maxIterations, 0), 1)
      : 0,
  };
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Truncate to a column budget, not a code-unit budget: Screen.write advances
 * by charWidth, so a CJK/emoji prompt measured with String.length would draw
 * up to twice as wide as the pane it was sized for.
 */
export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (stringWidth(value) <= maxLength) return value;
  if (maxLength <= 3) return '.'.repeat(maxLength);
  const chars = [...value];
  const leftBudget = Math.ceil((maxLength - 1) / 2);
  const rightBudget = Math.floor((maxLength - 1) / 2);

  let head = '';
  let headWidth = 0;
  for (const char of chars) {
    const w = charWidth(char);
    if (headWidth + w > leftBudget) break;
    head += char;
    headWidth += w;
  }

  let tail = '';
  let tailWidth = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    const w = charWidth(chars[index]);
    if (tailWidth + w > rightBudget) break;
    tail = chars[index] + tail;
    tailWidth += w;
  }

  return `${head}…${tail}`;
}
