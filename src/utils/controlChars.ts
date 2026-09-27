/**
 * Spelling out characters that would change how text around them looks.
 *
 * Moved here from renderer/agentExecution.ts (which re-exports it) so code
 * under utils/ — the MCP client's exit reasons, the MCP config notices — can
 * escape what a server or a repository wrote without importing the renderer.
 */

/**
 * Model-written text shown in a permission dialog, with every character that
 * could change how the rest of it looks spelled out: an ESC sequence would be
 * read as a style (conceal, black on black) and a bidi override or zero-width
 * character reorders or hides text, so the user could approve a command they
 * were not shown. Newlines are left for the caller to lay out.
 */
export function showControls(text: string): string {
  return text.replace(
    /[\x00-\x09\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (c) => {
      const code = c.charCodeAt(0);
      return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
    },
  );
}

/**
 * `showControls` for text that must stay on one line — a server name inside
 * a notice, a reason in a list — so a newline is spelled out too: left as it
 * is, text from a repository or a server could start a line of its own that
 * reads like one Codeep wrote.
 */
export function showControlsInline(text: string): string {
  return showControls(text).replace(/\n/g, '\\x0a');
}
