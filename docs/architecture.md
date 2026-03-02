# Architecture

ghclaw is a local middle manager AI that bridges Telegram to GitHub Copilot CLI's full agent ecosystem. It runs entirely on your machine with all connections outbound — no exposed ports, no webhooks.

## System Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Your Machine (all connections outbound)                                   │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  ghclaw daemon                                                      │  │
│  │                                                                      │  │
│  │  ┌──────────────┐    ┌──────────────────────────────────────────┐   │  │
│  │  │   Channel     │───▶│  Security Layer                          │   │  │
│  │  │   Interface   │    │  - User allowlist                        │   │  │
│  │  │              │    │  - Group restriction                     │   │  │
│  │  │  Telegram     │    │  - DM blocking                           │   │  │
│  │  │  (polling)    │    │  - Secret prefix                        │   │  │
│  │  │              │    │  - Topic restriction                     │   │  │
│  │  │  Future:      │    └──────────────────────────────────────────┘   │  │
│  │  │  Discord      │                     │                             │  │
│  │  │  Slack        │                     ▼                             │  │
│  │  │  CLI          │    ┌──────────────────────────────────────────┐   │  │
│  │  └──────────────┘    │  Middle Manager Intelligence             │   │  │
│  │                      │  - Understand user intent                │   │  │
│  │                      │  - Pick best model for task              │   │  │
│  │                      │  - Delegate to agents (/delegate /fleet) │   │  │
│  │                      │  - Route to correct machine              │   │  │
│  │                      └──────────────────────────────────────────┘   │  │
│  │                                   │                                  │  │
│  │                                   ▼                                  │  │
│  │  ┌──────────────────────────────────────────────────────────────┐   │  │
│  │  │  Session Mapper        │  Copilot CLI                        │   │  │
│  │  │  sessions.sqlite       │  copilot --resume <id> -p "prompt"  │   │  │
│  │  │                        │                                     │   │  │
│  │  │  chat_id,thread_id     │  Features:                          │   │  │
│  │  │    → session UUID      │  - /delegate (background agents)    │   │  │
│  │  │    → machine_id        │  - /fleet (parallel agents)         │   │  │
│  │  │                        │  - /plan, /compact, /research       │   │  │
│  │  │                        │  - web_search, code editing, shell  │   │  │
│  │  │                        │                                     │   │  │
│  │  │                        │  Chronicle (memory):                │   │  │
│  │  │                        │  ~/.copilot/session-state/          │   │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  │                                   │                                  │  │
│  │                                   ▼                                  │  │
│  │  ┌──────────────┐    ┌──────────────────────────────────┐          │  │
│  │  │  Streaming   │──▶ │  Channel.send() / Channel.edit() │          │  │
│  │  │  Response    │    └──────────────────────────────────┘          │  │
│  │  └──────────────┘                                                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌───────────────────┐    ┌────────────────────────────┐                  │
│  │  OS Keychain       │    │  GitHub Sync               │                  │
│  │  - bot-token       │    │  git pull/push every 5s    │                  │
│  │  - allowed-group   │    │  → {user}/.ghclaw repo    │                  │
│  │  - allowed-users   │    │  → workflows, memory, etc  │                  │
│  └───────────────────┘    └────────────────────────────┘                  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Channel Abstraction

**Why:** ghclaw should work with any messaging platform, not just Telegram.

**How:** A `Channel` interface defines the contract:

```typescript
interface Channel {
  getInfo(): Promise<ChannelInfo>;      // Capabilities (threading, editing, max length)
  poll(timeout?: number): Promise<ChannelMessage[]>;  // Receive messages
  send(chatId, text, options?): Promise<SentMessage>;  // Send message
  edit(chatId, messageId, text): Promise<void>;        // Edit for streaming
  sendTyping(chatId): Promise<void>;                    // Activity indicator
  start(): Promise<void>;                               // Connect/verify
  stop(): Promise<void>;                                // Cleanup
}
```

