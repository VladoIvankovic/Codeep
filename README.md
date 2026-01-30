# Codeep

<p align="center">
  <img src="Codeep.svg" alt="Codeep Logo" width="200">
</p>

<p align="center">
  <strong>Deep into Code.</strong>
</p>

<p align="center">
  AI-powered coding assistant built for the terminal. Multiple LLM providers, project-aware context, and a seamless development workflow.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codeep"><img src="https://img.shields.io/npm/v/codeep.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/codeep"><img src="https://img.shields.io/npm/dm/codeep.svg" alt="npm downloads"></a>
  <a href="https://github.com/VladoIvankovic/Codeep/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/codeep.svg" alt="license"></a>
  <a href="https://github.com/VladoIvankovic/Codeep"><img src="https://img.shields.io/github/stars/VladoIvankovic/Codeep?style=social" alt="GitHub stars"></a>
</p>

## Features

### Multi-Provider Support
- **Z.AI (ZhipuAI)** - GLM-4.7, GLM-4.7 Flash models
- **MiniMax** - MiniMax M2.1 model
- Switch between providers with `/provider`
- Configure different API keys per provider

### Project Context Awareness
When started in a project directory, Codeep automatically:
- Detects project type (Node.js, Python, etc.)
- Reads file paths mentioned in your messages
- Attaches file contents to conversations
- Understands your project structure
- Can suggest and apply code changes (with write permission)

### Session Management
- **Auto-save** - Conversations are automatically saved
- **Session picker** - Choose which session to continue on startup
- **Per-project sessions** - Sessions stored in `.codeep/sessions/`
- **Rename sessions** - Give meaningful names with `/rename`
- **Search history** - Find past conversations with `/search`
- **Export** - Save to Markdown, JSON, or plain text

### Git Integration
- `/diff` - Review unstaged changes with AI assistance
- `/diff --staged` - Review staged changes
- `/commit` - Generate conventional commit messages

### Code Block Management
- Automatic syntax highlighting for 12+ languages
- Copy code blocks to clipboard with `/copy [n]`
- Code blocks are numbered for easy reference

### Clipboard Paste
- **`/paste` command** - Paste content from clipboard into chat
- Type `/paste` and press Enter to read clipboard content
- Shows preview with character/line count before sending
- Press Enter to send, Escape to cancel
- Works reliably in all terminals (no Ctrl+V issues)

### Autonomous Agent Mode

Codeep works as a **full AI coding agent** that autonomously:
- Creates, edits, and deletes files
- Executes shell commands (npm, git, build, test, etc.)
- Reads and analyzes your codebase
- Loops until the task is complete
- Reports all actions taken

**Auto mode (default)**: Just describe what you want - no special commands needed:
```
> add error handling to src/api/index.ts
> run tests and fix any failures
> create a new React component for user settings
```

**Manual mode**: Use `/agent <task>` when you want explicit control.

**Agent Tools:**
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Edit specific text in files |
| `delete_file` | Delete files or directories |
| `create_directory` | Create folders |
| `list_files` | List directory contents |
| `execute_command` | Run shell commands |
| `search_code` | Search for patterns in code |
| `fetch_url` | Fetch content from URLs |

### Undo & History
- **Undo actions** - Revert any file change the agent made
- **Session history** - View and restore from previous agent sessions
- **Action tracking** - All file operations are logged for review

### Context Persistence
- **Save conversations** - Continue where you left off
- **Per-project context** - Each project maintains its own history
- **Automatic summarization** - Old messages are summarized to save space

### Web Fetch
- Agent can fetch documentation and web content
- Useful for looking up API docs, examples, etc.
- Automatic HTML-to-text conversion

### Smart Context
Agent automatically gathers relevant files before making changes:
- Analyzes imports and dependencies
- Reads related type definitions
- Understands project structure
- Prevents duplicate code and inconsistencies

### Code Review Mode
Built-in static analysis with `/review`:
- Security vulnerabilities (XSS, injection, hardcoded secrets)
- Performance issues (inefficient patterns)
- Type safety problems (any types, ts-ignore)
- Best practices and maintainability
- Generates a score (0-100)

### Interactive Mode
Agent asks clarifying questions when tasks are ambiguous:
```
You: "add authentication"
Agent: "What type of authentication do you want?
        a) JWT tokens
        b) Session-based
        c) OAuth (Google/GitHub)"
```

### Diff Preview
See exactly what will change before applying:
```diff
- const user = getUser();
+ const user = await getUser();
```

