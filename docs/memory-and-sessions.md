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
     └─ All git ops serialized via async mutex (withGitLock)
  2. Check leader claim + handoff requests (see Multi-Machine section)
  3. Refresh leader.json heartbeat every 30s (only if this machine IS the leader)
  4. Compare session data with existing files
  5. Export sessions/machine info ONLY if data changed
     └─ Includes chat_id/thread_id for cross-machine ownership lookups
  6. git commit && push ONLY if files were written
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
  2. Filter: sessions with at least 1 turn (includes single-question interactive sessions)
  3. Filter: skip ghclaw's own bot sessions (detected by summary content)
  4. Check against synced_chronicle_sessions table (persists across restarts)
  5. For each new session:
     a. Create channel thread: "🤖 [MacBook] Mar01 2:14pm · myapp · Fix auth bug"
     b. Store mapping in session-mapper
     c. Send welcome message with session summary
     d. Set synced_turn_count to current count (prevents backfill of existing turns)
  6. Sync incremental turns for existing topics:
     a. Compare synced_turn_count vs current Chronicle turn count per session
     b. Post only NEW turns (user message + assistant response pairs)
     c. Rate limit: max 6 messages per cycle, 3 per session, 300ms spacing
  7. Rate limit: max 3 new topics per cycle

**Dedup prevention:** After sending a direct response to a user message, the daemon calls `ensureSyncedRow(sessionId, currentTurns + 1)` to mark those turns as already posted. This prevents the background sync loop from re-posting the same content. The `+1` accounts for Chronicle not having flushed the new turn yet.
```

Note: ghclaw's own `-p` sessions (title generation, schedule parsing) are caught by the bot session summary filter. User's own terminal `-p` sessions are intentionally included since they're indistinguishable from interactive single-question sessions and are worth surfacing.

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
    ├── Dedup check (content-based: chatId:threadId:senderId:text)
    │   └─ Skip if already processed (handoff + poll race)
    │
    ├── Lookup session in local sessions.sqlite
    │
    ├── Cross-machine ownership check:
    │   1. Local SQLite may have wrong owner (each machine has its own DB)
    │   2. Check sync repo machine files (memory/machines/{id}.json)
    │   3. Correct local DB if sync repo shows different owner
    │
    ├── session owner === my machine_id?
    │       │
    │       YES → Process with Copilot CLI
    │       NO  → Check if target is alive (leader.json claim < 2 min old):
    │               ├─ DEAD  → Claim session locally, process normally
    │               └─ ALIVE → Trigger handoff:
    │                   1. Write memory/handoff.json (target + pending message + sender ID)
    │                   2. Update memory/leader.json to point to target
    │                   3. Yield leadership (stop polling, enter follower mode)
    │                   4. Sync loop commits both files within ~5s
    │                   5. Target machine's sync loop detects handoff
    │                   6. Target claims leadership, processes message, deletes handoff.json
    │
    └── No existing session?
            │
            Create new, tag with my machine_id
```

If no sync repo is configured, cross-machine handoff is unavailable. The leader claims the session locally and processes it.

### Handoff Message Lifecycle

1. **Created**: Leader writes `handoff.json` with pending message, target machine ID, and original sender's user ID (for security validation)
2. **Committed**: Sync loop commits to repo within ~5 seconds (no separate push — prevents git race)
3. **Picked up**: Target machine's sync loop detects `to_machine_id` match → claims leadership → runs full security check on message → processes it
4. **Deleted**: Target calls `clearHandoffRequest()` which removes the file
5. **Stale recovery**: If target doesn't pick up within 60s, sender reclaims and processes. After 90s, any third machine can recover.

### Automatic Failover

If the leader goes offline, followers detect this via **passive leader.json staleness** (no channel API calls):

```
Follower loop (every 10 seconds):
  1. Read leader.json from local sync repo copy
  2. If claimed_at > 2 minutes stale → leader is dead
  3. Claim leadership (write leader.json)
  4. Resume polling
```

Followers NEVER call the channel API (e.g., Telegram `getUpdates`) — a follower probe would trigger a 409 Conflict that disrupts the actual leader's polling. The leader's 30-second heartbeat (refreshing `leader.json`) serves as the liveness signal.

### Git Operations

All git operations (pull, commit, push) are serialized via an async mutex (`withGitLock` in `repo.ts`). This prevents the sync loop and handoff writes from racing on the same git working tree, which would cause silent push failures.

## Streaming

Responses stream via `streamToChannelCollecting()`:
1. First chunk → `channel.send()` creates message with cursor (`▌`)
2. Subsequent chunks → `channel.edit()` updates message (300ms throttle, 20-char threshold)
3. Action blocks (`json:ghclaw-action`) are hidden from displayed text
4. Done → Final `channel.edit()` removes cursor
5. Soft message length limit based on channel's `maxMessageLength` → truncated with notice
6. Full raw text returned for action block parsing
