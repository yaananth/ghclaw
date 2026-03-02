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
│  │  │   Telegram     │───▶│  Security Layer                          │   │  │
│  │  │   Client       │    │  - User allowlist (fail-closed)          │   │  │
│  │  │   (polling)    │    │  - Group restriction                     │   │  │
│  │  │               │    │  - DM blocking                           │   │  │
│  │  │               │    │  - Secret prefix                        │   │  │
│  │  │               │    │  - Topic restriction                     │   │  │
│  │  └──────────────┘    └──────────────────────────────────────────┘   │  │
│  │                                   │                                  │  │
│  │                                   ▼                                  │  │
│  │                      ┌──────────────────────────────────────────┐   │  │
│  │                      │  👀 Acknowledge → Copilot CLI Execution   │   │  │
│  │                      │                                          │   │  │
│  │                      │  LLM-Driven Routing (natural language): │   │  │
│  │                      │  - LLM responds naturally to user        │   │  │
│  │                      │  - Emits json:ghclaw-action blocks       │   │  │
│  │                      │  - daemon parses + executes actions      │   │  │
│  │                      └──────────────────────────────────────────┘   │  │
│  │                                   │                                  │  │
│  │                      ┌────────────┼────────────────┐                │  │
│  │                      ▼            ▼                ▼                │  │
│  │  ┌──────────────┐  ┌──────────┐  ┌──────────────────────┐         │  │
│  │  │ Action        │  │ Copilot  │  │ Copilot Coding Agent │         │  │
│  │  │ Handlers      │  │ CLI      │  │ (Enterprise API)     │         │  │
│  │  │               │  │          │  │                      │         │  │
│  │  │ - Reminders   │  │ --resume │  │ Creates tasks →      │         │  │
│  │  │ - Schedules   │  │ -p       │  │ autonomous PRs       │         │  │
│  │  │ - Sessions    │  │ --silent │  │                      │         │  │
│  │  │ - gh-aw       │  │ /fleet   │  │ gh-aw for scheduled  │         │  │
│  │  │ - Status      │  │ /plan    │  │ agentic workflows    │         │  │
│  │  └──────────────┘  └──────────┘  └──────────────────────┘         │  │
│  │                                   │                                  │  │
│  │                                   ▼                                  │  │
│  │  ┌──────────────┐    ┌──────────────────────────────────┐          │  │
│  │  │  Streaming    │──▶ │  Telegram: send / edit messages   │          │  │
│  │  │  Response     │    │  (action blocks hidden from user) │          │  │
│  │  └──────────────┘    └──────────────────────────────────┘          │  │
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

### 1. LLM-Driven Natural Language Routing

**Why:** Slash commands force users to memorize syntax. Natural language is more flexible. Three minimal commands remain (`/start`, `/help`, `/new`) for Telegram UI integration.

**How:** The system prompt (`instructions.md`) describes available actions using a structured `json:ghclaw-action` block format. The LLM decides what action to take and emits a fenced code block:

```
User: "remind me tomorrow at 9am to deploy v2"

LLM response:
"Setting a reminder for tomorrow at 9am to deploy v2."

```json:ghclaw-action
{"action": "create_reminder", "message": "deploy v2", "schedule": "tomorrow 9am EST"}
```
```

The daemon:
1. Streams the LLM response to Telegram (hiding action blocks from display)
2. Parses action blocks from the full response text
3. Validates actions against a strict schema (allowlisted action types + fields)
4. Executes validated actions via handlers
5. Sends action results as follow-up messages

**14 action types:** `create_reminder`, `list_reminders`, `cancel_reminder`, `create_schedule`, `list_schedules`, `cancel_schedule`, `create_coding_task`, `create_agentic_schedule`, `list_sessions`, `search_sessions`, `resume_session`, `new_session`, `show_status`, `show_github_status`.

### 2. GitHub as Backbone

**Why:** Cross-machine state requires a shared store. GitHub provides:
- Private repos for data
- Actions for compute (reminders, schedules)
- Copilot Coding Agent for autonomous PRs
- Secrets for credentials
- Already authenticated via `gh` CLI

