import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config/index';
import type { DesktopNotifier } from '../utils/desktopNotify';
import {
  desktopNotificationsEnabled,
  desktopNotificationsOffered,
  runEnded,
  runStarted,
  setDesktopNotifier,
  waiting,
} from './desktopAttention';
import { startOmarchyLiveStatus, type LiveStatusHandle } from './omarchyStatus';

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeep-attention-'));
  stateDir = join(root, 'omarchy', 'current');
  config.delete('desktopNotifications');
});

afterEach(() => {
  config.delete('desktopNotifications');
  setDesktopNotifier(null);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const omarchy = () => mkdirSync(stateDir, { recursive: true });

describe('whether toasts are wanted', () => {
  it('is off anywhere but Linux, whatever was set', () => {
    omarchy();
    for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
      expect(desktopNotificationsEnabled({ platform, stateDir, setting: true }), platform).toBe(false);
      expect(desktopNotificationsEnabled({ platform, stateDir }), platform).toBe(false);
    }
  });

  it('is what the user said, when they said it — an explicit Off wins on Omarchy', () => {
    omarchy();
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir, setting: false })).toBe(false);
    // And an explicit On is On on a Linux that is not Omarchy.
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir: join(root, 'none'), setting: true })).toBe(true);
  });

  it('follows the machine when it was not said: on for Omarchy, off elsewhere', () => {
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir, setting: undefined })).toBe(false);
    omarchy();
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir, setting: undefined })).toBe(true);
    // Not remembered: it is decided at each call.
    rmSync(stateDir, { recursive: true });
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir, setting: undefined })).toBe(false);
  });

  it('takes a setting that is not a boolean for not set', () => {
    omarchy();
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir, setting: 'yes' })).toBe(true);
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir: join(root, 'none'), setting: 'no' })).toBe(false);
  });

  it('reads the config when it is not handed the setting', () => {
    omarchy();
    expect(config.get('desktopNotifications')).toBeUndefined();
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir })).toBe(true);
    config.set('desktopNotifications', false);
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir })).toBe(false);
    config.set('desktopNotifications', true);
    expect(desktopNotificationsEnabled({ platform: 'linux', stateDir: join(root, 'none') })).toBe(true);
  });

  it('is not set by the defaults, which would make "auto" impossible', async () => {
    // A config that has never been written to: what a new install starts on.
    const dir = mkdtempSync(join(tmpdir(), 'codeep-fresh-config-'));
    const saved = process.env.CODEEP_CONFIG_DIR;
    process.env.CODEEP_CONFIG_DIR = dir;
    try {
      vi.resetModules();
      const fresh = await import('../config/index');
      expect(fresh.config.has('desktopNotifications')).toBe(false);
      expect(fresh.config.get('desktopNotifications')).toBeUndefined();
      // And the live status row's setting is On from the start.
      expect(fresh.config.get('omarchyLiveStatus')).toBe(true);
    } finally {
      process.env.CODEEP_CONFIG_DIR = saved;
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('whether /settings offers the switch', () => {
  it.skipIf(process.platform === 'win32')('is Linux with notify-send on PATH, and nothing else', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'notify-send'), '#!/bin/sh\n');
    chmodSync(join(bin, 'notify-send'), 0o755);
    expect(desktopNotificationsOffered({ platform: 'linux', env: { PATH: bin } })).toBe(true);
    expect(desktopNotificationsOffered({ platform: 'linux', env: { PATH: join(root, 'empty') } })).toBe(false);
    expect(desktopNotificationsOffered({ platform: 'darwin', env: { PATH: bin } })).toBe(false);
    expect(desktopNotificationsOffered({ platform: 'win32', env: { PATH: bin } })).toBe(false);
  });
});

describe('what the run tells the desktop', () => {
  let notifier: { [K in keyof DesktopNotifier]: ReturnType<typeof vi.fn> };
  let ends: Array<ReturnType<typeof vi.fn>>;
  let status: LiveStatusHandle | null = null;
  const file = () => join(root, 'sessions', '31337.json');
  const state = () => {
    const { state, task } = JSON.parse(readFileSync(file(), 'utf8')) as { state: string; task: string | null };
    return { state, task };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    omarchy();
    ends = [];
    notifier = {
      runEnded: vi.fn(),
      waiting: vi.fn(() => {
        const end = vi.fn();
        ends.push(end);
        return end;
      }),
    };
    setDesktopNotifier(notifier as unknown as DesktopNotifier);
    status = startOmarchyLiveStatus({
      kind: 'tui', platform: 'linux', stateDir, dir: join(root, 'sessions'), pid: 31337,
      isAlive: () => true, startedAtOf: () => null,
    });
  });

  afterEach(() => {
    status?.stop();
    status = null;
  });

  it('is working from the moment a run starts, with the task\'s label', () => {
    runStarted('fix the login bug in src/auth/login.ts');
    vi.advanceTimersByTime(1000);
    expect(state()).toEqual({ state: 'working', task: 'fix the login bug in' });
  });

  it('hands the end of a run to the notifier, and is idle', () => {
    runStarted('fix bug');
    runEnded({ task: 'fix bug', finished: true, elapsedMs: 45_000 });
    expect(notifier.runEnded).toHaveBeenCalledWith({ task: 'fix bug', finished: true, elapsedMs: 45_000 });
    vi.advanceTimersByTime(1000);
    expect(state()).toEqual({ state: 'idle', task: null });
  });

  it('is waiting for an approval until it is answered, and then working again', () => {
    runStarted('fix bug');
    const answered = waiting('approval', { task: 'fix bug', tool: 'write_file' });
    expect(notifier.waiting).toHaveBeenCalledWith('approval', { task: 'fix bug', tool: 'write_file' });
    vi.advanceTimersByTime(1000);
    expect(state()).toEqual({ state: 'approval', task: 'fix bug' });
    answered();
    expect(ends[0]).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(state()).toEqual({ state: 'working', task: 'fix bug' });
    // Once.
    answered();
    expect(ends[0]).toHaveBeenCalledTimes(1);
  });

  it('is waiting for an answer to a question until it comes, and then idle', () => {
    const answered = waiting('question', { task: 'fix bug' });
    vi.advanceTimersByTime(1000);
    expect(state()).toEqual({ state: 'question', task: 'fix bug' });
    answered();
    vi.advanceTimersByTime(1000);
    expect(state()).toEqual({ state: 'idle', task: null });
  });

  it('is not put back to working by an answer that comes after the run has ended', () => {
    runStarted('fix bug');
    const answered = waiting('approval', { task: 'fix bug', tool: 'write_file' });
    vi.advanceTimersByTime(1000);
    runEnded({ task: 'fix bug', finished: false, elapsedMs: 5_000 });
    vi.advanceTimersByTime(1000);
    expect(state().state).toBe('idle');
    answered();
    vi.advanceTimersByTime(1000);
    expect(state().state).toBe('idle');
  });

  it('never throws into the run, whatever the notifier does', () => {
    notifier.runEnded.mockImplementation(() => { throw new Error('boom'); });
    notifier.waiting.mockImplementation(() => { throw new Error('boom'); });
    expect(() => runStarted('a')).not.toThrow();
    expect(() => waiting('approval', { task: 'a', tool: 'x' })()).not.toThrow();
    expect(() => runEnded({ task: 'a', finished: true, elapsedMs: 1 })).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(state().state).toBe('idle');
  });
});
