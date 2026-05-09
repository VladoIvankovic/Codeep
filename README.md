# Codeep

<p align="center">
  <img src="Codeep.svg" alt="Codeep Logo" width="200">
</p>

<p align="center">
  <strong>Deep into Code.</strong>
</p>

<p align="center">
  <img src="Codeep.gif" alt="Codeep demo" width="700">
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
- **Z.AI (ZhipuAI)** — GLM-5.1, GLM-5, GLM-5 Turbo, GLM-4.5 Air — Coding Plan & pay-per-use API (international & China)
- **OpenAI** — GPT-5.5, GPT-5.4, GPT-5.4 Mini, GPT-5.4 Nano
- **Anthropic** — Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5
- **DeepSeek** — DeepSeek V4 Pro, DeepSeek V4 Flash
- **Google AI** — Gemini 3.1 Pro Preview, Gemini 3 Flash Preview, Gemini 2.5 Pro, Gemini 2.5 Flash
- **MiniMax** — MiniMax M2.7, M2.5, M2.1, M2 — Coding Plan & pay-per-use API (international & China)
- **Ollama** — Run any model locally or on a remote server, no API key required. Models are fetched dynamically from your Ollama instance.
- Switch between providers with `/provider`
- Configure different API keys per provider
- Both OpenAI-compatible and Anthropic API protocols supported

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

### File Context (`/add`, `/drop`)
Explicitly add files to the conversation context:

- **`/add <path>`** - Add one or more files to context
- **`/add`** (no args) - Show currently added files
- **`/drop <path>`** - Remove a specific file from context
- **`/drop`** (no args) - Remove all files from context

Added files are automatically attached to every message (both chat and agent mode) until dropped. Useful for giving the AI specific files to work with.

```
> /add src/utils/api.ts src/types/index.ts
Added 2 file(s) to context (2 total)

> refactor the API client to use async/await
# AI sees both files attached to your message

> /drop
Dropped all 2 file(s) from context
```

### Multi-line Input
Write multi-line messages using backslash continuation or `/multiline` mode:

- **Backslash continuation** — end a line with `\` and press Enter to continue on the next line
- **`/multiline`** — toggle multi-line mode where Enter adds a new line and Esc sends the message

```
> Write a function that\
  takes two arguments and\
  returns their sum
# Sent as a single 3-line message

> /multiline
Multi-line mode ON — Enter adds line, Esc sends
M> (type freely, Enter = newline, Esc = send)
```

### Autonomous Agent Mode

Codeep works as a **full AI coding agent** that autonomously:
- Creates, edits, and deletes files
- Executes shell commands (npm, git, build, test, etc.)
- Reads and analyzes your codebase
- Loops until the task is complete
- Reports all actions taken
- **Live code display** - Shows syntax-highlighted code in chat as it writes/edits files

**Auto mode (default)**: Just describe what you want - no special commands needed:
```
> add error handling to src/api/index.ts
> run tests and fix any failures
> create a new React component for user settings
```

**Manual mode**: Use `/agent <task>` when you want explicit control.

> **Note for Ollama users:** Agent mode requires a capable model — at least **7B parameters** (e.g. `qwen2.5-coder:7b`, `llama3.1:8b`). Smaller models (1–3B) lack the instruction-following capacity for reliable tool use and may produce incorrect output. For small models, set Agent Mode to **Manual** or **Off** in `/settings`.

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

### Web & MCP Tools
- Agent can fetch documentation and web content
- Automatic HTML-to-text conversion
- **MCP-powered tools** (for Z.AI and Z.AI China providers):
  - `web_search` — Search the web for current information
  - `web_reader` — Fetch and read any web page
  - `zai_analyze_image` — Analyze images via Z.AI Vision (GLM-4V)
  - `minimax_understand_image` — Analyze images via MiniMax vision
- **Image paste** — Ctrl+V an image directly into the terminal to send it to a vision model
- MCP tools run as secure sub-processes with structured I/O

### Smart Context
Agent automatically gathers relevant files before making changes:
- Analyzes imports and dependencies
- Reads related type definitions
- Understands project structure
- Prevents duplicate code and inconsistencies

### Code Review Mode
AI-powered review of your git diff with `/review`:
- **Bugs** — logic errors, off-by-one, null/undefined issues
- **Security** — injection, auth issues, exposed secrets
- **Performance** — unnecessary loops, memory leaks
- **Edge cases** — unhandled inputs, missing error handling
- References file names and line numbers from the diff

```
> /review            # AI review of unstaged changes
> /review --staged   # AI review of staged changes
> /review --static   # Static regex analysis with score (0-100)
```

If there are no git changes, falls back to static analysis automatically.

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

### Project Rules
Define project-specific instructions that the AI always follows. Create a rules file in your project root:

- **`.codeep/rules.md`** - Primary location (inside `.codeep/` folder)
- **`CODEEP.md`** - Alternative location (project root, similar to `CLAUDE.md` or `.cursorrules`)

The rules file content is automatically included in every system prompt — both chat and agent mode. Use it to define:

- Coding standards and conventions
- Preferred libraries and frameworks
- Architecture guidelines
- Language-specific instructions
- Any custom rules for AI behavior in your project

**Example `.codeep/rules.md`:**
```markdown
## Code Style
- Use 2 spaces for indentation
- Prefer arrow functions
- Always use TypeScript strict mode

