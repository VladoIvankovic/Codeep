/**
 * Syntax highlighting for the terminal renderer.
 * Supports 12+ languages with One Dark theme colors.
 */

import { fg } from './ansi';

export const SYNTAX = {
  keyword:     fg.rgb(198, 120, 221),
  string:      fg.rgb(152, 195, 121),
  number:      fg.rgb(209, 154, 102),
  comment:     fg.rgb(92, 99, 112),
  function:    fg.rgb(97, 175, 239),
  type:        fg.rgb(229, 192, 123),
  operator:    fg.rgb(86, 182, 194),
  variable:    fg.white,
  punctuation: fg.gray,
  codeFrame:   fg.rgb(100, 105, 115),
  codeLang:    fg.rgb(150, 155, 165),
};

const KEYWORDS: Record<string, string[]> = {
  js:   ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'throw', 'finally', 'new', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'this', 'super', 'null', 'undefined', 'true', 'false', 'NaN', 'Infinity'],
  ts:   ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'throw', 'finally', 'new', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'this', 'super', 'null', 'undefined', 'true', 'false', 'type', 'interface', 'enum', 'namespace', 'module', 'declare', 'abstract', 'implements', 'private', 'public', 'protected', 'readonly', 'static', 'as', 'is', 'keyof', 'infer', 'never', 'unknown', 'any'],
  py:   ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'raise', 'import', 'from', 'as', 'with', 'yield', 'lambda', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'global', 'nonlocal', 'assert', 'del', 'async', 'await'],
  go:   ['func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'break', 'continue', 'fallthrough', 'default', 'go', 'select', 'chan', 'defer', 'panic', 'recover', 'type', 'struct', 'interface', 'map', 'package', 'import', 'const', 'var', 'nil', 'true', 'false', 'iota', 'make', 'new', 'append', 'len', 'cap', 'copy', 'delete'],
  rust: ['fn', 'let', 'mut', 'const', 'static', 'return', 'if', 'else', 'match', 'for', 'while', 'loop', 'break', 'continue', 'struct', 'enum', 'trait', 'impl', 'type', 'where', 'use', 'mod', 'pub', 'crate', 'self', 'super', 'async', 'await', 'move', 'ref', 'true', 'false', 'Some', 'None', 'Ok', 'Err', 'Self', 'dyn', 'unsafe', 'extern'],
  sh:   ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done', 'in', 'function', 'return', 'local', 'export', 'readonly', 'declare', 'typeset', 'unset', 'shift', 'exit', 'break', 'continue', 'source', 'alias', 'echo', 'printf', 'read', 'test', 'true', 'false'],
  html: ['html', 'head', 'body', 'div', 'span', 'p', 'a', 'img', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'meta', 'link', 'script', 'style', 'title', 'DOCTYPE'],
  css:  ['import', 'media', 'keyframes', 'font-face', 'supports', 'charset', 'namespace', 'page', 'inherit', 'initial', 'unset', 'none', 'auto', 'block', 'inline', 'flex', 'grid', 'absolute', 'relative', 'fixed', 'sticky', 'static', 'hidden', 'visible', 'solid', 'dashed', 'dotted', 'transparent', 'important'],
};

const LANG_ALIASES: Record<string, string> = {
  javascript: 'js', typescript: 'ts', python: 'py', golang: 'go',
  bash: 'sh', shell: 'sh', zsh: 'sh', tsx: 'ts', jsx: 'js',
  htm: 'html', scss: 'css', sass: 'css', less: 'css',
};

