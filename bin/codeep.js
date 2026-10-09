#!/usr/bin/env node
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { constants } from 'os';
import { isatty } from 'tty';

const __dirname = dirname(fileURLToPath(import.meta.url));
const main = join(__dirname, '..', 'dist', 'renderer', 'main.js');

const child = spawn(process.execPath, [main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

// This process only starts the real one, so a signal sent to it has to reach
// the real one. With no listener the default action ended the wrapper at once
// and left the child running: a `kill`, an editor ending `codeep acp` with a
// signal, a service manager stopping it, all orphaned the work (and the MCP
// servers it had started). Listening also keeps the wrapper alive until the
// child has finished what it does on a signal — saving the conversation,
// stopping its MCP servers — so a shell prompt does not come back over its
// output.
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Ctrl+C is a SIGINT the terminal sends by itself, to every process in the
// foreground group, the child among them. Passing it on as well would deliver
// it twice, and the chat's shutdown is not safe to run twice. The chat only
// runs with a terminal on stdin, so that is what is asked: where stdin is a
// terminal, a SIGINT most likely came from it. Where it is not — an editor
// piping `codeep acp`, a service, `codeep review > out.log` — nothing else
// will deliver it, and a `kill -INT` aimed at the wrapper has to reach the real
// process (the commands that run there do not mind a second one). A `kill -INT`
// aimed at the wrapper alone while stdin is a terminal is not passed on: Node
// cannot tell who sent a signal. Asked of the descriptor, not of process.stdin,
// which would open a stream on a terminal this process only hands to the child.
const attachedToTerminal = isatty(0);

const listeners = new Map();
for (const signal of FORWARDED) {
  const listener = () => {
    if (signal === 'SIGINT' && attachedToTerminal) return;
    try { child.kill(signal); } catch { /* already gone */ }
  };
  try {
    process.on(signal, listener);
    listeners.set(signal, listener);
  } catch { /* a platform without this signal */ }
}

child.on('exit', (code, signal) => {
  if (!signal) {
    process.exit(code ?? 0);
    return;
  }
  // The child was ended by a signal, its own doing or someone else's. End the
  // same way, so a shell or a script sees what it would have seen without this
  // wrapper: 143 for a SIGTERM, and a SIGINT that a shell reads as "the user
  // wants the whole script stopped", which an exit code of 130 does not say.
  for (const [name, listener] of listeners) process.removeListener(name, listener);
  try { process.kill(process.pid, signal); } catch { /* not ours to raise */ }
  // Should the signal not end this process (one that is ignored here), end it
  // with the status a shell would give for it. Never reached when it does.
  setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 200);
});