## Architecture
- Follow MVC pattern
- Keep controllers thin, logic in services
- All API responses use the ApiResponse wrapper

## Libraries
- Use Zod for validation
- Use date-fns instead of moment.js
```

Rules are loaded automatically when Codeep starts — no commands needed.

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

### Project Intelligence (`/init`, `/scan`)

Initialize a project and scan it once to cache deep analysis for faster AI responses:

```
/init          # Initialize project — creates .codeep/ folder
/scan          # Full project scan - analyzes structure, dependencies, patterns
/scan status   # Show last scan info (age, file count, project type)
/scan clear    # Clear cached intelligence
/memory <note>        # Add a custom note to project intelligence
/memory list          # Show all notes with indices
/memory remove <n>    # Remove note by index
/memory clear         # Clear all notes
```

**What gets analyzed and cached:**

| Category | Information |
|----------|-------------|
| **Structure** | File count, directory tree, language distribution (respects `.gitignore`) |
| **Dependencies** | Runtime & dev dependencies, detected frameworks |
| **Architecture** | Patterns (MVC, Component-based), main modules, entry points |
| **Scripts** | Available npm/composer/make scripts |
| **Conventions** | Indentation style, quotes, semicolons, naming conventions |
| **Testing** | Test framework, test directory location |
| **DevOps** | CI/CD system (GitHub Actions, GitLab CI, CircleCI, Azure, Travis, Jenkins, Drone), containerization (Docker, docker-compose, Kubernetes, Helm), monorepo tooling (Turborepo, Nx, Lerna, pnpm/Yarn workspaces, Rush) |

**Benefits:**
- AI understands your project deeply without re-analyzing each time
- Faster responses - no need to scan files repeatedly  
- Consistent context across sessions
- Framework-aware suggestions (React, Vue, Express, Django, etc.)

You can also add your own notes to the project intelligence with `/memory`:

```
/memory Always use pnpm, never npm
/memory Main entry point is src/renderer/main.ts
/memory Database migrations are in db/migrations/
```

Notes are included in every AI and agent conversation for this project.

**Storage:** `.codeep/intelligence.json` (project-local)

**Example output:**
```
# Project: my-app
Type: TypeScript/Node.js

## Structure
- 156 files, 24 directories
- Languages: TypeScript React (89), TypeScript (45), JSON (12)
- Main directories: src, components, utils, hooks

## Frameworks
React, Next.js

## Architecture
Patterns: Component-based, File-based routing
Main modules: src, components, hooks, utils

## Available Scripts
- dev: next dev
- build: next build
- test: vitest

## Code Conventions
- Indentation: spaces
- Quotes: single
- Semicolons: no
- Naming: camelCase