**How:** A private repo `{user}/.ghclaw` stores:
- `memory/sessions.json` — exported session data
- `memory/machines/{id}.json` — per-machine snapshots
- `.github/workflows/remind-*.yml` — one-shot reminder workflows
- `.github/workflows/sched-*.yml` — persistent schedule workflows
- `.github/workflows/notify.yml` — base Telegram notification workflow

Sync loop runs every 5 seconds: `git pull → export → commit/push if changed`.

### 3. Copilot Coding Agent (Enterprise API)

**Why:** Some coding tasks are best handled autonomously (create PR without local compute).

**How:** `src/copilot/agent.ts` calls `https://api.enterprise.githubcopilot.com`:
- `POST /agents/repos/{owner}/{repo}/tasks` — create task
- `GET /agents/repos/{owner}/{repo}/tasks/{taskID}` — poll status
- Auth: `Bearer {gh_token}` + `Copilot-Integration-Id: vscode-chat`
- Owner/repo validated against GitHub's character rules before URL construction

### 4. gh-aw (Agentic Workflows)

**Why:** Recurring tasks that need LLM capabilities (e.g., "every Monday review open PRs").

**How:** `src/ghaw/executor.ts` wraps the `gh aw` CLI extension:
- `ghAwNew(repoPath, name)` — create workflow markdown
- `ghAwCompile(repoPath)` — compile to Actions YAML
- Uses `Bun.spawn` with argv arrays (no shell interpolation)
- Workflow names validated (alphanumeric + hyphens only)

### 5. Polling, Not Webhooks

**Why:** Webhooks require exposing a public endpoint (firewall, HTTPS, security).

**How:** Long-poll Telegram's `getUpdates` API. All connections outbound.

### 6. Delegate Memory to Copilot CLI

**Why:** Copilot CLI's Chronicle already manages sessions, turns, checkpoints, and context compaction.

**How:** ghclaw only stores a minimal mapping:
```
Telegram (chat_id, thread_id) → Copilot session UUID + machine_id
```

### 7. OS Keychain for Secrets

**Why:** Environment variables and `.env` files leak easily.

**How:** Native OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager). Fallback to env vars only when keychain unavailable.

### 8. Message Acknowledgment

**Why:** Users need immediate feedback that ghclaw received their message.

**How:** 👀 emoji reaction via Telegram's `setMessageReaction` API on receipt. Cleared after response is sent. Best-effort (non-blocking).

## Data Flow

### Message Processing

```
1. Telegram long-poll (getUpdates, 30s timeout)

2. Security Check (BEFORE any logging)
   ├─▶ Fail-closed: reject if no access controls configured
   ├─▶ Group restriction
   ├─▶ User allowlist
   ├─▶ DM blocking
   ├─▶ Secret prefix strip
   └─▶ Topic restriction
   → REJECT if any fails (no content logged for rejected messages)

3. Acknowledge receipt (👀 reaction)

4. Check /start, /help, /new commands (only 3 registered)

5. Check session selection (number reply after session list)

6. Session Lookup
   ├─▶ getOrCreateSession(chatId, threadId)
   ├─▶ Check machine_id ownership
   └─▶ Wrong machine → redirect notice, STOP

7. Auto-create forum topic (if in main chat of forum group)
   └─▶ AI-generated topic title (background)

8. Build system prompt
   ├─▶ Load instructions.md (action block format + available actions)
   └─▶ Append Copilot CLI discovered capabilities

9. Copilot CLI Execution
   ├─▶ copilot --resume <session-id> -p "prompt" --silent
   └─▶ Stream stdout via streamToTelegramCollecting()

10. Stream to Telegram
    ├─▶ Create message with typing cursor (▌)
    ├─▶ Edit as chunks arrive (300ms throttle)
    ├─▶ Hide json:ghclaw-action blocks from display
    └─▶ Final edit with complete response

11. Parse + Execute Actions
    ├─▶ parseActionBlocks(fullText) → extract action JSON
    ├─▶ Validate against schema (allowlisted types + fields)
    └─▶ executeAction() → handler result sent as follow-up

12. Clear 👀 reaction
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
1. User: "remind me tomorrow 9am to deploy v2"
2. LLM outputs: conversational response + json:ghclaw-action block
3. daemon parses action: {action: "create_reminder", message: "deploy v2", schedule: "tomorrow 9am EST"}
4. Handler parses schedule via Copilot CLI NLP → cron expression
5. Creates .github/workflows/remind-{id}.yml
6. git commit && push
7. GitHub Actions fires at scheduled time
8. Workflow sends Telegram message via bot token secret
9. Workflow self-deletes its own YAML file
```

