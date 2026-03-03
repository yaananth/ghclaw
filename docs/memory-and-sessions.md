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
│  │  Channel (chat_id, thread_id, channel_type) → Copilot UUID │  │
│  │  + machine_id (which machine owns this session)              │  │
│  │  + machine_name, topic_id, status, message_count             │  │
│  │  + synced_chronicle_sessions (persisted sync tracking)       │  │
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
│  │  memory/leader.json           (current leader identity)      │  │
│  │  memory/handoff.json          (pending handoff message)      │  │
│  │  .github/workflows/           (reminders + schedules)        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  Synced via smart sync (only when data changes)                      │
└───────────────────────────────────────────────────────────────────┘
```

### Why Three Tiers?

- **Tier 1 (SQLite)**: Fast local lookups. Maps channel messages → Copilot sessions without duplicating history. Also persists Chronicle sync tracking (survives daemon restarts).
- **Tier 2 (Chronicle)**: Copilot CLI's built-in session management. Full conversation history, tools, checkpoints. ghclaw reads it but never writes directly.
- **Tier 3 (GitHub)**: Cross-machine visibility. Any machine can see sessions from other machines. Also powers reminders and schedules via GitHub Actions.

## Tier 1: Session Mapper

### Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- Copilot session UUID
  chat_id INTEGER NOT NULL,         -- Channel chat/conversation ID
  thread_id INTEGER DEFAULT 0,      -- Channel thread/topic ID
  name TEXT NOT NULL,               -- Session name
  status TEXT DEFAULT 'active',     -- 'active' or 'archived'
  created_at TEXT,                  -- ISO timestamp
  last_activity TEXT,               -- ISO timestamp
  message_count INTEGER DEFAULT 0,  -- Messages processed
  topic_id INTEGER,                 -- Auto-created thread/topic ID
  machine_id TEXT,                  -- UUID of owning machine
  machine_name TEXT,                -- Human-readable machine name
  channel_type TEXT DEFAULT 'telegram'  -- Channel type ('telegram', 'discord', etc.)
);

CREATE TABLE synced_chronicle_sessions (
  session_id TEXT PRIMARY KEY,      -- Chronicle session ID
  synced_at TEXT NOT NULL           -- When it was synced
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
- Display session summaries (via `list_sessions` action)
- Build topic names for forum groups
- Search sessions (via `search_sessions` action)
- Show context when switching sessions (via `resume_session` action)

## Tier 3: GitHub Sync

### What Gets Synced

| File | Content | Direction |
|------|---------|-----------|
| `memory/sessions.json` | All active sessions (metadata only) | Local → GitHub |
| `memory/machines/{id}.json` | Per-machine session snapshot + machine info | Local → GitHub |
| `memory/leader.json` | Current leader machine identity + claim timestamp | Local ↔ GitHub |
| `memory/handoff.json` | Pending message for target machine during leader handoff | Local ↔ GitHub |
| `.github/workflows/remind-*.yml` | Reminder workflows (self-deleting) | Local ↔ GitHub |
| `.github/workflows/sched-*.yml` | Recurring schedule workflows | Local ↔ GitHub |

### Sync Loop

```
Every 5 seconds (configurable):
  1. git pull --no-rebase (merge, strategy-option=theirs)
     └─ Auto-aborts stuck rebases before pulling
  2. Check leader claim + handoff requests
  3. Compare session data with existing files
  4. Export sessions/machine info ONLY if data changed
  5. git commit && push ONLY if files were written
