/**
 * Without an Omarchy theme, every colour Codeep paints is the one it painted
 * before the palette existed — byte for byte.
 *
 * The palette moved ~150 colour reads behind roles, and most of them are a
 * call site choosing which role to read. A wrong choice there is invisible to
 * the per-role table in palette.test.ts (each role still holds the right
 * value; the Mode line just reads the hint grey instead of its own), and to
 * the eye (130 vs 150 grey). So this file renders a corpus through the REAL
 * formatters and components and pins the colours they emitted, in order.
 *
 * Only the colours: the words, wrapping and box drawing around them are free
 * to change. The table was taken from the tree before the palette was
 * introduced (cabba11, where every colour was still an inline literal), by
 * running this same corpus against it. A failure names the entry and shows
 * where its colours went different.
 */
import { describe, it, expect } from 'vitest';
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

function renderCorpus(): Record<string, unknown> {
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
  return { ...out, ...screens };
}

/** Every string in a value, in order: formatted lines, Screen call arguments. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, into);
  return into;
}

/**
 * The colours `value` paints, in order, as SGR parameters ('38;2;240;42;48',
 * '90'): every escape that sets a foreground or background colour, with a
 * colour repeated straight after itself counted once, so a line that wraps
 * on in the same colour is not a change.
 */
function coloursOf(value: unknown): string[] {
  const colours: string[] = [];
  for (const text of strings(value)) {
    for (const [, params] of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const code = Number(params.split(';')[0]);
      const isColour = (code >= 30 && code <= 49) || (code >= 90 && code <= 107);
      if (isColour && colours[colours.length - 1] !== params) colours.push(params);
    }
  }
  return colours;
}

/** coloursOf() each entry of renderCorpus(), at cabba11, before the palette. */
const COLOURS_BEFORE_PALETTE: Record<string, string[]> = {
  primary: ['38;2;240;42;48'],
  syntax: [
    '38;2;198;120;221', '38;2;152;195;121', '38;2;209;154;102', '38;2;92;99;112', '38;2;97;175;239',
    '38;2;229;192;123', '38;2;86;182;194', '37', '90', '38;2;100;105;115', '38;2;150;155;165',
  ],
  welcome: [
    '38;2;240;42;48', '38;2;80;80;80', '38;2;180;180;180', '38;2;80;80;80', '38;2;130;130;130',
    '38;2;100;100;100', '38;2;100;180;220', '38;2;100;100;100', '38;2;100;200;120', '38;2;80;80;80',
    '38;2;80;160;100', '38;2;100;100;100', '38;2;160;160;160', '38;2;220;160;40',
    '38;2;150;150;150', '38;2;80;80;80', '38;2;150;150;150', '38;2;80;80;80', '38;2;150;150;150',
  ],
  user: ['38;2;240;42;48'],
  assistant: [
    '38;2;240;42;48', '38;2;120;120;120', '38;2;97;175;239', '38;2;198;120;221', '38;2;240;42;48',
    '38;2;209;154;102', '38;2;140;140;140', '38;2;240;42;48', '38;2;160;160;160', '38;2;240;42;48',
    '90', '38;2;209;154;102', '90', '38;2;150;155;165', '38;2;198;120;221', '38;2;86;182;194',
    '38;2;229;192;123', '38;2;86;182;194', '38;2;97;175;239', '90', '38;2;209;154;102', '90',
    '38;2;152;195;121', '90', '38;2;92;99;112', '38;2;198;120;221', '38;2;229;192;123',
    '38;2;86;182;194', '38;2;209;154;102', '90', '38;2;150;155;165', '38;2;198;120;221',
    '38;2;97;175;239', '90', '38;2;86;182;194', '38;2;198;120;221', '38;2;92;99;112',
    '38;2;150;155;165', '38;2;198;120;221', '38;2;97;175;239', '90', '38;2;97;175;239', '90',
    '38;2;152;195;121', '90', '38;2;150;155;165', '38;2;198;120;221', '90', '38;2;86;182;194', '90',
    '38;2;198;120;221', '38;2;152;195;121', '90', '38;2;198;120;221', '38;2;92;99;112',
    '38;2;150;155;165', '90', '38;2;198;120;221', '38;2;97;175;239', '38;2;86;182;194',
    '38;2;152;195;121', '38;2;97;175;239', '38;2;86;182;194', '38;2;152;195;121', '90',
    '38;2;92;99;112', '90', '38;2;198;120;221', '90', '38;2;150;155;165', '38;2;92;99;112',
    '38;2;198;120;221', '38;2;97;175;239', '38;2;152;195;121', '38;2;150;155;165',
    '38;2;86;182;194', '38;2;224;108;117', '38;2;152;195;121',
  ],
  system: ['38;2;240;42;48'],
  highlighted: [
    '38;2;198;120;221', '38;2;86;182;194', '38;2;229;192;123', '38;2;86;182;194', '38;2;97;175;239',
    '90', '38;2;209;154;102', '90', '38;2;152;195;121', '90', '38;2;92;99;112', '38;2;198;120;221',
    '38;2;229;192;123', '38;2;86;182;194', '38;2;209;154;102', '90', '38;2;198;120;221',
    '38;2;97;175;239', '90', '38;2;86;182;194', '38;2;198;120;221', '38;2;92;99;112',
    '38;2;198;120;221', '38;2;97;175;239', '90', '38;2;97;175;239', '90', '38;2;152;195;121', '90',
    '38;2;198;120;221', '90', '38;2;86;182;194', '90', '38;2;198;120;221', '38;2;152;195;121', '90',
    '38;2;198;120;221', '38;2;92;99;112', '90', '38;2;198;120;221', '38;2;97;175;239',
    '38;2;86;182;194', '38;2;152;195;121', '38;2;97;175;239', '38;2;86;182;194', '38;2;152;195;121',
    '90', '38;2;92;99;112', '90', '38;2;198;120;221', '90', '38;2;92;99;112', '38;2;198;120;221',
    '38;2;97;175;239', '38;2;152;195;121', '38;2;150;155;165', '38;2;86;182;194',
    '38;2;224;108;117', '38;2;152;195;121',
  ],
  modal: ['38;2;255;80;85', '38;2;240;42;48'],
  helpModal: ['38;2;255;80;85', '38;2;240;42;48', '33', '37', '90'],
  confirmYes: ['33', '37', '38;2;255;80;85', '90'],
  confirmNo: ['33', '37', '90', '38;2;255;80;85', '90'],
  listModal: ['38;2;255;80;85', '38;2;240;42;48', '37', '38;2;255;80;85', '37', '90'],
  select: ['38;2;240;42;48', '38;2;255;80;85', '90', '32', '37', '90'],
  search: [
    '38;2;240;42;48', '37', '36', '90', '38;2;240;42;48', '32', '90', '37', '34', '90', '37', '90',
  ],
  providers: ['38;2;240;42;48', '37', '38;2;240;42;48', '38;2;255;80;85', '37', '90'],
};

describe('the default palette', () => {
  const corpus = renderCorpus();

  it('renders the same entries the table was taken from', () => {
    expect(Object.keys(corpus)).toEqual(Object.keys(COLOURS_BEFORE_PALETTE));
  });

  it.each(Object.keys(COLOURS_BEFORE_PALETTE))('paints %s in exactly the colours Codeep painted before the palette existed', name => {
    expect(coloursOf(corpus[name])).toEqual(COLOURS_BEFORE_PALETTE[name]);
  });
});
