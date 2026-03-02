# Memory & Sessions

ghclaw has a deliberate three-tier memory architecture: a thin local mapping layer, Copilot CLI's Chronicle for deep memory, and GitHub for cross-machine persistence.

## The Three Tiers

```
┌───────────────────────────────────────────────────────────────────┐
│  Tier 1: Session Mapper (ghclaw owns)                            │
│  ~/.ghclaw/data/sessions.sqlite                                  │
│                                                                    │
│  Stores ONLY:                                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Telegram (chat_id, thread_id) → Copilot session UUID       │  │
│  │  + machine_id (which machine owns this session)              │  │
│  │  + machine_name, topic_id, status, message_count             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  Size: typically < 100 KB                                          │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│  Tier 2: Copilot CLI Chronicle (Copilot owns)                      │
│  ~/.copilot/session-state/                                         │
│                                                                    │
│  Stores EVERYTHING:                                                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Per session directory:                                      │  │
│  │  ├── workspace.yaml   (metadata: cwd, summary, branch)      │  │
│  │  ├── events.jsonl     (full turn-by-turn conversation)       │  │
│  │  └── checkpoints/     (periodic summaries + context)         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  Size: can be gigabytes across thousands of sessions               │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│  Tier 3: GitHub Sync Repo (shared across machines)                 │
│  {user}/.ghclaw on GitHub                                         │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  memory/sessions.json         (exported session metadata)    │  │
│  │  memory/machines/{id}.json    (per-machine snapshots)        │  │
│  │  .github/workflows/           (reminders + schedules)        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  Synced every 5 seconds via git pull/push                          │
└───────────────────────────────────────────────────────────────────┘
```

### Why Three Tiers?

- **Tier 1 (SQLite)**: Fast local lookups. Maps Telegram → Copilot sessions without duplicating history.
- **Tier 2 (Chronicle)**: Copilot CLI's built-in session management. Full conversation history, tools, checkpoints. ghclaw reads it but never writes directly.
- **Tier 3 (GitHub)**: Cross-machine visibility. Any machine can see sessions from other machines. Also powers reminders and schedules via GitHub Actions.

## Tier 1: Session Mapper

### Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- Copilot session UUID
  chat_id INTEGER NOT NULL,         -- Telegram chat ID
  thread_id INTEGER DEFAULT 0,      -- Telegram topic/thread ID
  name TEXT NOT NULL,               -- Session name
  status TEXT DEFAULT 'active',     -- 'active' or 'archived'
  created_at TEXT,                  -- ISO timestamp
  last_activity TEXT,               -- ISO timestamp
  message_count INTEGER DEFAULT 0,  -- Messages processed
  topic_id INTEGER,                 -- Auto-created Telegram topic ID
  machine_id TEXT,                  -- UUID of owning machine
  machine_name TEXT                 -- Human-readable machine name
);
```

### What It Does NOT Store

- Message content (Chronicle stores this)
- Conversation history
- AI responses
- Context windows or token counts
- Tool call results

## Tier 2: Chronicle (Copilot CLI)

### Directory Structure

```
~/.copilot/session-state/
├── 550e8400-e29b-41d4-a716-446655440000/
│   ├── workspace.yaml     # Session metadata
│   ├── events.jsonl       # Full conversation log
│   └── checkpoints/       # Periodic context snapshots
├── 6ba7b810-9dad-11d1-80b4-00c04fd430c8/
│   └── ...
└── ...
```

ghclaw reads Chronicle to:
- Display session summaries (`/sessions`, `/active`)
- Build topic names for forum groups
- Search sessions (`/search`)
- Show context when switching sessions (`/resume`)

## Tier 3: GitHub Sync

### What Gets Synced

| File | Content | Direction |
|------|---------|-----------|
| `memory/sessions.json` | All active sessions (metadata only) | Local → GitHub |
| `memory/machines/{id}.json` | Per-machine session snapshot + machine info | Local → GitHub |
| `.github/workflows/remind-*.yml` | Reminder workflows (self-deleting) | Local ↔ GitHub |
| `.github/workflows/sched-*.yml` | Recurring schedule workflows | Local ↔ GitHub |

### Sync Loop

```
Every 5 seconds (configurable):
  1. git pull --rebase (get changes from other machines)
  2. Export local sessions → memory/sessions.json
  3. Export machine info → memory/machines/{machine-id}.json
  4. git add -A && git commit && git push (if changes)
