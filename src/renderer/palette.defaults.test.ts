/**
 * Without an Omarchy theme, every colour Codeep paints is the one it painted
 * before the palette existed — byte for byte.
 *
 * The palette moved ~150 colour reads behind roles, and most of them are a
 * call site choosing which role to read. A wrong choice there is invisible to
 * the per-role table in palette.test.ts (each role still holds the right
 * value; the Mode line just reads the hint grey instead of its own), and to
 * the eye (130 vs 150 grey). So this file renders a corpus through the REAL
 * formatters and components and pins a digest of everything they emitted.
 *
 * The digest was taken from the tree before the palette was introduced
 * (cabba11, where every colour was still an inline `fg.rgb(…)` literal), by
 * running this same corpus against it. If it fails, something now paints a
 * different escape sequence than Codeep did then: diff `renderCorpus()`
 * against that commit to find which line.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Screen } from './Screen';
import { formatWelcomeMessage } from './components/WelcomeFormatter';
import { formatMessage } from './components/MessageFormatter';
import { highlightCode, SYNTAX } from './highlight';
import { renderModal, renderHelpModal, renderConfirmModal, renderListModal } from './components/Modal';
import { renderSelectScreen } from './components/SelectScreen';
import { renderSearchPanel } from './components/Search';
import { renderProviderSelect } from './components/Login';
import { PRIMARY_COLOR } from './components/uiConstants';

/** A Screen that remembers what it was asked to draw, in order. */
function recordingScreen(calls: unknown[]): Screen {
  return new Proxy({}, {
    get: (_target, method) => {
      if (method === 'getSize') return () => ({ width: 100, height: 30 });
      return (...args: unknown[]) => { calls.push([String(method), ...args]); };
    },
  }) as Screen;
}

const WELCOME = [
  'Codeep v3.8.1  ·  Z.AI  ·  glm-5.3',
  '',
  '  Project  /home/user/project',
  '  Access   Read & Write  ·  Agent enabled',
  '  Mode     Chat only  ·  no project context',
  '',
  '  ⚠  Agent Mode ON  —  messages auto-execute as agent tasks',
  '',
  '  /help  ·  Ctrl+L clear  ·  Esc cancel',
].join('\n');

const MARKDOWN = [
  '# Heading one',
  '### Heading three',
  'Some **bold**, *italic*, ***both***, `inline code` and ~~gone~~ text.',
  '> a quoted line with **bold** inside',
  '- a list item with `code`',
  '1. a numbered item',
  '---',
  'A plain paragraph long enough that it will have to wrap at the narrow width this corpus formats at.',
].join('\n');

const CODE: Array<[string, string]> = [
  ['ts', 'const answer: Answer = compute(42, "forty-two"); // the answer\n/* block */ type X = 0x1F;'],
  ['py', 'def f(x):\n    return None  # nothing'],
  ['go', 'func main() { fmt.Println(`hi`) }'],
  ['sh', 'if [ -f x ]; then echo "yes"; fi # done'],
  ['html', '<div class="a" id=\'b\'><!-- note --></div>'],
  ['css', '/* c */ .btn > a { color: red; }'],
  ['diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line\n context'],
];

function renderCorpus(): unknown {
  const counter = { current: 0 };
  const fenced = CODE.map(([lang, code]) => '```' + lang + '\n' + code + '\n```').join('\n');
  const out: Record<string, unknown> = {
    primary: PRIMARY_COLOR,
    syntax: { ...SYNTAX },
    welcome: formatWelcomeMessage(WELCOME),
    user: formatMessage('user', 'Fix the **build** please', 60, counter),
    assistant: formatMessage('assistant', MARKDOWN + '\n' + fenced + '\nDone.', 60, counter),
    system: formatMessage('system', 'Session saved', 60, counter),
    highlighted: CODE.map(([lang, code]) => highlightCode(code, lang)),
  };

  const screens: Record<string, unknown[]> = {};
  const draw = (name: string, paint: (screen: Screen) => void) => {
    const calls: unknown[] = [];
    paint(recordingScreen(calls));
    screens[name] = calls;
  };
  draw('modal', s => renderModal(s, { title: 'Title', content: ['one', 'two'] }));
  draw('helpModal', s => renderHelpModal(s, 'Help', [{ key: 'Esc', description: 'close' }], 'footer'));
  draw('confirmYes', s => renderConfirmModal(s, 'Sure?', ['Really?'], 'yes'));
  draw('confirmNo', s => renderConfirmModal(s, 'Sure?', ['Really?'], 'no'));
  draw('listModal', s => renderListModal(s, 'Pick', ['a', 'b', 'c'], 1, 'Enter select'));
  draw('select', s => renderSelectScreen(s, 'Model', [
    { key: 'a', label: 'Alpha', description: 'first' },
    { key: 'b', label: 'Beta' },
    { key: 'c', label: 'Gamma' },
  ], { selectedIndex: 0 }, 'b'));
  draw('search', s => renderSearchPanel(s, 0, 100, 20, {
    searchOpen: true,
    searchQuery: 'build',
    searchResults: [
      { role: 'user', messageIndex: 0, matchedText: 'fix the build' },
      { role: 'assistant', messageIndex: 1, matchedText: 'the build is fixed' },
    ],
    searchIndex: 0,
    searchCallback: null,
  }));
  draw('providers', s => renderProviderSelect(s, [
    { id: 'z.ai', name: 'Z.AI', description: 'GLM' },
    { id: 'ollama', name: 'Ollama' },
  ], 0));
  out.screens = screens;
  return out;
}

/** sha256 of renderCorpus() at cabba11, before the palette. */
const DIGEST_BEFORE_PALETTE = 'ce4bab2738f06e0829bc20fda1c58c8725604def6003b88978191bb1667e97a9';

describe('the default palette', () => {
  it('paints exactly what Codeep painted before the palette existed', () => {
    const digest = createHash('sha256').update(JSON.stringify(renderCorpus())).digest('hex');
    expect(digest).toBe(DIGEST_BEFORE_PALETTE);
  });
});
