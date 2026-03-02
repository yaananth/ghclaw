/**
 * Telegram Command Handler
 *
 * Handles bot commands like /sessions, /search, /help
 * for surfacing and managing Copilot CLI sessions.
 */

import { TelegramClient, TelegramMessage, SendMessageOptions } from './client';
import {
  getRecentSessions,
  getActiveSessions,
  searchSessions,
  getSession,
  formatSessionsList,
  formatSessionForTelegram,
  isChronicleAvailable,
  getChronicleStats,
  getLatestCheckpoint,
  type ChronicleSession,
} from '../copilot/chronicle';
import {
  getOrCreateSession,
  getSessionStats as getTelegramSessionStats,
} from '../memory/session-mapper';
import { getConfigAsync } from '../config';
import { parseScheduleRequest } from '../schedules/parser';
import { createReminder, listReminders, cancelReminder } from '../schedules/reminders';
import { createSchedule, listSchedules, deleteSchedule } from '../schedules/recurring';
import { createAgentTask } from '../schedules/agent';
import { getSyncState } from '../github/sync';

// ============================================================================
// Types
// ============================================================================

export interface CommandContext {
  chatId: number;
  threadId: number;
  userId: number;
  username?: string;
  args: string;
}

export interface CommandResult {
  response: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  // If set, switch to this Copilot session for future messages
  switchToSession?: string;
}

type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

// ============================================================================
// State: Track pending session selections per chat
// ============================================================================

interface PendingSelection {
  sessions: ChronicleSession[];
  expiresAt: number;
}

const pendingSelections = new Map<string, PendingSelection>();

function getChatKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

// ============================================================================
// Command Registry
// ============================================================================

const commands: Record<string, CommandHandler> = {
  '/start': handleStart,
  '/help': handleHelp,
  '/sessions': handleSessions,
  '/active': handleActive,
  '/search': handleSearch,
  '/resume': handleResume,
  '/status': handleStatus,
  '/new': handleNew,
  '/broadcast': handleBroadcast,
  '/remind': handleRemind,
  '/reminders': handleReminders,
  '/cancel': handleCancel,
  '/schedule': handleSchedule,
  '/schedules': handleSchedules,
  '/unschedule': handleUnschedule,
  '/agent': handleAgent,
  '/github': handleGithub,
};

// ============================================================================
// Command Handlers
// ============================================================================

async function handleStart(ctx: CommandContext): Promise<CommandResult> {
  const name = ctx.username ? `@${ctx.username}` : `User ${ctx.userId}`;

  return {
    response: `👋 *Welcome to GHClaw!*

I'm your Telegram interface to GitHub Copilot CLI.

${isChronicleAvailable() ? '✅ Chronicle detected - your existing sessions are available!' : '⚠️ Chronicle not found - start chatting to create a new session.'}

*Just talk to me naturally:*
• "remind me tomorrow 9am to deploy v2"
• "every Monday 9am check PRs"
• "show my recent sessions"
• "fix the login bug in auth.ts"
• "what's the sync status?"

Or just ask me anything!`,
    parseMode: 'Markdown',
  };
}

async function handleHelp(ctx: CommandContext): Promise<CommandResult> {
  return {
    response: `📖 *GHClaw Help*

*Just talk naturally!* No commands needed. Examples:

*Reminders & Schedules:*
• "remind me Friday 3pm to deploy"
• "every Monday 9am standup check"
• "show my reminders"
• "cancel reminder abc123"

*Coding Tasks:*
• "fix the login bug in owner/repo"
• "add dark mode to my-app"

*Sessions:*
• "show my sessions"
• "search sessions about auth"
• "start a fresh session"

*System:*
• "what's the status?"
• "show GitHub sync"

*Tips:*
• Sessions are shared with Copilot CLI — continue anywhere!
• Each Telegram topic gets its own session
• /new starts a fresh session`,
    parseMode: 'Markdown',
  };
}