### Learning Mode
Agent learns your coding preferences:
- Indentation style (tabs/spaces)
- Quote style (single/double)
- Naming conventions
- Preferred libraries
- Custom rules you define

### Skills System
Predefined workflows for common development tasks. Execute with a single command:

```
/commit      - Generate commit message and commit
/test        - Generate tests for current code
/docs        - Add documentation to code
/refactor    - Improve code quality
/fix         - Debug and fix issues
/component   - Generate React/Vue component
/docker      - Generate Dockerfile
```

**50+ Built-in Skills:**

| Category | Skills |
|----------|--------|
| **Git** | `/commit` (`/c`), `/amend`, `/push` (`/p`), `/pull`, `/pr`, `/changelog`, `/branch`, `/stash`, `/unstash` |
| **Testing** | `/test` (`/t`), `/test-fix`, `/coverage`, `/e2e`, `/mock` |
| **Documentation** | `/docs` (`/d`), `/readme`, `/explain` (`/e`), `/api-docs`, `/translate` |
| **Refactoring** | `/refactor` (`/r`), `/types`, `/optimize` (`/o`), `/cleanup`, `/modernize`, `/migrate`, `/split`, `/rename` |
| **Debugging** | `/debug` (`/b`), `/fix` (`/f`), `/security`, `/profile`, `/log` |
| **Deployment** | `/build`, `/deploy`, `/release`, `/publish` |
| **Code Generation** | `/component`, `/api`, `/model`, `/hook`, `/service`, `/page`, `/form`, `/crud` |
| **DevOps** | `/docker`, `/ci`, `/env`, `/k8s`, `/terraform`, `/nginx`, `/monitor` |

**Shortcuts:** Many skills have single-letter shortcuts (shown in parentheses).

**Skill Parameters:** Many skills accept parameters:
```
/component UserCard              # Generate component named UserCard
/api users method=POST           # Generate POST endpoint for users
/migrate "React 18"              # Migrate to React 18
/model User fields=name,email    # Generate User model with fields
```

**Skill Chaining:** Run multiple skills in sequence with `+`:
```
/commit+push          # Commit then push
/test+commit+push     # Test, commit if pass, then push
/build+deploy         # Build then deploy
```

**Search Skills:**
```
/skills docker        # Find skills related to docker
/skills testing       # Find testing-related skills
```

**Custom Skills:** Create your own skills:
```
/skill create my-workflow        # Creates template in ~/.codeep/skills/
/skill delete my-workflow        # Delete custom skill
/skill help commit               # Show skill details
```

Custom skill example (`~/.codeep/skills/my-workflow.json`):
```json
{
  "name": "my-workflow",
  "description": "My custom workflow",
  "shortcut": "m",
  "parameters": [
    { "name": "target", "description": "Target environment", "required": true }
  ],
  "steps": [
    { "type": "command", "content": "npm run build" },
    { "type": "confirm", "content": "Deploy to ${target}?" },
    { "type": "agent", "content": "Deploy the application to ${target}" },
    { "type": "notify", "content": "Deployed to ${target}!" }
  ]
}
```

### Self-Verification
After making changes, the agent automatically:
1. Runs **build** to check for compilation errors
2. Runs **tests** to ensure nothing is broken
3. Runs **type checking** for TypeScript/PHP projects
4. If errors found → automatically tries to fix them (up to 3 attempts)
5. Reports final verification status

**Supported project types:**

| Language | Build | Test | Type Check |
|----------|-------|------|------------|
| **Node.js/TypeScript** | npm/yarn/pnpm/bun run build | npm test, vitest, jest | tsc --noEmit |
| **Python** | - | pytest | - |
| **Go** | go build | go test | - |
| **Rust** | cargo build | cargo test | - |
| **PHP/Laravel** | composer run build | phpunit, artisan test | php -l (syntax) |

### Security Features
- API keys stored securely (macOS Keychain / Linux Secret Service)
- Per-project permissions (read-only or read-write)
- Input validation and sanitization
- Configurable rate limiting
- Agent sandboxed to project directory
- Dangerous commands blocked (rm -rf /, sudo, etc.)
- Confirmation mode for destructive actions

## Installation

### Option 1: curl (Quickest)

```bash
curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | bash
```

**Custom installation directory:**
```bash
curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | INSTALL_DIR=~/.local/bin bash
```

**Specific version:**
```bash
curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | VERSION=1.0.0 bash
```

### Option 2: Homebrew (macOS/Linux)

```bash
brew tap VladoIvankovic/codeep
brew install codeep
```

**Update:**
```bash
brew upgrade codeep
```

