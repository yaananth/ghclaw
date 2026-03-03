# Architecture

ghclaw is a local middle manager AI that bridges messaging channels to GitHub Copilot CLI's full agent ecosystem. It runs entirely on your machine with all connections outbound — no exposed ports, no webhooks.

## System Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Your Machine (all connections outbound)                                   │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  ghclaw daemon                                                      │  │
│  │                                                                      │  │
│  │  ┌──────────────┐    ┌──────────────────────────────────────────┐   │  │
│  │  │  Channel       │───▶│  Security Layer                          │   │  │
│  │  │  Interface     │    │  - Per-channel security (fail-closed)     │   │  │
│  │  │  (polling)     │    │  - Telegram: user/group/DM/prefix/topic  │   │  │
│  │  │               │    │  - Non-Telegram: blocked until implemented│   │  │
│  │  │  Registry:     │    │                                          │   │  │
│  │  │  - Telegram    │    │                                          │   │  │
│  │  │  - (Discord)   │    │                                          │   │  │
│  │  │  - (Slack)     │    │                                          │   │  │
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
│  │  │  Streaming    │──▶ │  Channel: send / edit messages    │          │  │
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
1. Streams the LLM response to the active channel (hiding action blocks from display)
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
- `.github/workflows/notify.yml` — base notification workflow (channel-aware)

Sync loop runs every 5 seconds: `git pull → export (if changed) → commit/push (if changed)`. Smart sync compares session data before writing — no needless commits when data hasn't changed.

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

**How:** Channels use outbound polling (e.g., Telegram's `getUpdates` API). All connections outbound.

### 6. Delegate Memory to Copilot CLI

**Why:** Copilot CLI's Chronicle already manages sessions, turns, checkpoints, and context compaction.

**How:** ghclaw only stores a minimal mapping:
```
Channel (chat_id, thread_id, channel_type) → Copilot session UUID + machine_id
```

### 7. OS Keychain for Secrets

**Why:** Environment variables and `.env` files leak easily.

**How:** Native OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager). Fallback to env vars only when keychain unavailable.

### 8. Message Acknowledgment

**Why:** Users need immediate feedback that ghclaw received their message.

**How:** 👀 emoji reaction via channel's reaction API on receipt (e.g., Telegram's `setMessageReaction`). Cleared after response is sent. Best-effort (non-blocking). Only for channels that support reactions.

### 9. Channel Abstraction

**Why:** The daemon was hardcoded to Telegram. Adding new channels (Discord, Slack) would require forking the entire daemon.

**How:** A `Channel` interface (`src/channels/channel.ts`) abstracts messaging operations: `poll()`, `send()`, `edit()`, `start()`, `stop()`, `getInfo()`. Optional methods (`setReaction()`, `createThread()`, `renameThread()`, `getChatInfo()`) support channel-specific capabilities. `TelegramChannel` is the first implementation.

A **Channel Registry** (`src/channels/registry.ts`) auto-detects configured channels by checking keychain for tokens. If only one channel is configured, it's auto-selected. If multiple are configured, the user's preference from `config.channels.active` is used.

**Security model:** Fail-closed per channel. Non-Telegram channels are rejected until they implement their own security checks. Each channel type is responsible for its own access controls.

## Data Flow

### Message Processing

```
1. Channel poll (e.g., Telegram getUpdates, 30s timeout)

2. Security Check (BEFORE any logging)
   ├─▶ Channel-specific security (fail-closed for non-Telegram)
   ├─▶ Telegram: group/user/DM/prefix/topic checks
   └─▶ Future channels: blocked until security implemented
   → REJECT if any fails (no content logged for rejected messages)

3. Acknowledge receipt (👀 reaction, if channel supports it)

4. Check channel-specific commands (/start, /help, /new for Telegram)

5. Check session selection (number reply after session list)

6. Session Lookup
   ├─▶ getOrCreateSession(chatId, threadId, channelType)
   ├─▶ Check machine_id ownership
   └─▶ Wrong machine → trigger handoff (write handoff.json, yield leadership), STOP

7. Auto-create thread (if channel supports threading and in main chat)
   └─▶ AI-generated thread title (background)

8. Build system prompt
   ├─▶ Load instructions.md (action block format + available actions)
   └─▶ Append Copilot CLI discovered capabilities

9. Copilot CLI Execution
   ├─▶ copilot --resume <session-id> -p "prompt" --silent
   └─▶ Stream stdout via streamToChannelCollecting()

10. Stream to Channel
    ├─▶ Create message with typing cursor (▌)
    ├─▶ Edit as chunks arrive (300ms throttle)
    ├─▶ Hide json:ghclaw-action blocks from display
    └─▶ Final edit with complete response

11. Parse + Execute Actions
    ├─▶ parseActionBlocks(fullText) → extract action JSON
    ├─▶ Validate against schema (allowlisted types + fields)
    └─▶ executeAction() → handler result sent as follow-up

12. Clear 👀 reaction (if channel supports it)
```

### GitHub Sync

```
Every 5 seconds:
  1. git pull --no-rebase (merge with strategy-option=theirs)
     └─ Auto-aborts stuck rebases before pulling
  2. Check leader claim + handoff requests
  3. Export local sessions to memory/sessions.json (skipped if data unchanged)
  4. Export machine info to memory/machines/{id}.json (skipped if data unchanged)
  5. git commit && push (only if files were actually written)
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
8. Workflow sends message via active channel's API (channel-aware workflow step)
9. Workflow self-deletes its own YAML file
```