async function handleSessions(ctx: CommandContext): Promise<CommandResult> {
  if (!isChronicleAvailable()) {
    return {
      response: '⚠️ Chronicle database not found. Start a Copilot CLI session first.',
    };
  }

  const limit = parseInt(ctx.args) || 10;
  const sessions = getRecentSessions(Math.min(limit, 20));

  // Store for selection
  const key = getChatKey(ctx.chatId, ctx.threadId);
  pendingSelections.set(key, {
    sessions,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute expiry
  });

  return {
    response: formatSessionsList(sessions, 'Recent Sessions'),
    parseMode: 'Markdown',
  };
}

async function handleActive(ctx: CommandContext): Promise<CommandResult> {
  if (!isChronicleAvailable()) {
    return {
      response: '⚠️ Chronicle database not found. Start a Copilot CLI session first.',
    };
  }

  const hours = parseInt(ctx.args) || 24;
  const sessions = getActiveSessions(hours);

  // Store for selection
  const key = getChatKey(ctx.chatId, ctx.threadId);
  pendingSelections.set(key, {
    sessions,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return {
    response: formatSessionsList(sessions, `Active Sessions (last ${hours}h)`),
    parseMode: 'Markdown',
  };
}

async function handleSearch(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.args.trim()) {
    return {
      response: '❓ Usage: /search <query>\n\nExample: /search authentication',
    };
  }

  if (!isChronicleAvailable()) {
    return {
      response: '⚠️ Chronicle database not found.',
    };
  }

  const sessions = searchSessions(ctx.args.trim());

  // Store for selection
  const key = getChatKey(ctx.chatId, ctx.threadId);
  pendingSelections.set(key, {
    sessions,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return {
    response: formatSessionsList(sessions, `Search: "${ctx.args.trim()}"`),
    parseMode: 'Markdown',
  };
}

async function handleResume(ctx: CommandContext): Promise<CommandResult> {
  const sessionId = ctx.args.trim();

  if (!sessionId) {
    return {
      response: '❓ Usage: /resume <session-id>\n\nGet session IDs from /sessions',
    };
  }

  // Try to find full session ID if partial
  const session = findSessionById(sessionId);

  if (!session) {
    return {
      response: `❌ Session not found: \`${sessionId}\`\n\nUse /sessions to see available sessions.`,
      parseMode: 'Markdown',
    };
  }

  // Get checkpoint info if available
  const checkpoint = getLatestCheckpoint(session.id);
  let response = `✅ *Switched to session:*\n\n${formatSessionForTelegram(session)}`;

  if (checkpoint?.overview) {
    response += `\n\n📝 *Last checkpoint:*\n${checkpoint.overview.slice(0, 200)}...`;
  }

  response += '\n\n_Your next message will continue this session._';

  return {
    response,
    parseMode: 'Markdown',
    switchToSession: session.id,
  };
}

async function handleNew(ctx: CommandContext): Promise<CommandResult> {
  // This will create a fresh session for this chat/thread
  // by NOT using --resume
  return {
    response: `🆕 *New session mode*

Your next message will start a fresh Copilot session.

_Note: Your previous session for this chat will still be available via /sessions._`,
    parseMode: 'Markdown',
    switchToSession: '__new__', // Special marker
  };
}

async function handleStatus(ctx: CommandContext): Promise<CommandResult> {
  const telegramStats = getTelegramSessionStats();
  const chronicleStats = isChronicleAvailable() ? getChronicleStats() : null;

  let response = `📊 *GHClaw Status*\n\n`;

  response += `*Telegram Sessions:*\n`;
  response += `• Active: ${telegramStats.activeSessions}\n`;
  response += `• Total: ${telegramStats.totalSessions}\n`;
  response += `• Messages: ${telegramStats.totalMessages}\n`;
  response += `• DB Size: ${formatBytes(telegramStats.dbSizeBytes)}\n\n`;

  if (chronicleStats) {
    response += `*Copilot Chronicle:*\n`;
    response += `• Sessions: ${chronicleStats.totalSessions}\n`;
    response += `• Turns (last 5): ${chronicleStats.totalTurns}\n`;
    if (chronicleStats.newestSession) {
      response += `• Latest: ${formatTimeAgo(chronicleStats.newestSession)}\n`;
    }
  } else {
    response += `*Copilot Chronicle:* Not found\n`;
  }

  return {
    response,
    parseMode: 'Markdown',
  };
}

async function handleBroadcast(ctx: CommandContext): Promise<CommandResult> {
  // Broadcast active sessions - useful for forums with topics
  if (!isChronicleAvailable()) {
    return {
      response: '⚠️ Chronicle not available.',
    };
  }

  const hours = parseInt(ctx.args) || 24;
  const sessions = getActiveSessions(hours);

  if (sessions.length === 0) {
    return {
      response: `📭 No active sessions in the last ${hours} hours.`,
    };
  }

  // Format as a compact broadcast message
  let response = `📡 *Active Copilot Sessions (${hours}h)*\n\n`;

  for (const session of sessions.slice(0, 5)) {
    const name = session.summary?.slice(0, 40) || 'Unnamed';
    const timeAgo = formatTimeAgo(session.updated_at);
    const turns = session.turn_count || 0;
    response += `• *${escapeMarkdown(name)}*\n`;
    response += `  └ ${turns} turns • ${timeAgo} • \`${session.id.slice(0, 8)}\`\n`;
  }

  if (sessions.length > 5) {
    response += `\n_...and ${sessions.length - 5} more. Use /sessions for full list._`;
  }

  response += `\n\n💡 _Reply with \`/resume <id>\` to continue any session_`;

  return {
    response,
    parseMode: 'Markdown',
  };
}

function escapeMarkdown(text: string): string {
  // Escape markdown special chars for Telegram
  return text.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
}

// ============================================================================
// Reminder & Schedule Handlers
// ============================================================================

async function handleRemind(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.args.trim()) {
    return {
      response: '❓ Usage: /remind <text>\n\nExample: /remind tomorrow 9am deploy v2',
    };
  }

  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
    }

    const parsed = await parseScheduleRequest(ctx.args.trim());
    if (!parsed) {
      return { response: '❌ Could not parse schedule. Try: /remind Friday 3pm deploy v2' };
    }

    const result = await createReminder(
      config.github.repoPath,
      parsed.message,
      parsed.cronExpression,
      config,
      parsed.humanReadable
    );

    return {
      response: `🔔 *Reminder set!*\n\n📝 ${parsed.message}\n⏰ ${parsed.humanReadable}\n🆔 \`${result.id}\`\n\n_Will fire via GitHub Actions and self-delete._`,
      parseMode: 'Markdown',
    };
  } catch (err) {
    return { response: '❌ Failed to create reminder' };
  }
}