## DevOps
- CI/CD: GitHub Actions
- Containerization: Docker, docker-compose
- Monorepo: Turborepo
```

### Self-Verification (Optional)
When enabled in Settings, the agent can automatically verify its changes by running build, tests, or type checking after completing a task. Disabled by default — the agent works freely and you decide when to verify.

Configure in **Settings → Agent Auto-Verify**:
- **Off** (default) — no automatic verification
- **Build only** — checks compilation after changes
- **Typecheck only** — runs TypeScript/PHP type checking
- **Test only** — runs test suite after changes
- **Build + Typecheck + Test** — full verification

If errors are found, the agent tries to fix them automatically (up to 3 attempts, configurable).

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
- Configurable confirmation per tool — choose which agent actions require approval via `/settings`

## Codeep Dashboard

Link your CLI to [codeep.dev](https://codeep.dev/dashboard) for a personal web dashboard with session stats, project tracking, task management, and API key sync.

```bash
codeep account   # Opens browser → sign in with GitHub → CLI is linked
```

### Dashboard features

- **Usage stats** — total sessions, active this week, model/provider breakdown, token usage, estimated cost per model, 30-day trend
- **Projects** — all projects Codeep was used in, with language tag and git indicator
- **Project archiving** — hide projects from the list with one click
- **Tasks** — create/complete bug, feature, and task items from the web or directly from the CLI with `/tasks add` and `/tasks done`
- **API key sync** — store provider keys securely on codeep.dev, sync to any machine in one command
- **Connected devices** — see all machines linked to your account (hostname, last seen), revoke access per device

### API key sync

Add keys once on the dashboard, then sync them to any machine:

```bash
codeep account sync   # Pull keys from codeep.dev → local config
codeep account push   # Push local keys → codeep.dev
```

Keys are encrypted at rest using AES-256-GCM.

### Tasks

Create, view, and complete tasks directly from the CLI — or manage them on the codeep.dev dashboard:

```
> /tasks                    # List pending tasks for current project (numbered)
> /tasks add Fix login bug  # Create a new task on the dashboard
> /tasks done 2             # Mark task #2 as done
> /tasks delete 2           # Delete task #2 permanently
```

Tasks are loaded into the agent context so the AI sees them automatically on the next message.

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
| `/exit` or `/quit` | Quit application |

### AI Configuration

| Command | Description |
|---------|-------------|
| `/provider` | Switch AI provider |
| `/model` | Switch AI model |
| `/model <name>` | Load a saved profile shortcut (e.g. `/model fast`) |
| `/protocol` | Switch API protocol (OpenAI/Anthropic) |
| `/lang` | Set response language (12 languages supported) |
| `/settings` | Adjust temperature, max tokens, timeout, rate limits |
| `/profile save <name>` | Save current provider+model as a named profile |
| `/profile load <name>` | Load a saved profile |
| `/profile <name>` | Shorthand for `/profile load <name>` |
| `/profile list` | List all saved profiles |
| `/profile delete <name>` | Delete a saved profile |
| `/cost` `/stats` | Show session token usage and estimated API cost per model |

**Model favorites** — save provider+model combos and switch instantly:
```
> /provider      # switch to z.ai
> /model glm-5.1
> /profile save fast

> /provider      # switch to openai
> /model gpt-4.1
> /profile save work

