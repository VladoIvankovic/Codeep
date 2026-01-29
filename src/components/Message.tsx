import React, { memo, useMemo } from 'react';
import { Text, Box } from 'ink';

// Global code block storage for copy functionality
let codeBlocks: string[] = [];

export function getCodeBlocks(): string[] {
  return codeBlocks;
}

export function clearCodeBlocks(): void {
  codeBlocks = [];
}

export function getCodeBlock(index: number): string | null {
  if (index < 0) {
    // Negative index = from end (-1 = last block)
    const actualIndex = codeBlocks.length + index;
    return codeBlocks[actualIndex] || null;
  }
  return codeBlocks[index] || null;
}

interface MessageProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export const MessageView: React.FC<MessageProps> = memo(({ role, content }) => {
  if (role === 'user') {
    // For long user messages, truncate display but keep full content for processing
    const maxDisplayLength = 500;
    const isLong = content.length > maxDisplayLength;
    const displayContent = isLong 
      ? content.substring(0, maxDisplayLength) + '...' 
      : content;
    
    // Replace multiple newlines with single space for cleaner display
    const cleanContent = displayContent.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    
    return (
      <Box marginY={1} flexDirection="column">
        <Text wrap="wrap">
          <Text color="#f02a30" bold>{'> '}</Text>
          <Text>{cleanContent}</Text>
        </Text>
        {isLong && (
          <Text color="gray" dimColor>  ({content.length} characters total)</Text>
        )}
      </Box>
    );
  }

  if (role === 'system') {
    return (
      <Box marginY={1} justifyContent="center">
        <Text italic>{content}</Text>
      </Box>
    );
  }

  // Assistant message - parse code blocks and markdown
  // Clear and rebuild code blocks on each render
  codeBlocks = [];
  
  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      <FormattedResponse content={content} />
    </Box>
  );
});

const FormattedResponse: React.FC<{ content: string }> = memo(({ content }) => {
  const segments = parseContent(content);
  let codeBlockIndex = 0;

  return (
    <>
      {segments.map((segment, i) => {
        if (segment.type === 'code') {
          const idx = codeBlockIndex++;
          // Store code block for copy functionality
          codeBlocks.push(segment.content);
          return <CodeBlock key={i} code={segment.content} language={segment.language || 'code'} index={idx} />;
        }
        // Render text with inline markdown
        return <MarkdownText key={i} text={segment.content} />;
      })}
    </>
  );
});

