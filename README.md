# ghclaw

Local AI middle manager powered by Copilot CLI. Bridges Telegram to GitHub's full agent ecosystem — delegates coding tasks, manages schedules, syncs memory across machines, all without exposing your machine to the internet.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/yaananth/ghclaw/main/install.sh | bash
```

Or manual:
```bash
git clone https://github.com/yaananth/ghclaw.git
cd ghclaw
bun install
bun link
```

## Quick Start

```bash
# Interactive setup — only asks for Telegram token + GitHub login
# Everything else auto-configures with strong security defaults
ghclaw setup

# Health check
ghclaw doctor

# Start the bot
ghclaw start
```

Setup flow:
1. Enter Telegram bot token (from @BotFather)
2. Auto-detect group and user from a message
3. GitHub CLI auto-login (if not authenticated)
4. Auto-create private sync repo (asks for org, defaults to your username)
5. Auto-set repo secrets and initialize structure
6. Done — start the bot

## What It Does

ghclaw acts as a **middle manager** between you and GitHub Copilot CLI's capabilities:

- **Understands your ask** and picks the best approach
- **Parallel agents** via `/fleet` for multi-file work
- **Deep research** via `/research` with GitHub search and web sources
- **Manages schedules** and reminders via GitHub Actions
- **Syncs memory** across machines through a private GitHub repo
- **Creates coding tasks** for Copilot Coding Agent via GitHub Issues

## Architecture

```
You (Telegram)                ghclaw (local)                    GitHub
┌──────────┐    poll     ┌─────────────────────┐    sync     ┌──────────────────┐
│ Message   │──────────► │ Security → Router    │──────────► │ {user}/.ghclaw   │
│ /remind   │            │     ↓                │            │ ├── memory/       │
│ /agent    │            │ Middle Manager       │            │ ├── workflows/    │
│ /delegate │            │ (picks model, tool,  │            │ └── README.md     │
│ chat...   │◄────────── │  or delegates)       │            │                    │
│ streaming │   stream   │     ↓                │    issue   │ GitHub Issues     │
└──────────┘            │ Copilot CLI          │──────────► │ → @copilot agent  │
                        │ --resume <session>   │            │                    │
                        └─────────────────────┘            └──────────────────┘
