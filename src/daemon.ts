/**
 * GHClaw Main Daemon
 *
 * Polls Telegram and processes messages with Copilot CLI.
 * Uses Copilot CLI's built-in session management (Chronicle) for all memory.
 * We only maintain a minimal mapping: Telegram chat/topic -> Copilot session ID.
 */

import { TelegramClient, streamToTelegram, type TelegramMessage } from './telegram/client';
import { checkMessageSecurity, loadSecurityConfig, type SecurityConfig } from './telegram/security';
import { executePrompt, type SessionOptions } from './copilot/session';
import { discoverCopilotFeatures, formatDiscovery, type CopilotDiscovery } from './copilot/discovery';
import { getConfigAsync, getConfigDir, type Config } from './config';
import {
  getOrCreateSession,
  updateSessionActivity,
  renameSession,
  getSessionStats,
  setSessionTopicId,
  getSessionsWithTopics,
  createSessionWithTopic,
  getSessionMachine,
  getSyncedSessionIds,
  addSyncedSessionId,
  type TelegramSession,
} from './memory/session-mapper';
import {
  handleCommand,
  checkSessionSelection,
  setPendingSessions,
  type CommandResult,
} from './telegram/commands';
import { isChronicleAvailable, getChronicleStats, getRecentSessions as getChronicleRecentSessions } from './copilot/chronicle';
import { parseActionBlocks, executeAction } from './actions';
import { getGhToken } from './github/auth';
import { startSyncLoop } from './github/sync';
import * as fs from 'fs';
import * as path from 'path';

let isRunning = false;
let discovery: CopilotDiscovery | null = null;

/**
 * Generate a short topic title from a message using Copilot CLI
 * Returns a 3-6 word summary suitable for a Telegram topic name
 */
async function generateTopicTitle(message: string, cliPath: string = 'copilot'): Promise<string> {
  const cwd = process.cwd();
  const dirName = require('path').basename(cwd);
  const titlePrompt = `Generate a very short title (3-6 words max) for a Telegram chat topic about this message. The project directory is "${dirName}". Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.\n\nMessage: ${message.slice(0, 200)}`;

  const proc = Bun.spawn([cliPath, '-p', titlePrompt, '--silent'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GITHUB_TOKEN: (await getGhToken()) || '',
    },
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const title = output.trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, ' ').slice(0, 50);
  return title || message.slice(0, 30).trim().replace(/[\n\r]/g, ' ');
}