**`TelegramChannel`** wraps the existing `TelegramClient`. The core daemon logic works with `Channel` and `ChannelMessage`, not Telegram-specific types.

**Future channels** implement the same interface. The `streamToChannel()` helper works with any `Channel` that supports editing.

### 2. GitHub as Backbone

**Why:** Cross-machine state requires a shared store. GitHub provides:
- Private repos for data
- Actions for compute (reminders, schedules)
- Issues for Copilot Coding Agent
- Secrets for credentials
- Already authenticated via `gh` CLI

**How:** A private repo `{user}/.ghclaw` stores:
- `memory/sessions.json` — exported session data
- `memory/machines/{id}.json` — per-machine snapshots
- `.github/workflows/remind-*.yml` — one-shot reminder workflows
- `.github/workflows/sched-*.yml` — persistent schedule workflows
- `.github/workflows/notify.yml` — base Telegram notification workflow

Sync loop runs every 5 seconds: `git pull → export → commit/push if changed`.

### 3. Middle Manager Intelligence

**Why:** A bot that just forwards messages to Copilot CLI wastes its potential. ghclaw should understand what the user needs and pick the best approach.

**How:** The system prompt instructs Copilot CLI to:
- Pick the right model (fast for simple tasks, powerful for complex)
- Use `/delegate` for background coding work
- Use `/fleet` for parallel multi-file changes
- Enter `/plan` mode for complex tasks
- Suggest `/remind` and `/schedule` for recurring needs
- Create GitHub Issues for Copilot Coding Agent tasks

### 4. Polling, Not Webhooks

**Why:** Webhooks require exposing a public endpoint (firewall, HTTPS, security).

**How:** Long-poll Telegram's `getUpdates` API. All connections outbound.

### 5. Delegate Memory to Copilot CLI

**Why:** Copilot CLI's Chronicle already manages sessions, turns, checkpoints, and context compaction.

**How:** ghclaw only stores a minimal mapping:
```
Telegram (chat_id, thread_id) → Copilot session UUID + machine_id
```

### 6. OS Keychain for Secrets

**Why:** Environment variables and `.env` files leak easily.

**How:** Native OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager). Fallback to env vars only when keychain unavailable.

## Data Flow

### Message Processing

```
1. Channel.poll()
   └─▶ Telegram getUpdates (long polling, 30s timeout)

2. Security Check (BEFORE any logging)
   ├─▶ User allowlist
   ├─▶ Group restriction
   ├─▶ DM blocking
   ├─▶ Secret prefix strip
   └─▶ REJECT if any fails

3. Session Lookup
   ├─▶ getOrCreateSession(chatId, threadId)
   ├─▶ Check machine_id ownership
   └─▶ Wrong machine → redirect notice, STOP

4. Middle Manager Routing
   ├─▶ Build system prompt with discovered capabilities
   ├─▶ Include agent delegation instructions
   └─▶ Pass to Copilot CLI with best model

5. Copilot Execution
   ├─▶ copilot --resume <session-id> -p "prompt" --silent
   ├─▶ Stream stdout to response buffer
   └─▶ May invoke /delegate, /fleet, tools

6. Channel.send() / Channel.edit()
   ├─▶ Create message with typing cursor (▌)
   ├─▶ Edit as chunks arrive (300ms throttle)
   └─▶ Final edit with complete response

7. Session Update
   └─▶ Update last_activity and message_count
```

### GitHub Sync

```
Every 5 seconds:
  1. git pull --rebase (get changes from other machines)
  2. Export local sessions to memory/sessions.json
  3. Export machine info to memory/machines/{id}.json
  4. git add -A && git commit && git push (if changes)
```

### Reminder Flow

