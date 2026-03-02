# Security Model

This document details ghclaw's security architecture. ghclaw is designed for personal use on private machines with defense-in-depth across network, access control, data protection, GitHub integration, and process security.

## Threat Model

### What ghclaw Protects Against

| Threat | Mitigation |
|--------|------------|
| Unauthorized Telegram users invoking the bot | User allowlist + group restriction + DM blocking |
| Bot token exposure | OS keychain storage, never in files or env |
| Prompt injection via Telegram messages | Role marker stripping, session name sanitization |
| Secrets in logs | Security check runs BEFORE any logging; long tokens redacted |
| Exposed network surface | All connections outbound (polling), no webhooks, no open ports |
| Cross-machine session hijacking | Machine ID ownership, soft-routing redirects |
| GitHub Actions secret leakage | Repo-level secrets, never in workflow YAML, private repo |
| Error message information disclosure | All errors sanitized: paths, tokens, keys redacted |
| Process-level secret exposure | Secrets not in argv; restrictive file permissions |
| Stale credentials | Keychain integration with OS-level credential lifecycle |

### What ghclaw Does NOT Protect Against

- Compromise of the machine it runs on (root access defeats all local controls)
- Telegram's own infrastructure being compromised
- GitHub's infrastructure being compromised
- Copilot CLI vulnerabilities (ghclaw is a thin layer on top)
- Social engineering of the bot operator

## Security Layers

### Layer 1: Network Security

**All connections outbound.** ghclaw never listens on any port.

| Connection | Direction | Protocol | Destination |
|------------|-----------|----------|-------------|
| Telegram polling | Outbound | HTTPS | api.telegram.org |
| Telegram send/edit | Outbound | HTTPS | api.telegram.org |
| GitHub sync | Outbound | HTTPS (git) | github.com |
| GitHub API | Outbound | HTTPS | api.github.com |
| Copilot CLI | Local | stdin/stdout | Subprocess |

**No webhooks.** Telegram webhooks require exposing a public HTTPS endpoint. ghclaw uses long-polling instead, which is outbound-only.

**No open ports.** The daemon creates no network listeners. It cannot be scanned or attacked remotely.

### Layer 2: Access Control

Five independent access control mechanisms, all enabled by default:

#### 2a. Group Restriction

Bot only responds in a specific Telegram group.

```
Config: telegram.allowedGroupId
Secret: telegram-allowed-group
```

Messages from other groups or unknown chats are silently dropped (no response, no logging of content).

#### 2b. User Allowlist

Bot only responds to specific user IDs.

```
Config: telegram.allowedUserIds
Secret: telegram-allowed-users
```

Comma-separated list. Messages from non-allowed users are blocked with a log entry containing only the user ID (no message content).

#### 2c. DM Blocking

Private messages are blocked by default.

```
Config: telegram.blockPrivateMessages (default: true)
```

The bot ignores all private/direct messages entirely.

#### 2d. Secret Prefix

Optional: require a secret phrase prefix on every message.

```
Secret: telegram-secret-prefix
```

Messages without the prefix are silently ignored. The prefix is stripped before processing.

#### 2e. Topic Restriction

Optional: restrict to specific forum topic IDs.

```
Config: telegram.allowedTopicIds
```

Messages in non-allowed topics are ignored.

#### Access Control Evaluation Order

```
1. Is message from an allowed group? → NO → Drop (silent)
2. Is sender in user allowlist?       → NO → Drop (log user ID only)
3. Is this a DM and DMs blocked?     → YES → Drop (silent)
4. Is secret prefix present?          → NO → Drop (silent)
5. Is topic in allowed list?          → NO → Drop (silent)
6. ✅ Message passes all checks → proceed to processing
```

**Important:** All security checks run BEFORE any content logging. Message text is never logged for rejected messages.

### Layer 3: Data Security

#### Secret Storage

All sensitive credentials stored in OS keychain:

| Platform | Backend | Encryption |
|----------|---------|------------|
| macOS | Keychain Access | AES-256-GCM (hardware-backed on Apple Silicon) |
| Linux | libsecret (GNOME Keyring) | AES-128-CBC (session keyring) |
| Windows | Credential Manager | DPAPI (user-level encryption) |

**What's stored in keychain:**
- `telegram-bot-token` — Bot API token
- `telegram-allowed-group` — Allowed group ID
- `telegram-allowed-users` — Comma-separated user IDs
- `telegram-secret-prefix` — Optional message prefix

**What's NOT in keychain (non-secret config):**
- `config.json` — Poll intervals, model preferences, machine identity, GitHub repo name
- File permissions: `config.json` is `0o600`, config directory is `0o700`

#### Environment Variable Fallback

If keychain is unavailable, secrets fall back to environment variables:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_GROUP_ID`
- `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_SECRET_PREFIX`

This is explicitly a fallback for environments without keychain (headless servers, containers).

#### Log Sanitization

All log output is sanitized:

```typescript
// Before logging any user message:
redactedPrompt = prompt
  .replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')     // Long tokens
  .replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]')    // Auth headers
  .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]'); // Token values
