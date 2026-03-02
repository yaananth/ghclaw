# Secrets Configuration

ghclaw uses your OS keychain and GitHub repo secrets to securely store credentials. No secrets are stored in plain text files.

## Secret Storage

### Two Secret Stores

| Store | What | Where |
|-------|------|-------|
| **OS Keychain** | Bot token, group/user IDs, secret prefix | macOS Keychain / Linux libsecret / Windows Credential Manager |
| **GitHub Repo Secrets** | Bot token, chat ID, thread ID (for Actions) | `{user}/.ghclaw` repo settings |

OS keychain secrets are set during `ghclaw setup`. GitHub repo secrets are automatically configured during setup when GitHub integration is enabled.

## Required Secrets

### Telegram Bot Token

**Key:** `telegram-bot-token`

The only secret you must provide manually.

1. Message `@BotFather` on Telegram
2. Send `/newbot` and follow prompts
3. Copy the token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

During `ghclaw setup`, this is:
- Stored in OS keychain
- Set as `TELEGRAM_BOT_TOKEN` GitHub repo secret (for Actions workflows)

## Optional Secrets

### Allowed Group ID

**Key:** `telegram-allowed-group`

Restricts bot to a specific Telegram group. Auto-detected during setup — send a message in your group when prompted.

### Allowed User IDs

**Key:** `telegram-allowed-users`

Restricts bot to specific users. Auto-detected during setup from the first message sender.

### Secret Prefix

**Key:** `telegram-secret-prefix`

Requires messages to start with a phrase before the bot responds:
```
!ai What's the weather?  → Bot responds
What's the weather?      → Bot ignores
```

## GitHub Repo Secrets

These are set automatically during setup on the `{user}/.ghclaw` repo:

| Secret | Purpose |
|--------|---------|
| `TELEGRAM_BOT_TOKEN` | Used by Actions workflows to send Telegram messages |
| `TELEGRAM_CHAT_ID` | Target chat for reminder/schedule notifications |
| `TELEGRAM_THREAD_ID` | Optional thread for notifications in forum groups |

These enable GitHub Actions workflows (reminders, schedules) to send Telegram messages without any local compute.

## Storage Locations

### macOS

Stored in **Keychain Access** under service name `ghclaw`.

View: Keychain Access → search "ghclaw" → double-click → Show password

### Linux

Stored via **libsecret** (GNOME Keyring / KDE Wallet).

```bash
secret-tool lookup service ghclaw key telegram-bot-token
```

### Windows

Stored in **Credential Manager** → Windows Credentials → entries starting with `ghclaw`.

### Fallback

If keychain unavailable, environment variables:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_GROUP_ID`
- `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_SECRET_PREFIX`

## Commands

```bash
ghclaw secrets list              # List stored keys
ghclaw secrets set <key> <value> # Store a secret
ghclaw secrets get <key>         # Retrieve a secret
ghclaw secrets delete <key>      # Delete a secret
ghclaw secrets migrate           # Migrate from .env to keychain
ghclaw secrets manual            # OS-specific keychain instructions
```

## Troubleshooting

### "Keychain not available"

**macOS:** Should work by default. Unlock if needed:
```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

**Linux:** Install libsecret:
```bash
sudo apt install libsecret-tools  # Ubuntu/Debian
sudo dnf install libsecret        # Fedora
```

### "Invalid token"

1. Check format: `NUMBER:STRING`
2. Regenerate: `/revoke` then `/newbot` in BotFather
3. No extra spaces or characters

### "Bot not responding in group"

1. Bot must be added to the group
2. Bot needs admin role (or disable privacy mode via BotFather)
3. Check allowed group ID: `ghclaw detect-group`
4. Run `ghclaw doctor` for diagnostics