/**
 * Escape special characters for Telegram Markdown
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]`]/g, '\\$&');
}

// Track session overrides: when user explicitly picks a Chronicle session
// Key: "chatId:threadId", Value: Copilot session ID or "__new__" for fresh session
const sessionOverrides = new Map<string, string>();

function getChatKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

async function main() {
  console.log('🤖 GHClaw Starting...\n');

  const config = await getConfigAsync();
  const client = new TelegramClient(config.telegram.botToken);
  const security = await loadSecurityConfig();

  // Verify bot connection
  const me = await client.getMe();
  console.log(`✅ Connected as @${me.username} (${me.first_name})`);

  // Discover copilot features
  console.log('\n🔍 Discovering Copilot CLI features...');
  try {
    discovery = await discoverCopilotFeatures();
    console.log(formatDiscovery(discovery));
  } catch (error) {
    console.warn('⚠️ Could not discover features:', error);
  }

  // Print config
  console.log('\n🔒 Security Configuration:');
  console.log(`   Block DMs: ${security.blockPrivateMessages}`);
  console.log(`   Allowed Group: ${security.allowedGroupId || 'Any'}`);
  console.log(`   Allowed Users: ${security.allowedUserIds?.join(', ') || 'Any'}`);
  console.log(`   Secret Prefix: ${security.secretPrefix ? 'Enabled' : 'Disabled'}`);

  console.log('\n⚡ Copilot Configuration:');
  console.log(`   Model: ${config.copilot.defaultModel || 'default'}`);
  console.log(`   YOLO Mode: ${config.copilot.yoloMode ? '🔥 ENABLED (--allow-all-tools)' : 'disabled'}`);

  console.log('\n💻 Machine:');
  console.log(`   Name: ${config.machine.name}`);
  console.log(`   ID: ${config.machine.id.slice(0, 8)}...`);

  // Session stats
  try {
    const stats = getSessionStats();
    console.log('\n🧠 Sessions:');
    console.log(`   Telegram mappings: ${stats.activeSessions} active`);
    console.log(`   Total messages: ${stats.totalMessages}`);

    // Chronicle stats
    if (isChronicleAvailable()) {
      const chronicleStats = getChronicleStats();
      console.log(`   Chronicle sessions: ${chronicleStats.totalSessions}`);
      console.log(`   Chronicle turns: ${chronicleStats.totalTurns}`);
    } else {
      console.log('   Chronicle: Not found (run copilot once to initialize)');
    }
  } catch {
    console.log('\n🧠 Sessions: Fresh start');
  }

  console.log('\n📡 Starting polling loop...\n');
  isRunning = true;

  // Write PID file (exclusive create prevents accidental overwrite)
  const lockFile = `${getConfigDir()}/daemon.lock`;
  try {
    fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx', mode: 0o600 });
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      const existingPid = fs.readFileSync(lockFile, 'utf-8').trim();
      const pid = parseInt(existingPid);
      // Validate PID is a real number
      if (!Number.isFinite(pid) || pid <= 0) {
        console.log(`⚠️ Cleaning up invalid lock file (bad PID: ${existingPid.slice(0, 10)})`);
        fs.unlinkSync(lockFile);
        fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx', mode: 0o600 });
      } else {
        // Check if the process is actually still running
        try {
          process.kill(pid, 0); // signal 0 = check existence
          console.error(`❌ Daemon already running (PID ${pid}). Stop it first: ghclaw stop`);
          process.exit(1);
        } catch {
          // Process not running — stale lock file, clean it up
          console.log(`⚠️ Cleaning up stale lock file (PID ${pid} not running)`);
          try {
            fs.unlinkSync(lockFile);
            fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx', mode: 0o600 });
          } catch (retryErr: any) {
            console.error(`❌ Could not acquire lock file: ${retryErr.code}`);
            process.exit(1);
          }
        }
      }
    } else {
      throw err;
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    isRunning = false;
    // Remove lock file
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start Chronicle sync in background (if we have an allowed group ID)
  // Note: Only works if the group has Topics/Forum mode enabled
  if (security.allowedGroupId) {
    // Check if group is a forum before starting sync
    checkForumStatus(client, security.allowedGroupId).then(isForum => {
      if (isForum) {
        startChronicleSync(client, security.allowedGroupId!, config).catch(err => {
          console.log(`⚠️ Chronicle sync stopped: ${err}`);
        });
      } else {
        console.log(`ℹ️ Chronicle sync disabled: Group doesn't have Topics enabled`);
        console.log(`   To enable: Group Settings → Topics → Enable`);
      }
    });
  }

  // Start GitHub sync loop in background
  if (config.github.enabled && config.github.syncEnabled) {
    startSyncLoop(config, () => isRunning).catch(err => {
      console.log(`⚠️ GitHub sync stopped: ${err}`);
    });
  }

  // Register minimal bot commands (natural language handles the rest)
  await client.setMyCommands([
    { command: 'start', description: 'Welcome message' },
    { command: 'help', description: 'How to use ghclaw' },
    { command: 'new', description: 'Start a fresh session' },
  ]);
  console.log('📋 Bot commands registered (natural language handles the rest)');

  // Main polling loop
  while (isRunning) {
    try {
      const updates = await client.getUpdates(config.telegram.pollTimeoutSeconds);

      for (const update of updates) {
        if (update.message) {
          await processMessage(client, update.message, security, config);
        }
      }
    } catch (error) {
      console.error('❌ Polling error:', error);
      await sleep(config.telegram.pollIntervalMs * 5);
    }
  }

  console.log('👋 Daemon stopped');
}

async function processMessage(
  client: TelegramClient,
  message: TelegramMessage,
  security: SecurityConfig,
  config: Config
): Promise<void> {
  const chatId = message.chat.id;
  let threadId = message.message_thread_id || 0;
  const user = message.from;
  const text = message.text;
  const isForum = message.chat.is_forum || false;

  if (!text || !user) return;

  // Security check FIRST - before any logging
  const securityResult = checkMessageSecurity(message, security);
  if (!securityResult.allowed) {
    console.log(`🚫 Blocked: ${user.id} - ${securityResult.reason}`);
    return;
  }

  const prompt = securityResult.sanitizedText ?? text;
  if (!prompt.trim()) return;

  // Acknowledge receipt immediately with 👀 reaction
  client.setReaction(chatId, message.message_id, '👀');

  // Check if it's a command
  if (prompt.startsWith('/')) {
    const cmdResult = await handleCommand(prompt, {
      chatId,
      threadId,
      userId: user.id,
      username: user.username,
      args: '',
    });

    if (cmdResult) {
      // Handle session switch if requested
      if (cmdResult.switchToSession) {
        const key = getChatKey(chatId, threadId);
        sessionOverrides.set(key, cmdResult.switchToSession);
        console.log(`🔄 [${chatId}:${threadId}] Session override: ${cmdResult.switchToSession.slice(0, 8)}`);
      }

      await client.sendMessage(chatId, cmdResult.response, {
        message_thread_id: threadId || undefined,
        parse_mode: cmdResult.parseMode,
      });
      return;
    }
  }

  // Check if it's a session selection (plain number after /sessions)
  const selectedSession = checkSessionSelection(prompt, chatId, threadId);
  if (selectedSession) {
    console.log(`🔄 Selected Chronicle session: ${selectedSession.id.slice(0, 8)}`);

    // If it's a forum, create a topic for this session
    if (isForum && threadId === 0) {
      try {
        const summary = selectedSession.summary?.slice(0, 50).replace(/[\n\r\t]+/g, ' ').trim() || `Session ${selectedSession.id.slice(0, 8)}`;
        const topic = await client.createForumTopic(chatId, `🤖 [${config.machine.name}] ${summary}`);
        const newThreadId = topic.message_thread_id;
        // Create the mapping row AND set the override for the new topic
        createSessionWithTopic(chatId, newThreadId, selectedSession.id, summary, config.machine.id, config.machine.name);
        const newKey = getChatKey(chatId, newThreadId);
        sessionOverrides.set(newKey, selectedSession.id);
        // Clean up the old override (General chat)
        sessionOverrides.delete(getChatKey(chatId, 0));
        threadId = newThreadId;
        console.log(`📌 Created topic ${threadId} for session ${selectedSession.id.slice(0, 8)}`);
      } catch (err) {
        // Fallback: set override on current key
        const key = getChatKey(chatId, threadId);
        sessionOverrides.set(key, selectedSession.id);
        console.log(`⚠️ Could not create topic: ${err}`);
      }
    } else {
      const key = getChatKey(chatId, threadId);
      sessionOverrides.set(key, selectedSession.id);
    }

    await client.sendMessage(chatId, `✅ Switched to: *${escapeMarkdown(selectedSession.summary?.slice(0, 50) || 'Unnamed')}*\n\nYour next message will continue this session.`, {
      message_thread_id: threadId || undefined,
      parse_mode: 'Markdown',
    });
    return;
  }

  // Get topic name if available (check both the message itself and reply_to_message)
  let topicName: string | undefined;
  if (isForum) {
    topicName = message.forum_topic_created?.name
      || message.reply_to_message?.forum_topic_created?.name;
  }

  // Determine which session to use
  const key = getChatKey(chatId, threadId);
  const override = sessionOverrides.get(key);
  let sessionId: string | undefined;
  let sessionName: string;
  let createdTopic = false;

  if (override === '__new__') {
    // User requested a fresh session - clear override and don't resume
    sessionOverrides.delete(key);
    sessionId = undefined;
    sessionName = topicName || `Chat ${chatId}`;
    console.log(`🆕 Starting fresh session for ${key}`);
  } else if (override) {
    // User selected a specific Chronicle session
    sessionId = override;
    sessionName = `Chronicle:${override.slice(0, 8)}`;
  } else {
    // Default: use Telegram chat/thread mapping
    const session = getOrCreateSession(chatId, threadId, topicName, config.machine.id, config.machine.name);
    sessionId = session.id;
    sessionName = session.name;

    // Soft-route: check if this session belongs to a different machine
    if (session.machine_id && session.machine_id !== config.machine.id) {
      const ownerName = escapeMarkdown(session.machine_name || 'another machine');
      console.log(`🔀 [${sessionName}] Redirecting: owned by ${ownerName} (${session.machine_id.slice(0, 8)})`);
      await client.sendMessage(chatId, `💻 This session lives on *${ownerName}*.\nResume there: \`copilot --resume ${session.id}\``, {
        message_thread_id: threadId || undefined,
        parse_mode: 'Markdown',
      });
      return;
    }
  }

  // Auto-create topic for forum groups if message is in main chat (General)
  let targetThreadId = threadId;
  if (isForum && threadId === 0 && !override) {
    try {
      // Create topic with placeholder name (instant, don't block on AI)
      const machineTag = config.machine.name;
      const placeholder = `🤖 [${machineTag}] ${prompt.slice(0, 30).trim().replace(/[\n\r\t]+/g, ' ') || 'New chat'}`;
      const topic = await client.createForumTopic(chatId, placeholder);
      targetThreadId = topic.message_thread_id;
      createdTopic = true;

      // Update the session mapping to use this topic
      const session = getOrCreateSession(chatId, targetThreadId, placeholder, config.machine.id, config.machine.name);
      sessionId = session.id;
      sessionName = session.name;
      setSessionTopicId(session.id, targetThreadId);

      console.log(`📌 Auto-created topic ${targetThreadId}`);

      // Generate AI title in background and rename
      const topicThreadId = targetThreadId;
      const sessionIdForRename = session.id;
      generateTopicTitle(prompt, config.copilot.cliPath).then(async (title) => {
        try {
          await client.editForumTopic(chatId, topicThreadId, `🤖 [${machineTag}] ${title}`);
          renameSession(sessionIdForRename, title);
          console.log(`📝 Topic ${topicThreadId} renamed to: ${title}`);
        } catch (err) {
          console.log(`⚠️ Could not rename topic: ${err}`);
        }
      }).catch(err => {
        console.log(`⚠️ Title generation failed: ${err}`);
      });

      // Notify in the original location
      await client.sendMessage(chatId, `📌 Created topic for this conversation. Continuing there...`, {
        message_thread_id: undefined,
      });
    } catch (err) {
      console.log(`⚠️ Could not auto-create topic: ${err}`);
      // Continue in main chat if topic creation fails
    }
  }

  // Log AFTER security check - redact potential secrets
  const redactedPrompt = prompt
    .replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')  // Long tokens
    .replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]');
  const logText = redactedPrompt.length > 50 ? redactedPrompt.slice(0, 47) + '...' : redactedPrompt;
  console.log(`📩 [${sessionName}] user:${user.id}: ${logText}`);

  try {
    // Build system prompt with capabilities
    const systemPrompt = buildSystemPrompt({ name: sessionName } as TelegramSession);
    const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}`;

    // Execute with Copilot CLI, resuming the session if we have one
    const sessionOptions: SessionOptions = {
      model: config.copilot.defaultModel,
      profile: config.copilot.defaultProfile,
      yoloMode: config.copilot.yoloMode,
      sessionId,  // May be undefined for fresh sessions
      cliPath: config.copilot.cliPath,
    };

    const generator = executePrompt(fullPrompt, sessionOptions);

    // Collect full response while streaming to Telegram
    const collectedText = await streamToTelegramCollecting(client, chatId, generator, {
      message_thread_id: targetThreadId || undefined,
    });

    // Parse action blocks from the response
    const parsed = parseActionBlocks(collectedText);

    // Execute any actions the LLM triggered
    for (const action of parsed.actions) {
      console.log(`⚡ [${sessionName}] Executing action: ${action.action}`);
      try {
        const result = await executeAction(action, {
          chatId,
          threadId: targetThreadId,
          userId: user.id,
          username: user.username,
        });

        // Handle session switches from actions
        if (result.switchToSession) {
          const actionKey = getChatKey(chatId, targetThreadId);
          sessionOverrides.set(actionKey, result.switchToSession);
          console.log(`🔄 [${sessionName}] Action session override: ${result.switchToSession.slice(0, 8)}`);
        }

        // Store pending sessions for number-based selection
        if (result.pendingSessions) {
          setPendingSessions(chatId, targetThreadId, result.pendingSessions);
        }

        // Send action result as follow-up message
        if (result.response) {
          await client.sendMessage(chatId, result.response, {
            message_thread_id: targetThreadId || undefined,
            parse_mode: result.parseMode,
          });
        }
      } catch (actionErr: any) {
        console.error(`❌ [${sessionName}] Action ${action.action} failed:`, actionErr);
        await client.sendMessage(chatId, `⚠️ Action failed: ${actionErr.message || 'Unknown error'}`, {
          message_thread_id: targetThreadId || undefined,
        });
      }
    }

    // Update activity for the mapped session (only for default mapping, not overrides)
    if (!override) {
      const session = getOrCreateSession(chatId, targetThreadId, topicName, config.machine.id, config.machine.name);
      updateSessionActivity(session.id);
    }

    console.log(`✅ [${sessionName}] Response sent${createdTopic ? ' (in new topic)' : ''}${parsed.actions.length > 0 ? ` + ${parsed.actions.length} action(s)` : ''}`);

    // Clear the 👀 reaction now that we've responded
    client.setReaction(chatId, message.message_id, '');

  } catch (error) {
    console.error(`❌ [${sessionName}] Error:`, error);
    await client.sendMessage(chatId, 'Sorry, an error occurred processing your request.', {
      message_thread_id: targetThreadId || undefined,
    });
  }
}

function buildSystemPrompt(session: TelegramSession): string {
  const parts: string[] = [];

  // Sanitize session name to prevent injection
  const safeName = session.name
    .replace(/[\n\r]/g, ' ')
    .replace(/[<>{}[\]"'`]/g, '')
    .replace(/system|assistant|user|developer|tool/gi, '')
    .trim()
    .slice(0, 50);

  // Load instructions from file (contains action block format + available actions)
  const instructionsPath = path.resolve(__dirname, '..', 'instructions.md');
  try {
    const instructions = fs.readFileSync(instructionsPath, 'utf-8');
    // Strip markdown headers for cleaner prompt
    const cleaned = instructions
      .replace(/^#+\s+.*$/gm, '')  // Remove # headers
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .trim();
    parts.push(cleaned);
  } catch {
    // Fallback if file not found
    parts.push(`You are ghclaw, a middle manager AI that coordinates work across GitHub Copilot CLI's capabilities.
Your role: Understand what the user needs, pick the best approach, and execute effectively.`);
  }

  parts.push(`\nSession: "${safeName}"`);

  // Capabilities from discovery (auto-discovered from Copilot CLI at startup)
  if (discovery) {
    const slashCmds = discovery.features.filter(f => f.type === 'slash_command');

    if (slashCmds.length > 0) {
      parts.push('\nCopilot CLI slash commands you can use inside sessions:');
      for (const feature of slashCmds) {
        parts.push(`- ${feature.name}: ${feature.description}`);
      }
    }

    if (discovery.tools.length > 0) {
      parts.push('\nCopilot CLI tools available:');
      parts.push(discovery.tools.slice(0, 15).join(', '));
    }
    if (discovery.models.length > 0) {
      parts.push('\nAvailable models (pick best for task): ' + discovery.models.join(', '));
    }
  }

  return parts.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stream response to Telegram while collecting the full text for action parsing.
 * Same streaming behavior as streamToTelegram but:
 * - Strips action blocks from the displayed text
 * - Returns the full raw text for action block parsing
 */