## File Structure

```
~/.ghclaw/
├── config.json           # Non-secret config (machine identity, GitHub, copilot)
├── daemon.lock           # PID file when daemon running
├── daemon.log            # Daemon output
├── data/
│   └── sessions.sqlite   # Telegram → Copilot session mapping + synced Chronicle IDs
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
├── actions/              # LLM action block system
│   ├── types.ts          # 14 action types with typed payloads
│   ├── parser.ts         # Regex extraction + JSON parsing + schema validation
│   ├── handlers.ts       # Action dispatch + per-action handlers
│   └── index.ts          # Barrel exports
├── channels/             # Channel abstraction (unused — daemon uses TelegramClient directly)
│   ├── channel.ts        # Channel interface, types, streamToChannel()
│   ├── telegram.ts       # TelegramChannel implements Channel
│   └── index.ts          # Barrel exports
├── telegram/
│   ├── client.ts         # Low-level Telegram API client (send, edit, react, topics)
│   ├── security.ts       # Security checks (fail-closed, allowlist, group, DM, prefix, topic)
│   └── commands.ts       # Minimal command handlers (/start, /help, /new only)
├── copilot/
│   ├── session.ts        # Copilot CLI execution (--resume, -p, streaming)
│   ├── discovery.ts      # Feature discovery (tools, commands, models, agents)
│   ├── chronicle.ts      # Read Copilot CLI's Chronicle session data
│   └── agent.ts          # Copilot Coding Agent enterprise API client
├── ghaw/
│   └── executor.ts       # gh-aw CLI wrapper (init, new, compile, run, list)
├── github/
│   ├── auth.ts           # Centralized gh CLI auth, scope checking
│   ├── repo.ts           # Repo provisioning, git operations
│   ├── sync.ts           # Git sync loop (5s interval)
│   └── workflows.ts      # GitHub Actions YAML generation
├── schedules/
│   ├── parser.ts         # NLP schedule parsing via Copilot CLI
│   ├── reminders.ts      # Reminder CRUD (workflow files)
│   ├── recurring.ts      # Recurring schedule CRUD
│   └── agent.ts          # Copilot Coding Agent fallback (gh issue create)
├── memory/
│   └── session-mapper.ts # SQLite session mapping + synced Chronicle IDs
├── secrets/
│   └── keychain.ts       # OS keychain abstraction
├── config.ts             # Config loading (keychain + local file)
├── daemon.ts             # Main daemon (polling, processing, action execution)
└── cli/
    ├── setup.ts          # Interactive setup wizard (includes gh-aw init)
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

Six layers:
1. **Network**: All outbound, no exposed ports
2. **Access Control**: Fail-closed default, user allowlist, group restriction, DM blocking, secret prefix, topic restriction
3. **Action Validation**: Schema validation, type allowlist, field sanitization, URL encoding
4. **Data**: Secrets in OS keychain, error messages sanitized, no logging before security check
5. **GitHub**: Private repo, repo-level secrets for Actions, `repo`+`workflow` scopes required
6. **Process**: Restrictive file permissions, clean error handling, capped output reads

## YOLO Mode

When enabled (`copilot.yoloMode: true`), passes `--allow-all-tools` to Copilot CLI:
- File system operations
- Shell command execution
- Web browsing
- All MCP tools

**Default: OFF.**

## Installation

One-liner install:
```bash
curl -fsSL https://raw.githubusercontent.com/yaananth/ghclaw/main/install.sh | bash
```

Or manual:
```bash
git clone https://github.com/yaananth/ghclaw.git
cd ghclaw && bun install && bun link
```