```

Errors are logged but never crash the daemon. The sync loop is non-blocking.

### What Does NOT Get Synced

- Message content (stays in Chronicle)
- OS keychain secrets
- Copilot CLI internal state
- Telegram message IDs or raw updates

## Agent Delegation

ghclaw acts as a middle manager, delegating work through multiple agent mechanisms:

### /delegate (Background Agents)

Copilot CLI's `/delegate` command spawns background coding agents:
- Fork tasks to run in parallel while the main conversation continues
- Great for "fix this bug while I work on something else"
- Agent results appear when complete

### /fleet (Parallel Agents)

Copilot CLI's `/fleet` runs multiple agents simultaneously:
- Different agents work on different files/tasks
- Results aggregated when all complete
- Ideal for multi-file refactoring

### Copilot Coding Agent (GitHub Issues)

The `/agent` Telegram command creates a GitHub Issue assigned to `@copilot`:
- Copilot Coding Agent picks up the issue
- Works autonomously on the codebase
- Creates a PR when done
- No local compute needed

### Model Routing

The system prompt instructs ghclaw to pick the right model:
- **Fast model**: Simple questions, status checks, quick lookups
- **Balanced model**: Most coding tasks, analysis, planning
- **Powerful model**: Complex reasoning, architecture decisions, multi-step work

## Chronicle Sync (Local → Telegram)

When the daemon starts, a background loop syncs Chronicle sessions to Telegram topics:

```
Every 30 seconds:
  1. Scan ~/.copilot/session-state/ for recent sessions (last 4 hours)
  2. Filter: only multi-turn interactive sessions
  3. Filter: skip ghclaw's own bot sessions
  4. For each new session:
     a. Create Telegram topic: "🤖 [MacBook] Mar01 2:14pm · myapp · Fix auth bug"
     b. Store mapping in session-mapper
     c. Send welcome message with session summary
  5. Rate limit: max 3 new topics per cycle
```

## Telegram Bot Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/sessions` | List 10 most recent Chronicle sessions |
| `/active [hours]` | Sessions updated in last N hours |
| `/search <query>` | Search by summary, directory, or repo |
| `/resume <id>` | Switch to a specific session |
| `/new` | Start a fresh session |
| `/broadcast` | Post active sessions summary |
| `/status` | System statistics |

### Reminders & Schedules

| Command | Description |
|---------|-------------|
| `/remind <text>` | NLP-parsed one-shot reminder ("tomorrow 9am deploy") |
| `/reminders` | List active reminders |
| `/cancel <id>` | Cancel a reminder |
| `/schedule <text>` | NLP-parsed recurring schedule ("every Monday 9am standup") |
| `/schedules` | List active schedules |
| `/unschedule <id>` | Delete a schedule |

### Agent & GitHub

| Command | Description |
|---------|-------------|
| `/agent <desc>` | Create GitHub Issue for Copilot Coding Agent |
| `/github` | Sync status, repo URL, reminder/schedule counts |

## Session Selection Flow

```
User: /sessions
Bot:  📚 Recent Sessions
      1. Fix auth bug (myapp) - 2h ago
      2. Explain repo structure - 3h ago

User: 1
Bot:  ✅ Switched to: Fix auth bug
      Your next message will continue this session.

User: What's the current status?
Bot:  [Copilot CLI resumes session, loads full context, responds]
```

Selection state expires after 5 minutes.

## Multi-Machine Session Routing

```
Message arrives at Machine A
    │
    ├── Lookup session in sessions.sqlite
    │
    ├── session.machine_id === my machine_id?
    │       │
    │       YES → Process with Copilot CLI
    │       NO  → Reply: "💻 This session lives on [machine-name]"
    │
    └── No existing session?
            │
            Create new, tag with my machine_id
```

## Streaming

Responses stream via the Channel interface:
1. First chunk → `Channel.send()` creates message with cursor (`▌`)
2. Subsequent chunks → `Channel.edit()` updates message (300ms throttle, 20-char threshold)
3. Done → Final `Channel.edit()` removes cursor
4. 4096 char limit → truncated with notice

The `streamToChannel()` helper works with any Channel implementation that supports editing.