async function handleReminders(ctx: CommandContext): Promise<CommandResult> {
  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
    }

    const reminders = listReminders(config.github.repoPath);
    if (reminders.length === 0) {
      return { response: '📭 No active reminders. Create one with /remind' };
    }

    let response = `🔔 *Active Reminders (${reminders.length})*\n\n`;
    for (const r of reminders) {
      response += `• \`${r.id}\` — ${r.message}\n  ⏰ \`${r.cronExpression}\`\n`;
    }
    response += `\n_Cancel with: /cancel <id>_`;

    return { response, parseMode: 'Markdown' };
  } catch (err) {
    return { response: '❌ Could not list reminders' };
  }
}

async function handleCancel(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.trim();
  if (!id) {
    return { response: '❓ Usage: /cancel <reminder-id>\n\nGet IDs from /reminders' };
  }

  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled.' };
    }

    const cancelled = await cancelReminder(config.github.repoPath, id);
    return {
      response: cancelled
        ? `✅ Reminder \`${id}\` cancelled`
        : `❌ Reminder \`${id}\` not found`,
      parseMode: 'Markdown',
    };
  } catch (err) {
    return { response: '❌ Could not cancel reminder' };
  }
}

async function handleSchedule(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.args.trim()) {
    return {
      response: '❓ Usage: /schedule <text>\n\nExample: /schedule every Monday 9am standup check',
    };
  }

  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
    }

    const parsed = await parseScheduleRequest(ctx.args.trim());
    if (!parsed) {
      return { response: '❌ Could not parse schedule. Try: /schedule every Monday 9am standup' };
    }

    const result = await createSchedule(
      config.github.repoPath,
      parsed.humanReadable,
      parsed.cronExpression,
      { type: 'channel_message', channel: config.channels.active, message: parsed.message },
      config
    );

    return {
      response: `📅 *Schedule created!*\n\n📝 ${parsed.message}\n⏰ ${parsed.humanReadable}\n🆔 \`${result.id}\`\n\n_Runs via GitHub Actions on schedule._`,
      parseMode: 'Markdown',
    };
  } catch (err) {
    return { response: '❌ Failed to create schedule' };
  }
}

