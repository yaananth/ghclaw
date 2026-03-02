/**
 * Action Handlers
 *
 * Executes parsed action blocks. Reuses existing schedule/reminder/session logic.
 * Each handler returns an ActionResult with a response to send back to the user.
 */

import type {
  GhclawAction,
  ActionResult,
  CreateReminderAction,
  CancelReminderAction,
  CreateScheduleAction,
  CancelScheduleAction,
  CreateCodingTaskAction,
  CreateAgenticScheduleAction,
  ListSessionsAction,
  SearchSessionsAction,
  ResumeSessionAction,
} from './types';
import { getConfigAsync, type Config } from '../config';
import { parseScheduleRequest } from '../schedules/parser';
import { createReminder, listReminders, cancelReminder } from '../schedules/reminders';
import { createSchedule, listSchedules, deleteSchedule } from '../schedules/recurring';
import { createCodingAgentTask } from '../copilot/agent';
import { ghAwNew, ghAwCompile } from '../ghaw/executor';
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
  getSessionStats as getTelegramSessionStats,
} from '../memory/session-mapper';
import { getSyncState } from '../github/sync';

/**
 * Execute an action and return the result to send to the user.
 */
export async function executeAction(
  action: GhclawAction,
  context: { chatId: number; threadId: number; userId: number; username?: string }
): Promise<ActionResult> {
  switch (action.action) {
    case 'create_reminder':
      return handleCreateReminder(action);
    case 'list_reminders':
      return handleListReminders();
    case 'cancel_reminder':
      return handleCancelReminder(action);
    case 'create_schedule':
      return handleCreateSchedule(action);
    case 'list_schedules':
      return handleListSchedules();
    case 'cancel_schedule':
      return handleCancelSchedule(action);
    case 'create_coding_task':
      return handleCreateCodingTask(action, context);
    case 'create_agentic_schedule':
      return handleCreateAgenticSchedule(action);
    case 'list_sessions':
      return handleListSessions(action);
    case 'search_sessions':
      return handleSearchSessions(action);
    case 'resume_session':
      return handleResumeSession(action);
    case 'new_session':
      return handleNewSession();
    case 'show_status':
      return handleShowStatus();
    case 'show_github_status':
      return handleShowGithubStatus();
    default:
      return { response: '' };
  }
}

// ============================================================================
// Reminder Handlers
// ============================================================================

async function handleCreateReminder(action: CreateReminderAction): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
  }

  const parsed = await parseScheduleRequest(`${action.schedule} ${action.message}`);
  if (!parsed) {
    return { response: '❌ Could not parse the schedule. Please include a time like "tomorrow 9am" or "Friday 3pm".' };
  }

  const result = await createReminder(
    config.github.repoPath,
    action.message || parsed.message,
    parsed.cronExpression,
    config,
    parsed.humanReadable
  );

  return {
    response: `🔔 *Reminder set!*\n\n📝 ${action.message || parsed.message}\n⏰ ${parsed.humanReadable}\n🆔 \`${result.id}\`\n\n_Will fire via GitHub Actions and self-delete._`,
    parseMode: 'Markdown',
  };
}

async function handleListReminders(): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
  }

  const reminders = listReminders(config.github.repoPath);
  if (reminders.length === 0) {
    return { response: '📭 No active reminders.' };
  }

  let response = `🔔 *Active Reminders (${reminders.length})*\n\n`;
  for (const r of reminders) {
    response += `• \`${r.id}\` — ${r.message}\n  ⏰ \`${r.cronExpression}\`\n`;
  }

  return { response, parseMode: 'Markdown' };
}

async function handleCancelReminder(action: CancelReminderAction): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled.' };
  }

  const cancelled = await cancelReminder(config.github.repoPath, action.id);
  return {
    response: cancelled
      ? `✅ Reminder \`${action.id}\` cancelled`
      : `❌ Reminder \`${action.id}\` not found`,
    parseMode: 'Markdown',
  };
}

// ============================================================================
// Schedule Handlers
// ============================================================================

async function handleCreateSchedule(action: CreateScheduleAction): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
  }

  const parsed = await parseScheduleRequest(`${action.schedule} ${action.message}`);
  if (!parsed) {
    return { response: '❌ Could not parse the schedule. Please include a pattern like "every Monday 9am" or "daily at 3pm".' };
  }

  const result = await createSchedule(
    config.github.repoPath,
    parsed.humanReadable,
    parsed.cronExpression,
    { type: 'telegram_message', message: action.message || parsed.message },
    config
  );

  return {
    response: `📅 *Schedule created!*\n\n📝 ${action.message || parsed.message}\n⏰ ${parsed.humanReadable}\n🆔 \`${result.id}\`\n\n_Runs via GitHub Actions on schedule._`,
    parseMode: 'Markdown',
  };
}

async function handleListSchedules(): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
  }

  const schedules = listSchedules(config.github.repoPath);
  if (schedules.length === 0) {
    return { response: '📭 No active schedules.' };
  }

  let response = `📅 *Active Schedules (${schedules.length})*\n\n`;
  for (const s of schedules) {
    response += `• \`${s.id}\` — ${s.name}\n  ⏰ \`${s.cronExpression}\`\n`;
  }

  return { response, parseMode: 'Markdown' };
}