## File Structure

```
~/.ghclaw/
├── config.json           # Non-secret config (machine identity, GitHub, copilot)
├── daemon.lock           # PID file when daemon running
├── daemon.log            # Daemon output
├── data/
│   └── sessions.sqlite   # Channel → Copilot session mapping + synced Chronicle IDs
└── repo/                 # Git clone of {user}/.ghclaw
    ├── memory/
    │   ├── sessions.json
    │   ├── leader.json
    │   ├── handoff.json
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
├── channels/             # Channel abstraction layer (daemon uses this)
│   ├── channel.ts        # Channel interface, ChannelMessage, SendOptions, streamToChannel()
│   ├── telegram.ts       # TelegramChannel implements Channel (threads, reactions, etc.)
│   ├── registry.ts       # Channel detection, auto-selection, registry
│   └── index.ts          # Barrel exports (Channel, TelegramChannel, registry)
├── telegram/
│   ├── client.ts         # Low-level Telegram API client (send, edit, react, topics)
│   ├── security.ts       # Telegram-specific security checks (fail-closed, allowlist, group, DM, prefix, topic)
│   └── commands.ts       # Telegram-specific command handlers (/start, /help, /new)
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
│   └── workflows.ts      # Channel-aware GitHub Actions YAML generation
├── schedules/
│   ├── parser.ts         # NLP schedule parsing via Copilot CLI
│   ├── reminders.ts      # Reminder CRUD (channel-aware workflow files)
│   ├── recurring.ts      # Recurring schedule CRUD
│   └── agent.ts          # Copilot Coding Agent fallback (gh issue create)
├── memory/
│   └── session-mapper.ts # SQLite channel-neutral session mapping + synced Chronicle IDs
├── secrets/
│   └── keychain.ts       # OS keychain abstraction
├── config.ts             # Config loading (keychain + local file, includes channels config)
├── daemon.ts             # Main daemon (Channel interface, polling, processing, action execution)
└── cli/
    ├── setup.ts          # Interactive setup wizard (channel detection + gh-aw init)
    └── doctor.ts         # Health checks + git auto-fix (detached HEAD, stuck rebase, diverged branches)
```

## Multi-Machine Support

Multiple machines share the same channel group/workspace. Each machine:
- Gets a unique identity (UUID + hostname) on first run
- Creates threads tagged: `🤖 [MacBook] Fix auth bug` (if channel supports threading)
- Owns its sessions via `machine_id` in the session mapper
- Syncs its data to `memory/machines/{id}.json` in the GitHub repo

### Leader/Follower Model

Only one machine polls the channel at a time. The active poller is the **leader**; all other machines run as **followers** (sync-only mode — they still run the git sync loop but do not poll for messages).

Leadership is tracked via `memory/leader.json` in the sync repo:

```json
{
  "machine_id": "uuid-of-leader",
  "machine_name": "MacBook",
  "claimed_at": "2026-03-02T10:00:00Z"
}
```

On startup, a machine writes `memory/leader.json` to claim leadership and pushes to the sync repo. If another machine already holds leadership, the new machine starts as a follower.

### Leader Handoff

When the leader receives a message for a session owned by a different machine, it triggers a **handoff** instead of processing locally:

1. The leader writes `memory/handoff.json` with the pending message and the target machine ID:
   ```json
   {
     "target_machine_id": "uuid-of-target",
     "message": { "chat_id": 123, "thread_id": 456, "text": "continue fixing auth" },
     "from_machine_id": "uuid-of-leader",
     "created_at": "2026-03-02T10:05:00Z"
   }
   ```
2. The leader pushes to the sync repo.
3. The leader yields leadership (stops polling).

The target machine's sync loop detects the handoff file, claims leadership (writes `memory/leader.json`), picks up the pending message, processes it, and deletes `memory/handoff.json`.

### Automatic Failover

If the leader goes offline (crashes, sleeps, network loss), followers detect this lazily. Every ~30 seconds, a follower attempts a short poll probe:
- **Poll succeeds (no 409):** Leader is dead → follower claims leadership, resumes polling, processes any messages received
- **Poll gets 409 Conflict:** Leader is alive → stay as follower

No heartbeat commits or timestamp-based detection needed — Telegram's 409 Conflict response IS the heartbeat.

### Fallback (No Sync Repo)

If no sync repo is configured, the single running instance always acts as leader. Cross-machine session ownership is ignored — the local machine claims any session it encounters and processes it locally.

### Soft Routing (Handoff Trigger)

All active session lookups still check `machine_id` ownership. When a message arrives:
1. Look up session → check `machine_id`
2. **Match** → process normally
3. **Mismatch** → trigger handoff to the owning machine (write `memory/handoff.json`, yield leadership)
4. **New session** → claim it with current `machine_id`

## Security Model

See [Security](security.md) for the detailed security model.

Six layers:
1. **Network**: All outbound, no exposed ports
2. **Access Control**: Per-channel security (fail-closed). Telegram: user allowlist, group restriction, DM blocking, secret prefix, topic restriction. Non-Telegram: blocked until security implemented
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