> /model fast    # instantly switch to z.ai / glm-5.1
> /model work    # instantly switch to openai / gpt-4.1
```

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
| `/paste` | Paste content from clipboard into chat |
| `/add <path>` | Add file(s) to conversation context |
| `/drop [path]` | Remove file (or all) from context |
| `/multiline` | Toggle multi-line input mode |

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
| `/settings` | Configure confirmation mode and which tools require approval |

**Confirmation mode** (set via `/settings → Agent Confirmation`):

| Mode | Behavior |
|------|----------|
| `dangerous` (default) | Ask before configurable dangerous tools |
| `always` | Ask before every action |
| `never` | Execute without asking |

In `dangerous` mode, configure which tools require confirmation via `/settings`:
- **Confirm: delete_file** — ON by default
- **Confirm: execute_command** — ON by default
- **Confirm: write_file / edit_file** — OFF by default

### Git Integration

| Command | Description |
|---------|-------------|
| `/diff` | Review unstaged git changes |
| `/diff --staged` | Review staged git changes |
| `/commit` | Generate commit message for staged changes |
| `/git-commit [msg]` | Commit current changes with message |
| `/push` | Push to remote repository |
| `/pull` | Pull from remote repository |

### Context Persistence

| Command | Description |
|---------|-------------|
| `/context-save` | Save current conversation for later |
| `/context-load` | Load previously saved conversation |
| `/context-clear` | Clear saved context for this project |

### Code Review & Learning

| Command | Description |
|---------|-------------|
| `/review` | AI code review of unstaged git diff |
| `/review --staged` | AI code review of staged changes |
| `/review --static` | Static regex analysis with score (0-100) |
| `/learn` | Learn preferences from project files |
| `/learn status` | Show learned preferences |
| `/learn rule <text>` | Add a custom coding rule |

### Project Intelligence

| Command | Description |
|---------|-------------|
| `/init` | Initialize project (creates `.codeep/` folder) |
| `/scan` | Scan project and cache intelligence for AI |
| `/scan status` | Show last scan info |
| `/scan clear` | Clear cached intelligence |
| `/memory <note>` | Add a custom note to project intelligence |
| `/memory list` | Show all notes with indices |
| `/memory remove <n>` | Remove note by index |
| `/memory clear` | Clear all notes |
| `/model pull <name>` | Pull an Ollama model (local Ollama only) |

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

### Cloud Dashboard

| Command | Description |
|---------|-------------|
| `/tasks` | List pending tasks for current project (numbered) |
| `/tasks add <title>` | Create a new task on the dashboard |
| `/tasks done <n>` | Mark task #n as done |
| `/tasks delete <n>` | Delete task #n permanently |

**CLI commands (outside chat):**

| Command | Description |
|---------|-------------|
| `codeep account` | Link CLI to codeep.dev (GitHub OAuth) |
| `codeep account sync` | Pull API keys from codeep.dev → local config |
| `codeep account push` | Push local API keys → codeep.dev |

### Authentication

| Command | Description |
|---------|-------------|
| `/login` | Login with API key |
| `/logout` | Logout (choose which provider) |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit message |
| `↑` / `↓` | Navigate input history (or scroll chat when input is empty) |
| `Ctrl+L` | Clear chat (same as `/clear`) |
| `Ctrl+V` | Paste from clipboard with preview |
| `Ctrl+A` | Move cursor to beginning of line |
| `Ctrl+E` | Move cursor to end of line |
| `Ctrl+U` | Clear input line |
| `Ctrl+W` | Delete word backward |
| `Ctrl+K` | Delete to end of line |
| `Alt+F` / `Opt+F` | Move cursor forward one word |
| `Alt+B` / `Opt+B` | Move cursor backward one word |
| `Alt+D` / `Opt+D` | Delete word forward |
| `PageUp` / `PageDown` | Scroll chat history (10 lines) |
| `Mouse Scroll` | Scroll chat history |
| `Escape` | Cancel current request / Stop agent |

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
| `ZAI_API_KEY` | Z.AI (international) API key |
| `ZAI_CN_API_KEY` | Z.AI China API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GOOGLE_API_KEY` | Google AI (Gemini) API key |
| `MINIMAX_API_KEY` | MiniMax (international) API key |
| `MINIMAX_CN_API_KEY` | MiniMax China API key |

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
| Agent Max Iterations | 50 | Maximum agent iterations (10-500). Modern models finish typical tasks in 3–8 iterations — raise for large autonomous refactors. |
| Agent Confirmation | Dangerous | `Never`, `Dangerous` (default), or `Always` |
| Agent Auto-Commit | Off | Automatically commit after agent completes |
| Agent Branch | Off | Create new branch for agent commits |
| Agent Auto-Verify | Off | `Off`, `Build only`, `Typecheck only`, `Test only`, or `Build + Typecheck + Test` |
| Agent Max Fix Attempts | 1 | Max attempts to auto-fix errors when Auto-Verify is enabled. More than 1 usually means the agent is stuck — bail and let the user decide. |

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

- **Custom ANSI Renderer** - Hand-built terminal UI with virtual screen buffer, diff-based rendering, and syntax highlighting (no React/Ink dependency)
- **TypeScript** - Type-safe codebase
- **Conf** - Configuration management
- **Node.js Keychain** - Secure credential storage

## License