```

Error messages from Copilot CLI are sanitized before returning to Telegram:
- Home directory paths replaced with `***`
- Tokens, passwords, secrets, keys, auth headers all redacted
- API key patterns (20+ alphanumeric chars) redacted
- Output capped at 500 characters

#### Session Name Sanitization

Session names (from Telegram topic names or user input) are sanitized before inclusion in system prompts:

```typescript
safeName = session.name
  .replace(/[\n\r]/g, ' ')                          // No newlines
  .replace(/[<>{}[\]"'`]/g, '')                     // No brackets/quotes
  .replace(/system|assistant|user|developer|tool/gi, '') // No role markers
  .trim()
  .slice(0, 50);                                     // Length limit
```

This prevents prompt injection via Telegram topic names or session names.

### Layer 4: GitHub Integration Security

#### Private Repository

The sync repo (`{user}/.ghclaw`) is created as **private** by default. It contains:
- Session metadata (no message content)
- Machine identifiers
- GitHub Actions workflow files

#### Required Scopes

ghclaw requires exactly two GitHub CLI scopes:

| Scope | Purpose |
|-------|---------|
| `repo` | Create/access private sync repo, push/pull, manage issues |
| `workflow` | Create/modify GitHub Actions workflows for reminders/schedules |

Setup validates scopes and prompts for re-authentication if missing.

#### Repo Secrets

Sensitive values for GitHub Actions are stored as **repo-level secrets**, never in workflow YAML:

| Secret | Purpose | Set By |
|--------|---------|--------|
| `TELEGRAM_BOT_TOKEN` | Send Telegram notifications from Actions | Setup wizard |
| `TELEGRAM_CHAT_ID` | Target chat for notifications | Setup wizard |
| `TELEGRAM_THREAD_ID` | Optional thread for forum groups | Setup wizard |

Secrets are set via `gh secret set` which encrypts with NaCl sealed boxes (Curve25519 + XSalsa20-Poly1305).

#### Workflow Security

Reminder and schedule workflows:
- Use `secrets.*` references, never hardcoded values
- Self-deleting reminders use `GITHUB_TOKEN` (automatic, scoped to repo)
- No `pull_request_target` or other dangerous triggers
- No external action dependencies (uses only `run:` steps with `curl`)
- Workflows only execute on `schedule` trigger (cron)

#### Sync Security

The git sync loop:
- Uses `gh` CLI authentication (inherits user's token)
- Only pushes to the configured private repo
- Uses `--rebase` for pulls to avoid merge commits
- Non-blocking — sync errors are logged but never crash the daemon

### Layer 5: Process Security

#### File Permissions

| File | Permissions | Purpose |
|------|-------------|---------|
| `~/.ghclaw/` | `0o700` | Config directory — owner only |
| `~/.ghclaw/config.json` | `0o600` | Config — owner read/write |
| `~/.ghclaw/daemon.lock` | `0o600` | PID file — owner read/write |

#### Daemon Lock

Single-instance enforcement via PID file:
- Created with exclusive flag (`wx`) on startup
- PID validated against running processes (stale locks cleaned up)
- Removed on graceful shutdown (SIGINT, SIGTERM)

#### Copilot CLI Invocation

```bash
copilot --resume <session-id> -p "prompt" --silent
```

- `GITHUB_TOKEN` passed via environment variable (not argv)
- Prompts passed via `-p` flag (Copilot CLI handles securely)
- `--silent` suppresses interactive UI elements
- Process stdout is streamed, not buffered entirely in memory

#### Signal Handling

The daemon handles SIGINT and SIGTERM for graceful shutdown:
- Stops the polling loop
- Removes the PID lock file
- Does not force-kill subprocesses

## Security Checklist for Deployment

- [ ] Run `ghclaw setup` (stores secrets in OS keychain)
- [ ] Verify group restriction is set (`ghclaw secrets get telegram-allowed-group`)
- [ ] Verify user allowlist is set (`ghclaw secrets get telegram-allowed-users`)
- [ ] DM blocking is ON by default (verify in `config.json`)
- [ ] Run `ghclaw doctor` — all checks should pass
- [ ] GitHub repo is private (verify on GitHub)
- [ ] Repo secrets are set (verify with `gh secret list --repo {user}/.ghclaw`)
- [ ] YOLO mode is OFF unless explicitly needed (`copilot.yoloMode: false`)
- [ ] Bot token not committed to any repo (check with `git log --all -p | grep -c "bot token pattern"`)

## Security Comparison: ghclaw vs openclawd

ghclaw was designed specifically to address security concerns:

| Feature | ghclaw | Typical open alternatives |
|---------|---------|--------------------------|
| Secret storage | OS keychain | `.env` files or env vars |
| Network exposure | Outbound only (polling) | Webhooks (inbound HTTPS) |
| Access control | 5 layers, all default-on | Often optional or minimal |
| Log sanitization | Before any logging | Often logs first, filters later |
| GitHub secrets | Repo-level, encrypted | Often in workflow YAML |
| Private by default | Yes (private repo) | Varies |
| Prompt injection defense | Role marker stripping | Often unprotected |
| Error disclosure | Sanitized (paths, tokens redacted) | Often verbose |

## Incident Response

If the bot token is compromised:
1. Revoke via BotFather: send `/revoke` to `@BotFather`
2. Create new token: `/newbot`
3. Update keychain: `ghclaw secrets set telegram-bot-token <new-token>`
4. Update GitHub secret: `gh secret set TELEGRAM_BOT_TOKEN --repo {user}/.ghclaw`
5. Restart daemon: `ghclaw stop && ghclaw start`

If the GitHub token is compromised:
1. Revoke via GitHub: Settings → Developer settings → Personal access tokens
2. Re-authenticate: `gh auth login`
3. Restart daemon

## Auditing

`ghclaw doctor` performs automated security checks:
- Keychain availability and stored secrets
- Telegram bot token validity
- GitHub CLI authentication and scope verification
- Copilot CLI availability
- GitHub repo existence and sync status
- Chronicle availability