async function handleCancelSchedule(action: CancelScheduleAction): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled.' };
  }

  const deleted = await deleteSchedule(config.github.repoPath, action.id);
  return {
    response: deleted
      ? `✅ Schedule \`${action.id}\` removed`
      : `❌ Schedule \`${action.id}\` not found`,
    parseMode: 'Markdown',
  };
}

// ============================================================================
// Coding Task Handler
// ============================================================================

async function handleCreateCodingTask(
  action: CreateCodingTaskAction,
  context: { username?: string; userId: number }
): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
  }

  if (!action.repo) {
    return {
      response: '❓ Which repository should I work on? Please specify as `owner/repo`.',
      parseMode: 'Markdown',
    };
  }

  const [owner, repo] = action.repo.includes('/')
    ? action.repo.split('/')
    : [config.github.username, action.repo];

  try {
    const result = await createCodingAgentTask(
      owner,
      repo,
      action.description,
    );

    let response = `🤖 *Coding agent task created!*\n\n📋 Task: \`${result.taskId.slice(0, 12)}\``;
    if (result.sessionId) {
      response += `\n🔗 Session: \`${result.sessionId.slice(0, 12)}\``;
    }
    response += `\n\n_Copilot Coding Agent is working on it. I'll update you when it creates a PR._`;

    return { response, parseMode: 'Markdown' };
  } catch (err: any) {
    return { response: `❌ Failed to create coding task: ${err.message || err}` };
  }
}

// ============================================================================
// Agentic Schedule Handler
// ============================================================================

async function handleCreateAgenticSchedule(action: CreateAgenticScheduleAction): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled. Run: ghclaw setup' };
  }

  try {
    // Create gh-aw workflow in sync repo
    const workflowName = action.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    await ghAwNew(config.github.repoPath, workflowName);

    // TODO: Write the workflow markdown with action.description and action.schedule
    // Then compile it
    await ghAwCompile(config.github.repoPath);

    return {
      response: `🤖 *Agentic schedule created!*\n\n📝 ${action.name}\n⏰ ${action.schedule}\n\n_This workflow uses an LLM agent and runs via GitHub Actions._`,
      parseMode: 'Markdown',
    };
  } catch (err: any) {
    return { response: `❌ Failed to create agentic schedule: ${err.message || err}` };
  }
}

// ============================================================================
// Session Handlers
// ============================================================================

async function handleListSessions(action: ListSessionsAction): Promise<ActionResult> {
  if (!isChronicleAvailable()) {
    return { response: '⚠️ Chronicle not found. Start a Copilot CLI session first.' };
  }

  const sessions = action.hours
    ? getActiveSessions(action.hours)
    : getRecentSessions(10);

  const title = action.hours
    ? `Active Sessions (last ${action.hours}h)`
    : 'Recent Sessions';

  return {
    response: formatSessionsList(sessions, title),
    parseMode: 'Markdown',
    pendingSessions: sessions,
  };
}

async function handleSearchSessions(action: SearchSessionsAction): Promise<ActionResult> {
  if (!isChronicleAvailable()) {
    return { response: '⚠️ Chronicle not found.' };
  }

  const sessions = searchSessions(action.query);

  return {
    response: formatSessionsList(sessions, `Search: "${action.query}"`),
    parseMode: 'Markdown',
    pendingSessions: sessions,
  };
}

async function handleResumeSession(action: ResumeSessionAction): Promise<ActionResult> {
  const session = findSessionById(action.session_id);
  if (!session) {
    return {
      response: `❌ Session not found: \`${action.session_id}\``,
      parseMode: 'Markdown',
    };
  }

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

async function handleNewSession(): Promise<ActionResult> {
  return {
    response: `🆕 *New session mode*\n\nYour next message will start a fresh Copilot session.`,
    parseMode: 'Markdown',
    switchToSession: '__new__',
  };
}

// ============================================================================
// Status Handlers
// ============================================================================

async function handleShowStatus(): Promise<ActionResult> {
  const telegramStats = getTelegramSessionStats();
  const chronicleStats = isChronicleAvailable() ? getChronicleStats() : null;

  let response = `📊 *Gh-Claw Status*\n\n`;
  response += `*Telegram Sessions:*\n`;
  response += `• Active: ${telegramStats.activeSessions}\n`;
  response += `• Total: ${telegramStats.totalSessions}\n`;
  response += `• Messages: ${telegramStats.totalMessages}\n`;
  response += `• DB Size: ${formatBytes(telegramStats.dbSizeBytes)}\n\n`;

  if (chronicleStats) {
    response += `*Copilot Chronicle:*\n`;
    response += `• Sessions: ${chronicleStats.totalSessions}\n`;
    response += `• Total turns: ${chronicleStats.totalTurns}\n`;
    if (chronicleStats.newestSession) {
      response += `• Latest: ${formatTimeAgo(chronicleStats.newestSession)}\n`;
    }
  } else {
    response += `*Copilot Chronicle:* Not found\n`;
  }

  return { response, parseMode: 'Markdown' };
}

async function handleShowGithubStatus(): Promise<ActionResult> {
  const config = await getConfigAsync();
  if (!config.github.enabled) {
    return { response: '❌ GitHub integration not enabled.\n\nRun: ghclaw setup' };
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
}

// ============================================================================
// Helpers
// ============================================================================

function findSessionById(partialId: string): ChronicleSession | null {
  let session = getSession(partialId);
  if (session) return session;

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