Apache 2.0

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on [GitHub](https://github.com/VladoIvankovic/Codeep).

## Support

- **Issues**: [GitHub Issues](https://github.com/VladoIvankovic/Codeep/issues)

## Zed Editor Integration (ACP)

Codeep supports the [Agent Client Protocol (ACP)](https://agentclientprotocol.com), letting you use it as an AI coding agent directly inside [Zed](https://zed.dev).

### Setup

1. Install Codeep globally:

```bash
npm install -g codeep
```

2. Add to your Zed `settings.json`:

```json
"agent_servers": {
  "Codeep": {
    "type": "custom",
    "command": "codeep",
    "args": ["acp"]
  }
}
```

3. Make sure your API key is set in the environment Zed uses:

```bash
export DEEPSEEK_API_KEY=your_key   # or whichever provider
```

4. Open Zed's AI panel and select **Codeep** as the agent.

### Configurable permissions (Zed & VS Code extension)

Via the agent settings panel you can toggle which tools ask for approval before running — same controls available in the TUI via `/settings`:

- **Confirm: delete_file** — ON by default
- **Confirm: execute_command** — ON by default
- **Confirm: write_file / edit_file** — OFF by default

These apply in `Dangerous` confirmation mode (the default). Choose `Always` to confirm every action, or `Never` to skip all prompts.

### ACP capabilities

Codeep advertises the following [ACP](https://agentclientprotocol.com) capabilities so Zed (and other ACP clients) can use them:

- **`promptCapabilities.image`** — paste/drag images into chat for vision analysis.
- **`promptCapabilities.embeddedContext`** — drag a file or pin a code selection into the chat and the actual file content is injected into the prompt (resource & resource_link blocks, 200 KB cap per file).
- **`sessionCapabilities.list`** — exposes saved CLI sessions to ACP clients.
- **`sessionCapabilities.resume`** — instant reconnect on panel reload without replaying history.
- **`loadSession`** — restore a previous session by id.

Codeep also reads `clientCapabilities.terminal` from the client and routes shell commands through the editor's terminal when supported (so you see them in Zed's terminal panel), falling back to local execution otherwise.

### Loading CLI sessions in Zed

Zed's left sidebar shows only sessions Zed itself created (one per "New Thread") — it does **not** auto-list sessions you saved from the CLI or from a previous Zed window. Two ways to access those:

**Inside the chat (recommended):**

```
/sessions                    # show all saved sessions for this workspace
/session load <name>         # restore one
```

When you open a fresh chat in Zed, Codeep also shows you the most recent CLI sessions for that project right in the welcome message, so you can switch with one command.

**Via Zed's import modal:**

Open Zed's command palette (`Cmd+Shift+P`) and search for **"Import Threads"**. Codeep's saved sessions appear there as an importable list — once imported they show up in Zed's regular sidebar.

## VS Code Extension

Install **Codeep** from the VS Code marketplace. The extension is a thin UI around the CLI — all credentials and sessions live in the CLI's config (`~/.config/codeep/config.json`), so keys set anywhere are visible everywhere.

### Set API keys without leaving VS Code

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

- **`Codeep: Set API Key`** — pick a provider, paste the key, done. Writes into the CLI config, so running `codeep` in a terminal immediately sees the new key.
- **`Codeep: Open Chat`** — open the Codeep sidebar.
- **`Codeep: Review Current File`** — run `/review <file>` on the active editor.
- **`Codeep: New Session`** — start a fresh session in the chat.

If you already set up keys in the CLI (or via the [codeep.dev](https://codeep.dev/dashboard) dashboard + `codeep account sync`), the extension picks them up automatically on first launch — no welcome prompt.

### Live plan & reasoning stream

The chat sidebar now surfaces two extra ACP signals that previously only the TUI saw:

- **Live plan** — for multi-step tasks the agent's plan appears as a small green card with status icons (`○` pending, `◐` in progress, `●` done) that update in place as work progresses.
- **Reasoning stream** — when the model exposes a thinking trace (e.g. Claude extended thinking, GPT-5 reasoning), it shows up in a collapsible "Thinking" card above the answer. Closed by default; click to expand.
- **Diff preview on permission prompts** — manual-mode permission cards now show a `-` / `+` diff for `edit_file`, a content preview for `write_file`, and the full `$ command` + `cwd` for `execute_command`, so users can verify before clicking *Allow*. Payload is truncated (~4 KB per field, 200 lines per file) with a visible marker. Other ACP clients (Zed, etc.) ignore the extra fields silently.
- **`@file` mentions** — type `@` in the chat input to open a workspace-wide file picker. Pick with arrow keys + Enter; the file's content is inlined into the prompt as an `[Attached files]` preamble. Files over 200 KB are skipped with a marker. Multiple mentions in one message are deduplicated.
- **Auto-reconnect** — if the CLI process exits unexpectedly (crash, OOM kill, parent restart), the extension reconnects on its own with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s, capped at 6 attempts). The status bar shows the countdown. Configurable idle-watchdog timeout (`codeep.requestTimeoutMinutes`, default 5 min) replaces the old fixed cap so slow reasoning models don't get killed mid-thought.