async function handleSchedules(ctx: CommandContext): Promise<CommandResult> {
  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
    }

    const schedules = listSchedules(config.github.repoPath);
    if (schedules.length === 0) {
      return { response: '📭 No active schedules. Create one with /schedule' };
    }

    let response = `📅 *Active Schedules (${schedules.length})*\n\n`;
    for (const s of schedules) {
      response += `• \`${s.id}\` — ${s.name}\n  ⏰ \`${s.cronExpression}\`\n`;
    }
    response += `\n_Remove with: /unschedule <id>_`;

    return { response, parseMode: 'Markdown' };
  } catch (err) {
    return { response: '❌ Could not list schedules' };
  }
}

async function handleUnschedule(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.trim();
  if (!id) {
    return { response: '❓ Usage: /unschedule <schedule-id>\n\nGet IDs from /schedules' };
  }

  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled.' };
    }

    const deleted = await deleteSchedule(config.github.repoPath, id);
    return {
      response: deleted
        ? `✅ Schedule \`${id}\` removed`
        : `❌ Schedule \`${id}\` not found`,
      parseMode: 'Markdown',
    };
  } catch (err) {
    return { response: '❌ Could not remove schedule' };
  }
}

async function handleAgent(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.args.trim()) {
    return {
      response: '❓ Usage: /agent <task description>\n\nExample: /agent fix the login bug in auth.ts',
    };
  }

  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
    }

    const result = await createAgentTask(
      config.github.username,
      config.github.repoName,
      ctx.args.trim(),
      ctx.username || ctx.userId.toString()
    );

    return {
      response: `🤖 *Agent task created!*\n\n📋 Issue #${result.issueNumber}\n🔗 ${result.issueUrl}\n\n_Assigned to Copilot Coding Agent._`,
      parseMode: 'Markdown',
    };
  } catch (err) {
    return { response: '❌ Failed to create agent task' };
  }
}