async function streamToTelegramCollecting(
  client: TelegramClient,
  chatId: number,
  generator: AsyncGenerator<{ type: string; content: string }>,
  options: { message_thread_id?: number; parse_mode?: string } = {}
): Promise<string> {
  const ACTION_BLOCK_START = '```json:ghclaw-action';
  const ACTION_BLOCK_END = '```';

  let messageId: number | null = null;
  let fullText = '';      // Raw text (includes action blocks)
  let displayText = '';   // Text shown to user (action blocks stripped)
  let lastUpdate = 0;
  let chunkCount = 0;
  let inActionBlock = false;
  const minUpdateInterval = 300;
  const charThreshold = 20;
  const maxMessageLength = 4000;
  let truncated = false;

  await client.sendTyping(chatId, options.message_thread_id);

  for await (const chunk of generator) {
    chunkCount++;

    if (chunk.type === 'text') {
      fullText += chunk.content + '\n';

      // Track whether we're inside an action block to hide it from display
      const line = chunk.content;
      if (line.includes(ACTION_BLOCK_START)) {
        inActionBlock = true;
      } else if (inActionBlock && line.trim() === ACTION_BLOCK_END) {
        inActionBlock = false;
      } else if (!inActionBlock) {
        const prevDisplayLen = displayText.length;
        displayText += line + '\n';
        const newChars = displayText.length - prevDisplayLen;

        if (displayText.length > maxMessageLength && !truncated) {
          truncated = true;
          displayText = displayText.slice(0, maxMessageLength);
        }

        if (truncated && prevDisplayLen >= maxMessageLength) continue;

        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdate;
        const shouldUpdate = timeSinceLastUpdate >= minUpdateInterval &&
          (!messageId || newChars >= charThreshold || displayText.length < 100);

        if (shouldUpdate) {
          try {
            const showText = displayText + ' ▌';
            if (!messageId) {
              const msg = await client.sendMessage(chatId, showText, options as any);
              messageId = msg.message_id;
            } else {
              await client.editMessage(chatId, messageId, showText, {
                parse_mode: (options as any).parse_mode,
                message_thread_id: options.message_thread_id,
              });
            }
            lastUpdate = now;
          } catch {
            // Ignore edit errors
          }
        }
      }
    } else if (chunk.type === 'done' || chunk.type === 'error') {
      let finalDisplay = displayText.trim() || (chunk.type === 'error' ? `❌ ${chunk.content || 'Unknown error'}` : '✓');

      if (truncated) {
        finalDisplay = finalDisplay.slice(0, maxMessageLength) + '\n\n_(Output truncated — use terminal for full response)_';
      }

      try {
        if (messageId) {
          await client.editMessage(chatId, messageId, finalDisplay, {
            parse_mode: (options as any).parse_mode,
            message_thread_id: options.message_thread_id,
          });
        } else {
          await client.sendMessage(chatId, finalDisplay, options as any);
        }
      } catch {
        await client.sendMessage(chatId, finalDisplay, options as any);
      }
      break;
    }
  }

  if (chunkCount === 0) {
    await client.sendMessage(chatId, 'No response received.', options as any);
  }

  return fullText;
}