// Render inline markdown: **bold**, *italic*, `code`, __underline__
const MarkdownText: React.FC<{ text: string }> = memo(({ text }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      parts.push(<Text key={key++} bold>{boldMatch[2]}</Text>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)([^*_]+)\1/);
    if (italicMatch) {
      parts.push(<Text key={key++} italic>{italicMatch[2]}</Text>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<Text key={key++} color="cyan" backgroundColor="gray">{codeMatch[1]}</Text>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Headers: # ## ### at start of line
    const headerMatch = remaining.match(/^(#{1,3})\s+(.+?)(?:\n|$)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const color = level === 1 ? '#f02a30' : level === 2 ? 'cyan' : 'green';
      parts.push(
        <Text key={key++} color={color} bold>
          {headerMatch[2]}
        </Text>
      );
      parts.push(<Text key={key++}>{'\n'}</Text>);
      remaining = remaining.slice(headerMatch[0].length);
      continue;
    }

    // List items: - item or * item or number. item
    const listMatch = remaining.match(/^(\s*)([-*]|\d+\.)\s+(.+?)(?:\n|$)/);
    if (listMatch) {
      const indent = listMatch[1];
      const bullet = listMatch[2].match(/^\d/) ? listMatch[2] : '•';
      parts.push(
        <Text key={key++}>
          {indent}<Text color="#f02a30">{bullet}</Text> {listMatch[3]}{'\n'}
        </Text>
      );
      remaining = remaining.slice(listMatch[0].length);
      continue;
    }

    // Links: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push(
        <Text key={key++} color="blue" underline>
          {linkMatch[1]}
        </Text>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Default: consume until next special character or end
    const nextSpecial = remaining.search(/[\*_`#\[\n-]/);
    if (nextSpecial === -1) {
      parts.push(<Text key={key++}>{remaining}</Text>);
      break;
    } else if (nextSpecial === 0) {
      // Not a valid markdown char, consume single char
      parts.push(<Text key={key++}>{remaining[0]}</Text>);
      remaining = remaining.slice(1);
    } else {
      parts.push(<Text key={key++}>{remaining.slice(0, nextSpecial)}</Text>);
      remaining = remaining.slice(nextSpecial);
    }
  }

  return <Text>{parts}</Text>;
});

const CodeBlock: React.FC<{ code: string; language: string; index: number }> = memo(({ code, language, index }) => {
  const lines = code.split('\n');
  
  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>{language}</Text>
        <Text>[{index}]</Text>
      </Box>
      <Text> </Text>
      {lines.map((line, i) => (
        <SyntaxLine key={i} line={line} language={language} />
      ))}
    </Box>
  );
});

// Keywords by language - defined outside component to avoid recreation
const SYNTAX_KEYWORDS: Record<string, string[]> = {
  python: ['def', 'class', 'return', 'if', 'else', 'elif', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'raise', 'with', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'lambda', 'pass', 'break', 'continue', 'global', 'async', 'await'],
  javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof'],
  typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this', 'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum', 'private', 'public', 'protected', 'readonly'],
  java: ['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'return', 'if', 'else', 'for', 'while', 'new', 'this', 'static', 'final', 'void', 'int', 'String', 'boolean', 'true', 'false', 'null', 'try', 'catch', 'throw', 'throws'],
  go: ['func', 'var', 'const', 'if', 'else', 'for', 'range', 'switch', 'case', 'return', 'struct', 'interface', 'package', 'import', 'type', 'map', 'chan', 'go', 'defer', 'true', 'false', 'nil'],
  rust: ['fn', 'let', 'mut', 'const', 'if', 'else', 'for', 'while', 'loop', 'match', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'self', 'super', 'true', 'false', 'return', 'async', 'await'],
  bash: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'echo', 'exit', 'export', 'local'],
  sh: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'echo', 'exit', 'export', 'local'],
  php: ['function', 'class', 'public', 'private', 'protected', 'return', 'if', 'else', 'elseif', 'for', 'foreach', 'while', 'echo', 'print', 'new', 'this', 'true', 'false', 'null', 'use', 'namespace', 'extends', 'implements'],
  html: ['html', 'head', 'body', 'div', 'span', 'p', 'a', 'img', 'script', 'style', 'link', 'meta', 'title', 'h1', 'h2', 'h3', 'ul', 'li', 'table', 'tr', 'td', 'form', 'input', 'button'],
  css: ['color', 'background', 'margin', 'padding', 'border', 'width', 'height', 'display', 'flex', 'grid', 'position', 'top', 'left', 'right', 'bottom', 'font', 'text'],
  sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT'],
};

// Syntax highlighting component - memoized to prevent re-renders
const SyntaxLine: React.FC<{ line: string; language: string }> = memo(({ line, language }) => {
  const lang = language.toLowerCase();
  const langKeywords = SYNTAX_KEYWORDS[lang] || [];
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  while (remaining.length > 0) {
    // Comments
    if (remaining.startsWith('//') || remaining.startsWith('#')) {
      parts.push(<Text key={key++} color="gray">{remaining}</Text>);
      break;
    }
    
    // Multi-line string/docstring
    if (remaining.startsWith('"""') || remaining.startsWith("'''")) {
      const quote = remaining.slice(0, 3);
      parts.push(<Text key={key++} color="green">{remaining}</Text>);
      break;
    }

    // Strings
    const stringMatch = remaining.match(/^(["'`])(?:[^\\]|\\.)*?\1/);
    if (stringMatch) {
      parts.push(<Text key={key++} color="green">{stringMatch[0]}</Text>);
      remaining = remaining.slice(stringMatch[0].length);
      continue;
    }

    // Keywords
    const wordMatch = remaining.match(/^[a-zA-Z_]\w*/);
    if (wordMatch) {
      const word = wordMatch[0];
      if (langKeywords.includes(word)) {
        parts.push(<Text key={key++} color="magenta" bold>{word}</Text>);
      } else if (word.match(/^[A-Z]/)) {
        // Class names / constants
        parts.push(<Text key={key++} color="cyan">{word}</Text>);
      } else {
        parts.push(<Text key={key++}>{word}</Text>);
      }
      remaining = remaining.slice(word.length);
      continue;
    }

    // Numbers
    const numMatch = remaining.match(/^\d+\.?\d*/);
    if (numMatch) {
      parts.push(<Text key={key++} color="#f02a30">{numMatch[0]}</Text>);
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Operators and brackets
    const opMatch = remaining.match(/^[+\-*/%=<>!&|^~?:;,.()\[\]{}]+/);
    if (opMatch) {
      parts.push(<Text key={key++} color="white">{opMatch[0]}</Text>);
      remaining = remaining.slice(opMatch[0].length);
      continue;
    }

    // Default
    parts.push(<Text key={key++}>{remaining[0]}</Text>);
    remaining = remaining.slice(1);
  }

  return <Text>{parts}</Text>;
});

interface Segment {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

function parseContent(text: string): Segment[] {
  const segments: Segment[] = [];
  // Match code blocks: ```lang or ``` followed by code and closing ```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index).trim();
      if (textBefore) {
        segments.push({ type: 'text', content: textBefore });
      }
    }

    // Code block
    const lang = match[1] || 'code';
    const code = match[2] || '';
    segments.push({
      type: 'code',
      content: code.trim(),
      language: lang,
    });

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', content: remaining });
    }
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content: text });
  }

  return segments;
}