```

## Features

### Core
- **Telegram interface**: Forum topics, streaming responses, slash commands
- **Local-only**: All connections outbound (polling), no exposed ports
- **Copilot CLI powered**: Full access to `/delegate`, `/fleet`, tools, and models
- **Dynamic discovery**: Auto-discovers Copilot CLI capabilities at startup
- **Secure secrets**: OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret)

### GitHub Backbone
- **Cross-machine sync**: Private repo syncs sessions every 5 seconds
- **Reminders**: One-shot GitHub Actions workflows (self-delete after firing)
- **Recurring schedules**: Persistent cron workflows via GitHub Actions
- **Copilot Coding Agent**: Create GitHub Issues assigned to `@copilot`
- **Repo secrets**: Bot token and chat IDs stored as GitHub repo secrets

### Intelligence
- **Middle manager persona**: Understands tasks and delegates appropriately
- **Model routing**: Picks fast/balanced/powerful model per task
- **Agent delegation**: `/fleet` for parallel subagents, `/tasks` to manage them
- **Session continuity**: Each chat/topic maps to a Copilot CLI session (Chronicle)
- **Multi-machine**: Run on Mac + Codespace — sessions route to the right machine

### Telegram
- **Forum topics**: Auto-created per session, tagged with machine name
- **Streaming**: Live message updates with typing cursor
- **YOLO mode**: Optional full tool access (file editing, shell, web search)

## CLI Commands

### Setup & Configuration

| Command | Description |
|---------|-------------|
| `ghclaw setup` | Interactive setup (keychain + GitHub auto-config) |
| `ghclaw doctor` | Check dependencies, auth, security, GitHub |
| `ghclaw config` | Show configuration and paths |
| `ghclaw status` | Machine identity, sessions, connections |

### Daemon Control

| Command | Description |
|---------|-------------|
| `ghclaw start` | Start daemon (background by default) |
| `ghclaw start -f` | Foreground mode (debugging) |
| `ghclaw stop` | Stop running daemon |
| `ghclaw restart` | Stop and restart daemon |
| `ghclaw upgrade` | Pull latest, install deps, run doctor, restart |
| `ghclaw logs -f` | Follow log output |
| `ghclaw sync-logs` | Show GitHub sync activity |

### Secrets

| Command | Description |
|---------|-------------|
| `ghclaw secrets list` | List stored secret keys |
| `ghclaw secrets set <key> <value>` | Store a secret |
| `ghclaw secrets get <key>` | Retrieve a secret |
| `ghclaw secrets delete <key>` | Delete a secret |

### GitHub

| Command | Description |
|---------|-------------|
| `ghclaw github status` | Repo, sync state, reminders, schedules |
| `ghclaw github sync` | Force sync now |
| `ghclaw github open` | Open sync repo in browser |

### Telegram Utilities

| Command | Description |
|---------|-------------|
| `ghclaw detect-group` | Auto-detect and save group/user IDs |
| `ghclaw clean-topics` | Delete bot-created topics |
| `ghclaw discover` | Show Copilot CLI capabilities |

### Memory

| Command | Description |
|---------|-------------|
| `ghclaw memory stats` | Session statistics |
| `ghclaw memory sessions` | Active sessions with resume commands |
| `ghclaw memory archive` | Archive inactive sessions |

## Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | How to use ghclaw |
| `/new` | Start a fresh session |

All other interactions are **natural language** — just say what you want:

### Natural Language Examples

| What you say | What ghclaw does |
|-------------|-----------------|
| "remind me tomorrow 9am to deploy v2" | Creates a one-shot GitHub Actions workflow (self-deletes) |
| "every Monday 9am check PRs" | Creates a recurring cron workflow |
| "fix the login bug in owner/repo" | Creates a Copilot Coding Agent task |
| "show my sessions" | Lists recent Copilot CLI sessions |
| "what's the sync status?" | Shows GitHub sync info |
| "show my reminders" | Lists active reminders |
| "cancel reminder abc123" | Cancels a specific reminder |
| "hello, how does this work?" | General chat via Copilot CLI |

## How It Works

### Middle Manager

ghclaw doesn't just forward messages — it understands them:

1. **Simple question** → Answers directly with the right model
2. **Coding task** → Creates a Copilot Coding Agent task via API (creates PR autonomously)
3. **Multi-file change** → Uses `/fleet` for parallel agents
4. **Research request** → Uses `/research` for deep investigation
5. **Complex task** → Enters `/plan` mode first
6. **Reminder** → Creates self-deleting GitHub Actions workflow
7. **Recurring schedule** → Creates cron GitHub Actions workflow
8. **Agentic schedule** → Creates gh-aw workflow (LLM agent on schedule)

All routing is LLM-driven — no intent classifier. The system prompt in `instructions.md` describes available actions, and the LLM outputs structured action blocks when needed.

### GitHub as Backbone

```
Local Machine                          GitHub
┌─────────────┐    git pull/push     ┌──────────────────────┐
│ SQLite (fast)│ ←────every 5s─────→ │ {user}/.ghclaw      │
│ sessions.db  │                     │ ├── memory/           │
│              │                     │ │   ├── sessions.json │
│ config.json  │                     │ │   └── machines/     │
│ daemon       │                     │ ├── .github/workflows/│
│              │                     │ │   ├── notify.yml    │
│              │                     │ │   ├── remind-*.yml  │
│              │                     │ │   └── sched-*.yml   │
│              │                     │ └── README.md         │
└─────────────┘                     └──────────────────────┘
```

### Copilot CLI Features Used

| Feature | How ghclaw Uses It |
|---------|---------------------|
| `--resume <id>` | Continue same session across messages |
| `-p "prompt"` | Non-interactive mode |
| `--silent` | Clean stdout for streaming |
| `--model <name>` | Model routing per task |
| `--allow-all-tools` | YOLO mode |
| `/fleet` | Parallel subagent execution |
| `/plan` | Planning mode for complex tasks |
| `/research` | Deep research with GitHub search and web |
| `/tasks` | View and manage background subagents |
| Chronicle | All session history and context |
| Feature discovery | Self-reports tools, commands, models |

## Security

Five layers of protection:

1. **Group-only mode**: Restrict to specific groups
2. **User allowlist**: Only specific user IDs
3. **Block DMs**: No private messages
4. **Secret prefix**: Require phrase in messages
5. **Topic restriction**: Limit to specific forum topics

Secrets in OS keychain. GitHub repo secrets for Actions workflows. All connections outbound.

## Configuration

`~/.ghclaw/config.json`:

```json
{
  "telegram": {
    "blockPrivateMessages": true,
    "pollIntervalMs": 1000,
    "pollTimeoutSeconds": 30
  },
  "copilot": {
    "yoloMode": false,
    "defaultModel": "claude-sonnet-4.6"
  },
  "machine": {
    "id": "auto-generated-uuid",
    "name": "MacBook"
  },
  "github": {
    "enabled": true,
    "username": "yaananth",
    "repoName": ".ghclaw",
    "syncIntervalMs": 5000,
    "syncEnabled": true
  }
}
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, GitHub backbone, security layers, multi-machine |
| [Memory & Sessions](docs/memory-and-sessions.md) | Three-tier memory, Chronicle, GitHub sync, agent delegation |
| [Secrets](docs/secrets.md) | OS keychain, GitHub repo secrets, storage locations |
| [Security](docs/security.md) | Threat model, 5 security layers, comparison, incident response |

## Requirements

- macOS (primary), Linux, or Windows
- [Bun](https://bun.sh)
- [Copilot CLI](https://githubnext.com/projects/copilot-cli) (`copilot` command)
- [GitHub CLI](https://cli.github.com) (authenticated with `repo` + `workflow` scopes)

## License

MIT