/**
 * Format a timestamp for topic names: "Mar01 2:14pm"
 */
function formatShortTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  const min = m.toString().padStart(2, '0');
  return `${month}${day} ${hour}:${min}${ampm}`;
}

// ============================================================================
// Chronicle Sync - Auto-create topics for new Chronicle sessions
// ============================================================================

/**
 * Check if a group has Topics/Forum mode enabled
 */
async function checkForumStatus(client: TelegramClient, chatId: number): Promise<boolean> {
  try {
    const chat = await client.getChat(chatId);
    return chat.is_forum === true;
  } catch {
    return false;
  }
}

/**
 * Sync Chronicle sessions to Telegram topics
 * Uses getRecentSessions (top 5 by recency) instead of time-based active sessions.
 * Synced session IDs are persisted in SQLite to survive daemon restarts.
 * Max 3 topics auto-created per sync cycle.
 */
async function syncChronicleToTopics(
  client: TelegramClient,
  chatId: number,
  config: Config
): Promise<void> {
  if (!isChronicleAvailable()) return;

  try {
    // Get the 5 most recent Chronicle sessions (regardless of age)
    const chronicleSessions = getChronicleRecentSessions(5);

    if (chronicleSessions.length === 0) return;

    // Get existing Telegram sessions with topics
    const existingTopics = getSessionsWithTopics(chatId);
    const existingIds = new Set(existingTopics.map(s => s.id));

    // Get persisted synced IDs from SQLite (survives daemon restarts)
    const syncedIds = getSyncedSessionIds();

    let createdCount = 0;
    const maxCreate = 3;

    for (const session of chronicleSessions) {
      if (createdCount >= maxCreate) break;

      // Skip if already synced or has a topic
      if (syncedIds.has(session.id) || existingIds.has(session.id)) {
        continue;
      }

      // Persist as synced (before attempting — prevents retry loops)
      addSyncedSessionId(session.id);

      try {
        const ts = formatShortTimestamp(session.updated_at);
        const dir = session.cwd ? require('path').basename(session.cwd) : null;
        const summary = session.summary?.slice(0, 30).replace(/[\n\r\t]+/g, ' ').trim() || `Session ${session.id.slice(0, 8)}`;
        const topicParts = [ts, dir, summary].filter(Boolean);
        const topicName = topicParts.join(' · ').slice(0, 50);

        const topic = await client.createForumTopic(chatId, `🤖 [${config.machine.name}] ${topicName}`);

        createSessionWithTopic(chatId, topic.message_thread_id, session.id, topicName, config.machine.id, config.machine.name);

        console.log(`📌 [Sync] Created topic for Chronicle session: ${session.id.slice(0, 8)} -> "${topicName}"`);

        // Send welcome message
        try {
          const fullSummary = session.summary || 'New session';
          const dirInfo = session.cwd ? `\n📁 ${require('path').basename(session.cwd)}` : '';
          const timeInfo = `\n🕐 ${ts}`;
          const sessionInfo = `\n🔗 ${session.id}`;
          const lastMsg = session.lastMessage ? `\n\n💬 Last message:\n${session.lastMessage.slice(0, 300)}` : '';
          const resumeCmd = `\nResume: copilot --resume ${session.id}`;
          await client.sendMessage(chatId, `📚 Session imported from Copilot CLI${dirInfo}${timeInfo}${sessionInfo}\n\n${fullSummary.slice(0, 200)}${lastMsg}\n\n${resumeCmd}\n\nContinue this session by sending a message here.`, {
            message_thread_id: topic.message_thread_id,
          });
        } catch (msgErr: any) {
          console.log(`⚠️ [Sync] Welcome message failed for ${session.id.slice(0, 8)}: ${msgErr.message}`);
          try {
            await client.sendMessage(chatId, `📚 Session imported from Copilot CLI\n\n${(session.summary || 'New session').slice(0, 200)}\n\nResume: copilot --resume ${session.id}`, {
              message_thread_id: topic.message_thread_id,
            });
          } catch { /* topic exists, message is optional */ }
        }

        createdCount++;
        await sleep(500);
      } catch (err: any) {
        if (err.message?.includes('CHAT_NOT_MODIFIED') || err.message?.includes('not a forum')) {
          console.log(`⚠️ [Sync] Group doesn't have Topics enabled. Enable via Group Settings → Topics`);
          return;
        }
        console.log(`⚠️ [Sync] Could not create topic for ${session.id.slice(0, 8)}: ${err.message || err}`);
      }
    }

    if (createdCount > 0) {
      console.log(`📌 [Sync] Created ${createdCount} new topic(s)`);
    }
  } catch (err) {
    console.log(`⚠️ [Sync] Chronicle sync error: ${err}`);
  }
}

/**
 * Start the Chronicle sync loop
 * Runs every 30 seconds to check for new sessions
 */
async function startChronicleSync(
  client: TelegramClient,
  chatId: number,
  config: Config
): Promise<void> {
  console.log('🔄 Starting Chronicle sync (every 30s)...');

  while (isRunning) {
    await syncChronicleToTopics(client, chatId, config);
    await sleep(30000); // Check every 30 seconds
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}

export { main };
