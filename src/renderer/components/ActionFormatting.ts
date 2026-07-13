/**
 * Action display helpers for the agent progress panel.
 *
 * Pure functions extracted from `App.ts` so they can be unit-tested in
 * isolation. `getActionColor` / `getActionLabel` map an action `type`
 * (read/write/edit/delete/command/...) to its colour and present-tense
 * label; `formatActionTarget` shortens a file path to fit a column.
 */
import { fg } from '../ansi';

/**
 * Colour per action kind. Falls back to plain white for unknown kinds so
 * a new tool type degrades gracefully (visible, just uncoloured) instead
 * of throwing.
 */
export function getActionColor(type: string): string {
  const colors: Record<string, string> = {
    'read': fg.blue,
    'write': fg.green,
    'edit': fg.yellow,
    'delete': fg.red,
    'command': fg.magenta,
    'search': fg.cyan,
    'list': fg.white,
    'mkdir': fg.blue,
    'fetch': fg.cyan,
  };
  return colors[type] || fg.white;
}

/**
 * Shorten a file path for single-line display. Paths with 3+ segments
 * keep their last two (parent dir + filename); longer paths get a leading
 * `...`. The result is capped to `maxLen`, truncating from the left.
 */
export function formatActionTarget(target: string, maxLen: number): string {
  if (target.includes('/')) {
    const parts = target.split('/');
    const filename = parts[parts.length - 1];
    if (parts.length > 2) {
      const short = `.../${parts[parts.length - 2]}/${filename}`;
      if (short.length <= maxLen) return short;
      // Still too long: keep the filename and RE-ADD the `...` marker —
      // a bare slice from the right would cut the marker mid-way and the
      // result would no longer signal that it was truncated.
      return '...' + short.slice(-(maxLen - 3));
    }
  }
  return target.length > maxLen ? '...' + target.slice(-(maxLen - 3)) : target;
}

/**
 * Present-tense label for an action kind. Falls back to the raw `type`
 * for unknown kinds.
 */
export function getActionLabel(type: string): string {
  const labels: Record<string, string> = {
    'read': 'Reading',
    'write': 'Creating',
    'edit': 'Editing',
    'delete': 'Deleting',
    'command': 'Running',
    'search': 'Searching',
    'list': 'Listing',
    'mkdir': 'Creating dir',
    'fetch': 'Fetching',
  };
  return labels[type] || type;
}