export function highlightCode(code: string, lang: string): string {
  const normalizedLang = LANG_ALIASES[lang.toLowerCase()] || lang.toLowerCase();
  const keywords = KEYWORDS[normalizedLang] || KEYWORDS['js'] || [];

  if (normalizedLang === 'html' || normalizedLang === 'xml' || normalizedLang === 'svg') {
    return code.replace(/(<\/?)(\w[\w-]*)((?:\s+[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?)*)(\s*\/?>)/g,
      (_match, open, tag, attrs, close) => {
        const highlightedAttrs = attrs.replace(/([\w-]+)(=)("[^"]*"|'[^']*')/g,
          (_m: string, attr: string, eq: string, val: string) =>
            SYNTAX.function + attr + '\x1b[0m' + SYNTAX.operator + eq + '\x1b[0m' + SYNTAX.string + val + '\x1b[0m'
        );
        return SYNTAX.punctuation + open + '\x1b[0m' + SYNTAX.keyword + tag + '\x1b[0m' + highlightedAttrs + SYNTAX.punctuation + close + '\x1b[0m';
      }
    ).replace(/<!--[\s\S]*?-->/g, (comment) => SYNTAX.comment + comment + '\x1b[0m');
  }

  if (normalizedLang === 'css') {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => SYNTAX.comment + comment + '\x1b[0m')
      .replace(/([\w-]+)(\s*:\s*)([^;{}]+)/g,
        (_m, prop, colon, val) => SYNTAX.function + prop + '\x1b[0m' + colon + SYNTAX.string + val + '\x1b[0m'
      )
      .replace(/([.#]?[\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*)\s*\{/g,
        (match, selector) => SYNTAX.keyword + selector + '\x1b[0m' + ' {'
      );
  }

  let result = '';
  let i = 0;

  while (i < code.length) {
    if (code.slice(i, i + 2) === '//' || (normalizedLang === 'py' && code[i] === '#') ||
        (normalizedLang === 'sh' && code[i] === '#')) {
      let end = code.indexOf('\n', i);
      if (end === -1) end = code.length;
      result += SYNTAX.comment + code.slice(i, end) + '\x1b[0m';
      i = end;
      continue;
    }

    if (code.slice(i, i + 2) === '/*') {
      let end = code.indexOf('*/', i + 2);
      if (end === -1) end = code.length;
      else end += 2;
      result += SYNTAX.comment + code.slice(i, end) + '\x1b[0m';
      i = end;
      continue;
    }

    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i];
      let end = i + 1;
      while (end < code.length) {
        if (code[end] === '\\') { end += 2; }
        else if (code[end] === quote) { end++; break; }
        else { end++; }
      }
      result += SYNTAX.string + code.slice(i, end) + '\x1b[0m';
      i = end;
      continue;
    }

    const numMatch = code.slice(i).match(/^(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\.?\d*(?:e[+-]?\d+)?)/);
    if (numMatch && (i === 0 || !/[a-zA-Z_]/.test(code[i - 1]))) {
      result += SYNTAX.number + numMatch[1] + '\x1b[0m';
      i += numMatch[1].length;
      continue;
    }

    const identMatch = code.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (identMatch) {
      const ident = identMatch[0];
      const nextChar = code[i + ident.length];
      if (keywords.includes(ident)) {
        result += SYNTAX.keyword + ident + '\x1b[0m';
      } else if (nextChar === '(') {
        result += SYNTAX.function + ident + '\x1b[0m';
      } else if (/^[A-Z]/.test(ident)) {
        result += SYNTAX.type + ident + '\x1b[0m';
      } else {
        result += ident;
      }
      i += ident.length;
      continue;
    }

    const opMatch = code.slice(i).match(/^(===|!==|==|!=|<=|>=|=>|->|\+\+|--|&&|\|\||<<|>>|\+=|-=|\*=|\/=|[+\-*/%=<>!&|^~?:])/);
    if (opMatch) {
      result += SYNTAX.operator + opMatch[1] + '\x1b[0m';
      i += opMatch[1].length;
      continue;
    }

    if ('{}[]();,.'.includes(code[i])) {
      result += SYNTAX.punctuation + code[i] + '\x1b[0m';
      i++;
      continue;
    }

    result += code[i];
    i++;
  }

  return result;
}