```

Smart sync: `exportSessionsToJson` and `exportMachineInfo` compare meaningful session data (excluding volatile timestamps like `exportedAt`) against existing files. If nothing changed, no write occurs, and no commit/push is triggered. This prevents hundreds of empty sync commits when the daemon is idle.

### What Does NOT Get Synced

- Message content (stays in Chronicle)
- OS keychain secrets
- Copilot CLI internal state
- Telegram message IDs or raw updates
- Channel-specific raw message data

## Agent Delegation

ghclaw acts as a middle manager, delegating work through multiple agent mechanisms:

### Copilot CLI (Local)

Copilot CLI provides built-in agent capabilities:
- `/delegate` — Background coding agents
- `/fleet` — Parallel multi-file agents
- `/plan` — Complex task planning
- `/research` — Deep research with GitHub search

### Copilot Coding Agent (Remote)

Via the enterprise API (`src/copilot/agent.ts`):
- Creates tasks assigned to Copilot Coding Agent
- Agent works autonomously on the codebase
- Creates a PR when done
- No local compute needed

### gh-aw (Agentic Workflows)

Via `gh aw` CLI extension (`src/ghaw/executor.ts`):
- Defines workflows in markdown → compiles to GitHub Actions YAML
- Runs LLM agents in sandboxed containers on schedule
- Used for recurring tasks needing AI reasoning

### Model Routing

The system prompt instructs the LLM to pick the right model:
- **Fast model**: Simple questions, status checks, quick lookups
- **Balanced model**: Most coding tasks, analysis, planning
- **Powerful model**: Complex reasoning, architecture decisions, multi-step work

## Chronicle Sync (Local → Channel)

When the daemon starts, a background loop syncs Chronicle sessions to channel threads:

```
Every 10 seconds:
  1. Get the 5 most recent Chronicle sessions (by recency, not time window)
  2. Filter: only multi-turn interactive sessions
  3. Filter: skip ghclaw's own bot sessions
  4. Check against synced_chronicle_sessions table (persists across restarts)
  5. For each new session:
     a. Create channel thread: "🤖 [MacBook] Mar01 2:14pm · myapp · Fix auth bug"
     b. Store mapping in session-mapper
     c. Send welcome message with session summary
  6. Rate limit: max 3 new topics per cycle
```

## Natural Language Interactions

All interactions are natural language. The LLM decides what action to take:

| What you say | What ghclaw does |
|-------------|-----------------|
| "remind me tomorrow 9am to deploy v2" | Creates one-shot GitHub Actions workflow (self-deletes) |
| "every Monday 9am check PRs" | Creates persistent cron workflow |
| "fix the login bug in auth.ts" | Creates Copilot Coding Agent task (asks for repo first) |
| "show my sessions" | Lists recent Chronicle sessions (pick by number to switch) |
| "what's the sync status?" | Shows GitHub sync info |
| "show my reminders" | Lists active reminder workflows |
| "cancel reminder abc123" | Cancels a specific reminder |
| "hello, how does this work?" | General chat via Copilot CLI |

## Session Selection Flow

```
User: "show my sessions"
Bot:  📚 Recent Sessions
      1. Fix auth bug (myapp) - 2h ago
      2. Explain repo structure - 3h ago

User: 1
Bot:  ✅ Switched to: Fix auth bug
      Creates a Telegram topic for this session.
      Your next message will continue this session.

User: What's the current status?
Bot:  [Copilot CLI resumes session, loads full context, responds]
```

Selection state expires after 5 minutes.

## Multi-Machine Session Routing

```
Message arrives at Leader machine
    │
    ├── Lookup session in sessions.sqlite
    │
    ├── session.machine_id === my machine_id?
    │       │
    │       YES → Process with Copilot CLI
    │       NO  → Trigger handoff:
    │               1. Write memory/handoff.json (target machine + pending message)
    │               2. Push to sync repo
    │               3. Yield leadership (stop polling)
    │               4. Target machine picks up handoff via sync loop
    │               5. Target claims leadership + processes message
    │
    └── No existing session?
            │
            Create new, tag with my machine_id
```

If no sync repo is configured, cross-machine handoff is unavailable. The leader claims the session locally and processes it.

### Automatic Failover

If the leader goes offline, followers detect this lazily via poll probes every ~30 seconds:
- **Poll succeeds (no 409):** Leader is dead → follower claims leadership and resumes polling
- **Poll gets 409 Conflict:** Leader is still alive → stay as follower

No heartbeat commits needed — Telegram's 409 response IS the liveness signal.

## Streaming

Responses stream via `streamToChannelCollecting()`:
1. First chunk → `channel.send()` creates message with cursor (`▌`)
2. Subsequent chunks → `channel.edit()` updates message (300ms throttle, 20-char threshold)
3. Action blocks (`json:ghclaw-action`) are hidden from displayed text
4. Done → Final `channel.edit()` removes cursor
5. Soft message length limit based on channel's `maxMessageLength` → truncated with notice
6. Full raw text returned for action block parsing