### Option 3: npm

```bash
npm install -g codeep
```

**Update:**
```bash
npm update -g codeep
```

### Option 4: Manual Binary

Download the latest binary for your platform from [GitHub Releases](https://github.com/VladoIvankovic/Codeep/releases):

| Platform | Binary |
|----------|--------|
| macOS Apple Silicon (M1/M2/M3/M4) | `codeep-macos-arm64` |
| macOS Intel | `codeep-macos-x64` |
| Linux x86_64 | `codeep-linux-x64` |

```bash
# Example for macOS Apple Silicon:
curl -fsSL https://github.com/VladoIvankovic/Codeep/releases/latest/download/codeep-macos-arm64 -o codeep
chmod +x codeep
sudo mv codeep /usr/local/bin/
```

## Quick Start

```bash
# Navigate to your project directory
cd /path/to/your/project

# Start Codeep
codeep

# On first run, enter your API key
# Get one at: https://z.ai/subscribe?ic=NXYNXZOV14
```

After installation, `codeep` is available globally in your terminal. Simply run it from any project directory to start coding with AI assistance.

## Commands

### General

| Command | Description |
|---------|-------------|
| `/help` | Show help and available commands |
| `/status` | Show current configuration status |
| `/version` | Show version and current provider/model |
| `/update` | Check for updates |
| `/clear` | Clear chat history and start new session |
| `/exit` | Quit application |

### AI Configuration

| Command | Description |
|---------|-------------|
| `/provider` | Switch AI provider (Z.ai, MiniMax) |
| `/model` | Switch AI model |
| `/protocol` | Switch API protocol (OpenAI/Anthropic) |
| `/lang` | Set response language (12 languages supported) |
| `/settings` | Adjust temperature, max tokens, timeout, rate limits |

### Session Management

| Command | Description |
|---------|-------------|
| `/sessions` | List and load saved sessions |
| `/sessions delete <name>` | Delete a specific session |
| `/rename <name>` | Rename current session |
| `/search <term>` | Search through chat history |
| `/export` | Export chat to MD/JSON/TXT format |

### Code & Files

| Command | Description |
|---------|-------------|
| `/apply` | Apply file changes from AI response |
| `/copy [n]` | Copy code block to clipboard (n = block number, -1 = last) |

### Agent Mode

| Command | Description |
|---------|-------------|
| `/grant` | Grant write permission for agent (opens permission dialog) |
| `/agent <task>` | Run agent for a specific task (manual mode) |
| `/agent-dry <task>` | Preview what agent would do without executing |
| `/agent-stop` | Stop a running agent |
| `/undo` | Undo the last agent action |
| `/undo-all` | Undo all actions from current session |
| `/history` | Show recent agent sessions |
| `/changes` | Show all file changes from current session |

### Git Integration

| Command | Description |
|---------|-------------|
| `/diff` | Review unstaged git changes |
| `/diff --staged` | Review staged git changes |
| `/commit` | Generate commit message for staged changes |
| `/git-commit [msg]` | Commit current changes with message |

### Context Persistence

| Command | Description |
|---------|-------------|
| `/context-save` | Save current conversation for later |
| `/context-load` | Load previously saved conversation |
| `/context-clear` | Clear saved context for this project |

### Code Review & Learning

| Command | Description |
|---------|-------------|
| `/review` | Run code review on changed files |
| `/review <file>` | Review specific file |
| `/learn` | Learn preferences from project files |
| `/learn status` | Show learned preferences |
| `/learn rule <text>` | Add a custom coding rule |

### Skills

| Command | Description |
|---------|-------------|
| `/skills` | List all available skills |
| `/skills <query>` | Search skills by keyword |
| `/skills stats` | Show skill usage statistics |
| `/skill <name>` | Execute a skill (e.g., `/skill commit`) |
| `/skill <name> <params>` | Execute skill with parameters |
| `/skill help <name>` | Show skill details and steps |
| `/skill create <name>` | Create a new custom skill |
| `/skill delete <name>` | Delete a custom skill |
| `/c`, `/t`, `/d`, etc. | Skill shortcuts |
| `/commit+push` | Skill chaining (run multiple skills) |

### Authentication

| Command | Description |
|---------|-------------|
| `/login` | Login with API key |
| `/logout` | Logout (choose which provider) |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit message |
| `↑` / `↓` | Navigate input history |
| `Ctrl+L` | Clear chat (same as `/clear`) |
| `Escape` | Cancel current request |

## Supported Languages

Codeep can respond in 12 languages:

| Code | Language |
|------|----------|
| `auto` | Auto-detect (matches user's language) |
| `en` | English |
| `zh` | Chinese (中文) |
| `es` | Spanish (Español) |
| `hi` | Hindi (हिन्दी) |
| `ar` | Arabic (العربية) |
| `pt` | Portuguese (Português) |
| `fr` | French (Français) |
| `de` | German (Deutsch) |
| `ja` | Japanese (日本語) |
| `ru` | Russian (Русский) |
| `hr` | Croatian (Hrvatski) |

## Syntax Highlighting

Code blocks are automatically highlighted for:

- Python
- JavaScript / TypeScript
- Java
- Go
- Rust
- Bash / Shell
- PHP
- HTML / CSS
- SQL

## Project Permissions

When you run Codeep in a project directory for the first time:

1. Codeep asks for permission to access the project
2. You can grant:
   - **Read-only** - AI can see and analyze your code
   - **Read + Write** - AI can also suggest file modifications
3. Permissions are saved in `.codeep/config.json`

With write access enabled:
- AI can suggest file changes using special code blocks
- You'll be prompted to approve changes with `Y/n`
- Use `/apply` to manually apply changes from the last response

## Configuration

### Config Locations

| Type | Location |
|------|----------|
| Global config | `~/.config/codeep/config.json` |
| Project config | `.codeep/config.json` |
| Global sessions | `~/.codeep/sessions/` |
| Project sessions | `.codeep/sessions/` |
| Global logs | `~/.codeep/logs/` |
| Project logs | `.codeep/logs/` |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ZAI_API_KEY` | Z.ai API key |
| `ZHIPUAI_API_KEY` | ZhipuAI API key (alternative) |
| `MINIMAX_API_KEY` | MiniMax API key |

### Settings (`/settings`)

| Setting | Default | Description |
|---------|---------|-------------|
| Temperature | 0.7 | Response creativity (0.0 - 2.0) |
| Max Tokens | 8192 | Maximum response length |
| API Timeout | 60000ms | Request timeout |
| API Rate Limit | 30/min | Max API calls per minute |
| Command Rate Limit | 100/min | Max commands per minute |
| Agent Mode | ON | `ON` = agent runs automatically (requires write permission via `/grant`), `Manual` = use /agent |
| Agent API Timeout | 180000ms | Timeout per agent API call (auto-adjusted for complexity) |
| Agent Max Duration | 20 min | Maximum time for agent to run (5-60 min) |
| Agent Max Iterations | 100 | Maximum agent iterations (10-200) |
| Agent Confirmation | Dangerous | `Never`, `Dangerous` (default), or `Always` |
| Agent Auto-Commit | Off | Automatically commit after agent completes |
| Agent Branch | Off | Create new branch for agent commits |
| Agent Auto-Verify | On | Automatically run build/test after changes |
| Agent Max Fix Attempts | 3 | Max attempts to auto-fix errors |

## Usage Examples

### Autonomous Coding (Agent Mode ON)

First, grant write permission (required for Agent Mode ON to work):

```
> /grant
# Opens permission dialog - select "Read + Write" for full agent access
```

With write access enabled, just describe what you want:

```
> add input validation to the login form
# Agent reads the file, adds validation, writes changes

> the tests are failing, fix them
# Agent runs tests, analyzes errors, fixes code, re-runs tests

> refactor src/utils to use async/await instead of callbacks
# Agent reads files, refactors each one, verifies changes

> create a new API endpoint for user preferences
# Agent creates route file, adds types, updates index
```

### Code Review
```
> /diff --staged
# AI reviews your staged changes and provides feedback
```

### Manual Agent Mode
```
> /agent add a dark mode toggle to settings
# Explicitly runs agent for this task

> /agent-dry reorganize the folder structure
# Shows what agent would do without making changes
```

### Basic Chat (when agent mode is manual or read-only)
```
> Explain what a closure is in JavaScript
> Look at src/utils/api.ts and explain what it does
```

### Session Management
```
> /rename feature-auth-implementation
Session renamed to: feature-auth-implementation

> /search authentication
# Find all messages mentioning "authentication"

> /export
# Export chat to markdown file
```

## Architecture

Codeep is built with:

- **React + Ink** - Terminal UI framework
- **TypeScript** - Type-safe codebase
- **Conf** - Configuration management
- **Node.js Keychain** - Secure credential storage

## License

Apache 2.0

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/VladoIvankovic/Codeep).

## Support

- **Issues**: [GitHub Issues](https://github.com/VladoIvankovic/Codeep/issues)