async function handleGithub(ctx: CommandContext): Promise<CommandResult> {
  try {
    const config = await getConfigAsync();

    if (!config.github.enabled) {
      return {
        response: '❌ GitHub integration not enabled.\n\nRun: ghclaw setup',
      };
    }

    const sync = getSyncState();
    const reminders = listReminders(config.github.repoPath);
    const schedules = listSchedules(config.github.repoPath);

    let response = `🐙 *GitHub Status*\n\n`;
    response += `📦 Repo: \`${config.github.username}/${config.github.repoName}\`\n`;
    response += `🔄 Sync: ${sync.lastSync ? `Last ${formatTimeAgo(sync.lastSync.toISOString())}` : 'Not synced yet'}\n`;
    response += `📊 Sync count: ${sync.syncCount}\n`;
    if (sync.lastError) {
      response += `⚠️ Sync error detected (check logs)\n`;
    }
    response += `\n🔔 Reminders: ${reminders.length}\n`;
    response += `📅 Schedules: ${schedules.length}\n`;

    return { response, parseMode: 'Markdown' };
  } catch (err) {
    return { response: '❌ Could not fetch GitHub status' };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function findSessionById(partialId: string): ChronicleSession | null {
  // First try exact match
  let session = getSession(partialId);
  if (session) return session;

  // Try prefix match on recent sessions
  const recent = getRecentSessions(50);
  session = recent.find(s => s.id.startsWith(partialId)) || null;

  return session;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Check if a message is a command and handle it
 * Returns null if not a command
 */
export function parseCommand(text: string): { command: string; args: string } | null {
  if (!text.startsWith('/')) return null;

  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase().split('@')[0]; // Remove @botname suffix
  const args = parts.slice(1).join(' ');

  return { command, args };
}

/**
 * Handle a command message
 */
export async function handleCommand(
  text: string,
  ctx: CommandContext
): Promise<CommandResult | null> {
  const parsed = parseCommand(text);
  if (!parsed) return null;

  const handler = commands[parsed.command];
  if (!handler) {
    // Check if it's a number (session selection)
    const num = parseInt(text.slice(1));
    if (!isNaN(num)) {
      return handleSessionSelection(num, ctx);
    }
    return null; // Unknown command, let it pass through as a message
  }

  return handler({ ...ctx, args: parsed.args });
}

/**
 * Handle numeric selection from /sessions list
 */
async function handleSessionSelection(num: number, ctx: CommandContext): Promise<CommandResult | null> {
  const key = getChatKey(ctx.chatId, ctx.threadId);
  const pending = pendingSelections.get(key);

  if (!pending || Date.now() > pending.expiresAt) {
    return null; // No pending selection or expired
  }

  const index = num - 1;
  if (index < 0 || index >= pending.sessions.length) {
    return {
      response: `❌ Invalid selection. Choose 1-${pending.sessions.length}`,
    };
  }

  const session = pending.sessions[index];
  pendingSelections.delete(key); // Clear selection

  const checkpoint = getLatestCheckpoint(session.id);
  let response = `✅ *Selected session ${num}:*\n\n${formatSessionForTelegram(session)}`;

  if (checkpoint?.overview) {
    response += `\n\n📝 *Context:*\n${checkpoint.overview.slice(0, 200)}...`;
  }

  response += '\n\n_Your next message will continue this session._';

  return {
    response,
    parseMode: 'Markdown',
    switchToSession: session.id,
  };
}

/**
 * Check if a plain number message should select a session
 */
export function checkSessionSelection(text: string, chatId: number, threadId: number): ChronicleSession | null {
  const num = parseInt(text.trim());
  if (isNaN(num)) return null;

  const key = getChatKey(chatId, threadId);
  const pending = pendingSelections.get(key);

  if (!pending || Date.now() > pending.expiresAt) {
    return null;
  }

  const index = num - 1;
  if (index < 0 || index >= pending.sessions.length) {
    return null;
  }

  pendingSelections.delete(key);
  return pending.sessions[index];
}

/**
 * Get list of all command names for bot registration
 * @deprecated Use natural language actions via instructions.md instead.
 * Kept for backward compatibility — hidden fallback only.
 */
export function getCommandList(): { command: string; description: string }[] {
  return [
    { command: 'start', description: 'Welcome message and setup' },
    { command: 'help', description: 'Show all commands' },
    { command: 'new', description: 'Start a fresh session' },
  ];
}

/**
 * Register pending sessions for number-based selection (used by action handlers)
 */
export function setPendingSessions(chatId: number, threadId: number, sessions: ChronicleSession[]): void {
  const key = getChatKey(chatId, threadId);
  pendingSelections.set(key, {
    sessions,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}
