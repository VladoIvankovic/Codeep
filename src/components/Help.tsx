import React from 'react';
import { Text, Box } from 'ink';

export const Help: React.FC = () => (
  <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
    <Text color="#f02a30" bold>Commands</Text>
    <Text> </Text>
    <Text><Text color="#f02a30">/help</Text>              - Show this help</Text>
    <Text><Text color="#f02a30">/status</Text>            - Show current status</Text>
    <Text><Text color="#f02a30">/version</Text>           - Show version info</Text>
    <Text><Text color="#f02a30">/update</Text>            - Check for updates</Text>
    <Text><Text color="#f02a30">/model</Text>             - Switch model</Text>
    <Text><Text color="#f02a30">/protocol</Text>          - Switch API protocol</Text>
    <Text><Text color="#f02a30">/provider</Text>          - Switch API provider</Text>
    <Text><Text color="#f02a30">/lang</Text>              - Set response language</Text>
    <Text><Text color="#f02a30">/settings</Text>          - Adjust temp, tokens, timeout, rate limits</Text>
    <Text><Text color="#f02a30">/sessions</Text>          - Save/load chat sessions</Text>
    <Text><Text color="#f02a30">/sessions delete</Text> {'<name>'} - Delete a session</Text>
    <Text><Text color="#f02a30">/rename</Text> {'<name>'}     - Rename current session</Text>
    <Text><Text color="#f02a30">/search</Text> {'<term>'}    - Search through messages (e.g. /search error)</Text>
    <Text><Text color="#f02a30">/export</Text>            - Export chat to MD/JSON/TXT format</Text>
    <Text><Text color="#f02a30">/diff</Text> [--staged]    - Review git changes with AI</Text>
    <Text><Text color="#f02a30">/commit</Text>            - Generate commit message from staged changes</Text>
    <Text><Text color="#f02a30">/apply</Text>             - Apply file changes from AI response</Text>
    <Text><Text color="#f02a30">/copy</Text> [n]           - Copy code block [n] to clipboard</Text>
    <Text><Text color="#f02a30">/agent</Text> {'<task>'}      - Start autonomous agent for task</Text>
    <Text><Text color="#f02a30">/agent-dry</Text> {'<task>'}  - Preview agent actions (no changes)</Text>
    <Text><Text color="#f02a30">/agent-stop</Text>        - Stop running agent</Text>
    <Text><Text color="#f02a30">/clear</Text>             - Clear chat history</Text>
    <Text><Text color="#f02a30">/login</Text>             - Login with different key</Text>
    <Text><Text color="#f02a30">/logout</Text>            - Logout and clear key</Text>
    <Text><Text color="#f02a30">/exit</Text>              - Quit application</Text>
    <Text> </Text>
    <Text color="#f02a30" bold>Shortcuts</Text>
    <Text> </Text>
    <Text><Text color="#f02a30">↑/↓</Text>     - Navigate input history or command suggestions</Text>
    <Text><Text color="#f02a30">Tab</Text>      - Autocomplete selected command</Text>
    <Text><Text color="#f02a30">Ctrl+L</Text>  - Clear chat (same as /clear)</Text>
    <Text><Text color="#f02a30">Escape</Text>  - Cancel request</Text>
    <Text> </Text>
    <Text color="#f02a30" bold>Code Blocks</Text>
    <Text> </Text>
    <Text>Code blocks are numbered [0], [1], etc.</Text>
    <Text>Use <Text color="#f02a30">/copy</Text> to copy last block, <Text color="#f02a30">/copy 0</Text> for first</Text>
    <Text> </Text>
    <Text color="#f02a30" bold>Project Context</Text>
    <Text> </Text>
    <Text>When started in a project directory, Codeep can:</Text>
    <Text>  • Auto-detect file paths in your messages</Text>
    <Text>  • Attach file contents automatically</Text>
    <Text>  • Understand your project structure</Text>
    <Text> </Text>
    <Text>Examples:</Text>
    <Text>  <Text>"check src/app.tsx"</Text> - reads and analyzes file</Text>
    <Text>  <Text>"what does package.json contain"</Text> - shows file</Text>
    <Text>  <Text>"improve error handling"</Text> - AI knows project</Text>
    <Text> </Text>
    <Text color="#f02a30" bold>Agent Mode</Text>
    <Text> </Text>
    <Text>Two modes available in <Text color="#f02a30">/settings</Text>:</Text>
    <Text>  • <Text color="green" bold>ON</Text> - Agent runs automatically on every message</Text>
    <Text>  • <Text color="yellow" bold>Manual</Text> - Agent runs only with /agent command</Text>
    <Text> </Text>
    <Text>Agent capabilities:</Text>
    <Text>  • Creates, edits, deletes files automatically</Text>
    <Text>  • Runs shell commands (npm, git, etc.)</Text>
    <Text>  • Loops until task is complete</Text>
    <Text>  • Shows progress and all actions taken</Text>
    <Text> </Text>
    <Text>Manual mode examples:</Text>
    <Text>  <Text color="#f02a30">/agent</Text> "add error handling to api.ts"</Text>
    <Text>  <Text color="#f02a30">/agent</Text> "run tests and fix failures"</Text>
    <Text>  <Text color="#f02a30">/agent</Text> "create a new React component for user profile"</Text>
    <Text>  <Text color="#f02a30">/agent-dry</Text> "refactor utils folder" - preview only</Text>
  </Box>
);