```
1. User: /remind tomorrow 9am deploy v2
2. ghclaw parses with NLP (Copilot CLI) or keyword fallback
3. Creates .github/workflows/remind-{id}.yml with cron schedule
4. git commit && push
5. GitHub Actions fires at scheduled time
6. Workflow sends Telegram message via bot token secret
7. Workflow self-deletes its own YAML file
```

## File Structure

```
~/.ghclaw/
├── config.json           # Non-secret config (machine identity, GitHub, copilot)
├── daemon.lock           # PID file when daemon running
├── daemon.log            # Daemon output
├── data/
│   └── sessions.sqlite   # Telegram → Copilot session mapping
└── repo/                 # Git clone of {user}/.ghclaw
    ├── memory/
    │   ├── sessions.json
    │   └── machines/
    ├── .github/workflows/
    │   ├── notify.yml
    │   ├── remind-*.yml
    │   └── sched-*.yml
    └── README.md

~/.copilot/
├── session-state/        # Chronicle: per-session directories
├── mcp-config.json       # MCP server configuration
└── copilot-instructions.md
```

## Source Structure

```
src/
├── channels/             # Channel abstraction layer
│   ├── channel.ts        # Channel interface, types, streamToChannel()
│   ├── telegram.ts       # TelegramChannel implements Channel
│   └── index.ts          # Barrel exports
├── telegram/
│   ├── client.ts         # Low-level Telegram API client
│   ├── security.ts       # Security checks (allowlist, group, DM, prefix)
│   └── commands.ts       # Bot command handlers (/sessions, /remind, etc.)
├── copilot/
│   ├── session.ts        # Copilot CLI execution (--resume, -p, streaming)
│   ├── discovery.ts      # Feature discovery (tools, commands, models, agents)
│   └── chronicle.ts      # Read Copilot CLI's Chronicle session data
├── github/
│   ├── auth.ts           # Centralized gh CLI auth, scope checking
│   ├── repo.ts           # Repo provisioning, git operations
│   ├── sync.ts           # Git sync loop (5s interval)
│   └── workflows.ts      # GitHub Actions YAML generation
├── schedules/
│   ├── parser.ts         # NLP schedule parsing via Copilot CLI
│   ├── reminders.ts      # Reminder CRUD (workflow files)
│   ├── recurring.ts      # Recurring schedule CRUD
│   └── agent.ts          # Copilot Coding Agent (GitHub Issues)
├── memory/
│   └── session-mapper.ts # SQLite session mapping
├── secrets/
│   └── keychain.ts       # OS keychain abstraction
├── config.ts             # Config loading (keychain + local file)
├── daemon.ts             # Main daemon (polling, processing, system prompt)
└── cli/
    ├── setup.ts          # Interactive setup wizard
    └── doctor.ts         # Health checks
```

## Multi-Machine Support

Multiple machines share the same Telegram group. Each machine:
- Gets a unique identity (UUID + hostname) on first run
- Creates topics tagged: `🤖 [MacBook] Fix auth bug`
- Owns its sessions via `machine_id` in the session mapper
- Syncs its data to `memory/machines/{id}.json` in the GitHub repo

### Soft Routing

All machines poll the same group. When a message arrives:
1. Look up session → check `machine_id`
2. **Match** → process normally
3. **Mismatch** → reply: "This session lives on [machine]. Resume there."
4. **New session** → claim it with current `machine_id`

## Security Model

See [Security](security.md) for the detailed security model.

Five layers:
1. **Network**: All outbound, no exposed ports
2. **Access Control**: User allowlist, group restriction, DM blocking, secret prefix, topic restriction
3. **Data**: Secrets in OS keychain, error messages sanitized, no logging before security check
4. **GitHub**: Private repo, repo-level secrets for Actions, `repo`+`workflow` scopes required
5. **Process**: Restrictive file permissions, clean error handling

## YOLO Mode

When enabled (`copilot.yoloMode: true`), passes `--allow-all-tools` to Copilot CLI:
- File system operations
- Shell command execution
- Web browsing
- All MCP tools

**Default: OFF.**
