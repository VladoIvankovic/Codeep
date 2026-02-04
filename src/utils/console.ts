/**
 * Console output utilities using chalk and ora
 * Used for agent streaming to avoid Ink re-rendering issues
 */

import chalk from 'chalk';
import ora, { Ora } from 'ora';

// Brand color
const brandRed = chalk.hex('#f02a30');

// Current spinner instance
let currentSpinner: Ora | null = null;

/**
 * Start agent spinner
 */
export function startAgentSpinner(text: string = 'Agent working...', dryRun: boolean = false): void {
  stopSpinner();
  const prefix = dryRun ? chalk.yellow('[DRY RUN]') : brandRed('[AGENT]');
  currentSpinner = ora({
    text: `${prefix} ${text}`,
    color: dryRun ? 'yellow' : 'red',
  }).start();
}

/**
 * Update spinner text
 */
export function updateSpinner(text: string, dryRun: boolean = false): void {
  if (currentSpinner) {
    const prefix = dryRun ? chalk.yellow('[DRY RUN]') : brandRed('[AGENT]');
    currentSpinner.text = `${prefix} ${text}`;
  }
}

/**
 * Stop spinner with success
 */
export function spinnerSuccess(text?: string): void {
  if (currentSpinner) {
    currentSpinner.succeed(text);
    currentSpinner = null;
  }
}

/**
 * Stop spinner with failure
 */
export function spinnerFail(text?: string): void {
  if (currentSpinner) {
    currentSpinner.fail(text);
    currentSpinner = null;
  }
}

/**
 * Stop spinner without status
 */
export function stopSpinner(): void {
  if (currentSpinner) {
    // Use stopAndPersist with empty symbol to leave a clean line
    currentSpinner.stopAndPersist({ symbol: '' });
    currentSpinner = null;
  }
}

// Track if agent is running for auto-restart spinner
let agentRunning = false;
let lastDryRun = false;

/**
 * Set agent running state
 */
export function setAgentRunning(running: boolean, dryRun: boolean = false): void {
  agentRunning = running;
  lastDryRun = dryRun;
}

/**
 * Log agent action
 */
export function logAction(type: string, target: string, result: 'success' | 'error' | 'pending', details?: string): void {
  // Debug - write to file since Ink captures stdout/stderr
  const fs = require('fs');
  fs.appendFileSync('/tmp/codeep-debug.log', `[${new Date().toISOString()}] logAction called: ${type} ${target} ${result}\n`);
  
  stopSpinner(); // Stop spinner before logging
  
  const filename = target.split('/').pop() || target;
  const lineCount = details ? details.split('\n').length : 0;
  
  let icon: string;
  let color: typeof chalk;
  let verb: string;
  
  switch (type) {
    case 'write':
      icon = result === 'success' ? '✓' : '✗';
      color = result === 'success' ? chalk.green : chalk.red;
      verb = 'Created';
      break;
    case 'edit':
      icon = result === 'success' ? '✓' : '✗';
      color = result === 'success' ? chalk.yellow : chalk.red;
      verb = 'Edited';
      break;
    case 'delete':
      icon = result === 'success' ? '✓' : '✗';
      color = result === 'success' ? chalk.red : chalk.red;
      verb = 'Deleted';
      break;
    case 'read':
      icon = '→';
      color = chalk.blue;
      verb = 'Reading';
      break;
    case 'search':
      icon = '→';
      color = chalk.cyan;
      verb = 'Searching';
      break;
    case 'command':
      icon = result === 'success' ? '✓' : '✗';
      color = result === 'success' ? chalk.magenta : chalk.red;
      verb = 'Ran';
      break;
    case 'mkdir':
      icon = result === 'success' ? '✓' : '✗';
      color = result === 'success' ? chalk.blue : chalk.red;
      verb = 'Created dir';
      break;
    case 'fetch':
      icon = '→';
      color = chalk.cyan;
      verb = 'Fetching';
      break;
    case 'list':
      icon = '→';
      color = chalk.gray;
      verb = 'Listing';
      break;
    default:
      icon = '◦';
      color = chalk.white;
      verb = type;
  }
  
  // Format line count for write/edit
  const lineInfo = (type === 'write' || type === 'edit') && lineCount > 0 
    ? chalk.gray(` (${lineCount} lines)`) 
    : '';
  
  // Format command differently
  const displayTarget = type === 'command' 
    ? chalk.gray(`\`${filename.length > 40 ? filename.slice(0, 40) + '...' : filename}\``)
    : chalk.bold(filename);
  
  console.log(`${color(icon)} ${verb} ${displayTarget}${lineInfo}`);
  
  // Restart spinner if agent is still running
  if (agentRunning) {
    startAgentSpinner('Working...', lastDryRun);
  }
}

/**
 * Log agent step change
 */
export function logStep(step: number, actionsCount: number, dryRun: boolean = false): void {
  const prefix = dryRun ? chalk.yellow('[DRY RUN]') : brandRed('[AGENT]');
  console.log(`${prefix} Step ${chalk.cyan(step)} | ${actionsCount} actions`);
}

/**
 * Log agent completion
 */
export function logAgentComplete(stats: {
  iterations: number;
  created: number;
  edited: number;
  deleted: number;
  commands: number;
  errors: number;
}, success: boolean = true): void {
  stopSpinner();
  
  console.log(''); // Empty line
  
  const statParts: string[] = [];
  if (stats.created > 0) statParts.push(chalk.green(`+${stats.created} created`));
  if (stats.edited > 0) statParts.push(chalk.yellow(`~${stats.edited} edited`));
  if (stats.deleted > 0) statParts.push(chalk.red(`-${stats.deleted} deleted`));
  if (stats.commands > 0) statParts.push(chalk.magenta(`${stats.commands} commands`));
  if (stats.errors > 0) statParts.push(chalk.red(`${stats.errors} errors`));
  
  const statsLine = statParts.length > 0 ? statParts.join(chalk.gray(' | ')) : chalk.gray('no changes');
  
  if (success) {
    console.log(`${chalk.green('✓')} Agent completed: ${chalk.bold(stats.iterations)} steps | ${statsLine}`);
  } else {
    console.log(`${chalk.red('✗')} Agent failed: ${chalk.bold(stats.iterations)} steps | ${statsLine}`);
  }
  
  console.log(''); // Empty line
}

/**
 * Log separator line
 */
export function logSeparator(): void {
  console.log(brandRed('─'.repeat(60)));
}

/**
 * Log with brand color
 */
export function logBrand(text: string): void {
  console.log(brandRed(text));
}
