/**
 * GHClaw Main Daemon
 *
 * Polls a messaging channel and processes messages with Copilot CLI.
 * Uses Copilot CLI's built-in session management (Chronicle) for all memory.
 * We only maintain a minimal mapping: channel chat/thread -> Copilot session ID.
 *
 * Channel-agnostic: uses the Channel interface from src/channels/.
 * Telegram is the first implementation; future channels plug in via the registry.
 */

import type { Channel, ChannelMessage, SendOptions } from './channels/channel';
import { getActiveChannel, type ChannelConfig } from './channels/registry';
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
  claimSession,
  getSyncedSessionIds,
  addSyncedSessionId,
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
import { startSyncLoop, writeLeaderClaim, writeHandoffRequest, readLeaderClaim, lookupSessionOwner } from './github/sync';
import { getVersion, getCommitHash } from './version';
import * as fs from 'fs';
import * as path from 'path';
import { loadPrompt } from './prompts';

let isRunning = false;
let isLeader = true; // Start as leader (will yield on 409 or handoff)
let discovery: CopilotDiscovery | null = null;

/**
 * Generate a short topic title from a message using Copilot CLI
 * Returns a 3-6 word summary suitable for a thread/topic name
 */
async function generateTopicTitle(message: string, cliPath: string = 'copilot'): Promise<string> {
  const cwd = process.cwd();
  const dirName = require('path').basename(cwd);
  const titlePrompt = loadPrompt('topic-title', { dirName, message: message.slice(0, 200) });

  const proc = Bun.spawn([cliPath, '-p', titlePrompt, '--silent', '--yolo'], {
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
 * Escape special characters for Markdown
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]`]/g, '\\$&');
}

// Track session overrides: when user explicitly picks a Chronicle session
// Key: "chatId:threadId", Value: Copilot session ID or "__new__" for fresh session
const sessionOverrides = new Map<string, string>();

function getChatKey(chatId: string, threadId: string): string {
  return `${chatId}:${threadId}`;
}

async function main() {
  console.log(`🤖 GHClaw v${getVersion()} (${getCommitHash()}) Starting...\n`);

  const config = await getConfigAsync();

  // Get the active channel via registry (auto-detects configured channels)
  let channelConfig: ChannelConfig;
  try {
    channelConfig = await getActiveChannel(config.channels.active);
  } catch (err) {
    console.error(`❌ ${err}`);
    process.exit(1);
  }
  const channel = channelConfig.channel;
  console.log(`📡 Channel: ${channelConfig.type}`);

  // Start and verify channel connection
  await channel.start();
  const channelInfo = await channel.getInfo();
  console.log(`✅ Connected as @${channelInfo.botUsername || channelInfo.botName} (${channelInfo.botName})`);

  // Load security config (currently Telegram-specific, but checks are skipped for other channels)
  const security = await loadSecurityConfig();

  // Discover copilot features
  console.log('\n🔍 Discovering Copilot CLI features...');
  try {
    discovery = await discoverCopilotFeatures();
    console.log(formatDiscovery(discovery));
  } catch (error) {
    console.warn('⚠️ Could not discover features:', error);
  }

  // Write custom instructions to .github/copilot-instructions.md
  // Copilot CLI reads this automatically — no need to prepend system prompt to messages
  try {
    writeCopilotInstructions();
    console.log(`\n📝 Copilot instructions written to ${getConfigDir()}/AGENTS.md`);
  } catch (err) {
    console.warn(`⚠️ Could not write copilot instructions: ${err}`);
  }

  // Print config
  if (channelConfig.type === 'telegram') {
    console.log('\n🔒 Security Configuration:');
    console.log(`   Block DMs: ${security.blockPrivateMessages}`);
    console.log(`   Allowed Group: ${security.allowedGroupId || 'Any'}`);
    console.log(`   Allowed Users: ${security.allowedUserIds?.join(', ') || 'Any'}`);
    console.log(`   Secret Prefix: ${security.secretPrefix ? 'Enabled' : 'Disabled'}`);
  }

  console.log('\n⚡ Copilot Configuration:');
  console.log(`   Model: ${config.copilot.defaultModel || 'default'}`);
  console.log(`   YOLO Mode: ${config.copilot.yoloMode ? '🔥 ENABLED (--yolo)' : 'disabled'}`);

  console.log('\n💻 Machine:');
  console.log(`   Name: ${config.machine.name}`);
  console.log(`   ID: ${config.machine.id.slice(0, 8)}...`);

  // Session stats
  try {
    const stats = getSessionStats();
    console.log('\n🧠 Sessions:');
    console.log(`   Channel mappings: ${stats.activeSessions} active`);
    console.log(`   Total messages: ${stats.totalMessages}`);

    // Chronicle stats
    if (isChronicleAvailable()) {
      const chronicleStats = getChronicleStats();
      console.log(`   Chronicle sessions: ${chronicleStats.totalSessions}`);
      console.log(`   Chronicle turns (last 5): ${chronicleStats.totalTurns}`);
    } else {
      console.log('   Chronicle: Not found (run copilot once to initialize)');
    }
  } catch {
    console.log('\n🧠 Sessions: Fresh start');
  }

  console.log('\n📡 Starting polling loop...');
  console.log('__DAEMON_READY__'); // Marker for `ghclaw start` to detect readiness
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
    await channel.stop();
    // Remove lock file
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start Chronicle sync in background (if we have an allowed group ID and channel supports threads)
  if (security.allowedGroupId && channel.createThread) {
    const chatId = security.allowedGroupId.toString();
    // Check if group is a forum before starting sync
    if (channel.getChatInfo) {
      channel.getChatInfo(chatId).then(info => {
        if (info.isForum) {
          startChronicleSync(channel, chatId, config).catch(err => {
            console.log(`⚠️ Chronicle sync stopped: ${err}`);
          });
        } else {
          console.log(`ℹ️ Chronicle sync disabled: Group doesn't have Topics enabled`);
          console.log(`   To enable: Group Settings → Topics → Enable`);
        }
      }).catch(() => {
        console.log(`ℹ️ Chronicle sync disabled: Could not check group status`);
      });
    }
  }

  // Start GitHub sync loop in background (also handles leader coordination)
  if (config.github.enabled && config.github.syncEnabled) {
    startSyncLoop(config, () => isRunning,
      // onHandoff: this machine should become leader
      async (pendingMessage) => {
        if (!isLeader) {
          console.log('👑 Handoff received — becoming leader (resuming polling)');
          isLeader = true;
        }
        // Process the pending message that triggered the handoff
        // Run full security check using synthetic TelegramMessage (same as normal path)
        if (pendingMessage) {
          const senderId = pendingMessage.from_user_id;

          // Reject if sender ID is missing (can't verify security)
          if (!senderId) {
            console.log('🚫 Handed-off message blocked: missing sender ID');
            return;
          }

          // Build synthetic TelegramMessage for full security check
          const syntheticMsg = {
            message_id: 0,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: parseInt(pendingMessage.chat_id),
              type: 'supergroup' as const,
            },
            from: {
              id: parseInt(senderId),
              is_bot: false,
              first_name: pendingMessage.from_user || 'Unknown',
            },
            text: pendingMessage.text,
            message_thread_id: pendingMessage.thread_id !== '0' ? parseInt(pendingMessage.thread_id) : undefined,
          };

          const secResult = checkMessageSecurity(syntheticMsg, security);
          if (!secResult.allowed) {
            console.log(`🚫 Handed-off message blocked: ${secResult.reason}`);
            return;
          }

          const sanitizedText = secResult.sanitizedText ?? pendingMessage.text;
          console.log(`📨 Processing handed-off message in chat ${pendingMessage.chat_id} thread ${pendingMessage.thread_id}`);

          const msg: ChannelMessage = {
            id: `handoff-${Date.now()}`,
            chatId: pendingMessage.chat_id,
            threadId: pendingMessage.thread_id,
            text: sanitizedText,
            sender: {
              id: senderId,
              displayName: pendingMessage.from_user || 'Unknown',
              isBot: false,
            },
            timestamp: new Date(),
            isThreaded: !!pendingMessage.thread_id && pendingMessage.thread_id !== '0',
          };
          const chatInfo = channel.getChatInfo ? await channel.getChatInfo(msg.chatId).catch(() => null) : null;
          // Claim session locally so it's ours, and skip ownership check —
          // this message was explicitly routed to us via handoff
          const hChatId = parseInt(pendingMessage.chat_id) || 0;
          const hThreadId = parseInt(pendingMessage.thread_id) || 0;
          const hSession = getOrCreateSession(hChatId, hThreadId, undefined, config.machine.id, config.machine.name);
          claimSession(hSession.id, config.machine.id, config.machine.name);
          processMessageInner(
            channel, msg, sanitizedText, security, config,
            msg.chatId, msg.threadId || '0', chatInfo?.isForum ?? false,
            true // skipOwnershipCheck — handoff was explicitly directed to us
          ).catch(err => {
            console.error(`❌ Failed to process handed-off message: ${err}`);
          });
        }
      },
      // onYield: another machine claimed leadership
      () => {
        if (isLeader) {
          console.log('📤 Another machine claimed leadership — yielding (sync-only mode)');
          isLeader = false;
        }
      },
    ).catch(err => {
      console.log(`⚠️ GitHub sync stopped: ${err}`);
    });
  }

  // Register minimal bot commands (natural language handles the rest)
  if (channel.setCommands) {
    await channel.setCommands([
      { command: 'start', description: 'Welcome message' },
      { command: 'help', description: 'How to use ghclaw' },
      { command: 'new', description: 'Start a fresh session' },
    ]);
    console.log('📋 Bot commands registered (natural language handles the rest)');
  }

  // Main polling loop
  // Leadership is determined by leader.json (source of truth), NOT by Telegram 409.
  // - On start: write leader.json with self, start as leader
  // - 409: become follower (don't touch leader.json — someone else owns it)
  // - Follower probe succeeds: check leader.json — only claim if it says us
  // - Handoff: leader writes leader.json with target's ID, yields
  let followerProbeCount = 0;
  const probeIntervalCycles = 6 + Math.floor(Math.random() * 4); // 30-50s jitter
  const STALE_LEADER_MS = 120_000; // Consider leader dead after 2min without update

  while (isRunning) {
    if (!isLeader) {
      followerProbeCount++;
      if (followerProbeCount < probeIntervalCycles) {
        await sleep(5000);
        continue;
      }
      followerProbeCount = 0;

      // Probe: try to poll — but only claim if leader.json says we're the leader
      try {
        const messages = await channel.poll(1);

        // Poll succeeded (no 409). Check leader.json before claiming.
        if (config.github.enabled && config.github.syncEnabled) {
          const leader = readLeaderClaim(config.github.repoPath);
          if (leader && leader.machine_id === config.machine.id) {
            // leader.json says us — we were handed leadership (e.g., via handoff)
            console.log('👑 leader.json says us — claiming leadership');
            isLeader = true;
          } else if (leader && leader.machine_id !== config.machine.id) {
            // leader.json says someone else. Check if they're stale (dead).
            const claimedAt = new Date(leader.claimed_at).getTime();
            if (Date.now() - claimedAt > STALE_LEADER_MS) {
              console.log(`👑 Leader ${leader.machine_name} stale (${Math.floor((Date.now() - claimedAt) / 1000)}s) — taking over`);
              writeLeaderClaim(config.github.repoPath, config.machine.id, config.machine.name);
              isLeader = true;
            }
            // Otherwise: leader is recent, stay follower (they're probably just between polls)
          } else {
            // No leader.json at all — claim
            console.log('👑 No leader.json — claiming leadership');
            writeLeaderClaim(config.github.repoPath, config.machine.id, config.machine.name);
            isLeader = true;
          }
        } else {
          // No sync repo — just claim on any successful poll
          isLeader = true;
        }

        if (isLeader) {
          // Process any messages from the probe
          for (const message of messages) {
            await processMessage(channel, channelConfig.type, message, security, config);
          }
        }
      } catch (error) {
        const errMsg = String(error);
        if (errMsg.includes('Conflict') || errMsg.includes('409') || errMsg.includes('terminated by other')) {
          // Leader is actively polling — stay follower
        } else {
          console.log(`⚠️ Follower probe error: ${errMsg.slice(0, 100)}`);
        }
      }
      continue;
    }

    try {
      const messages = await channel.poll(config.telegram.pollTimeoutSeconds);

      for (const message of messages) {
        await processMessage(channel, channelConfig.type, message, security, config);
      }
    } catch (error) {
      const errMsg = String(error);
      if (errMsg.includes('Conflict') || errMsg.includes('409') || errMsg.includes('terminated by other')) {
        // Another instance is polling — yield (don't touch leader.json, it's theirs)
        console.log('⚠️  Another instance is polling. Yielding to follower mode...');
        isLeader = false;
        followerProbeCount = 0;
      } else {
        console.error('❌ Polling error:', error);
        await sleep(config.telegram.pollIntervalMs * 5);
      }
    }
  }

  console.log('👋 Daemon stopped');
}

async function processMessage(
  channel: Channel,
  channelType: string,
  message: ChannelMessage,
  security: SecurityConfig,
  config: Config
): Promise<void> {
  const chatId = message.chatId;
  let threadId = message.threadId || '0';
  const user = message.sender;
  const text = message.text;
  const isForum = message.isThreaded;

  if (!text || user.isBot) return;

  // Security check FIRST - before any logging
  // Each channel type runs its own security checks.
  if (channelType === 'telegram') {
    // Telegram: full security check using raw TelegramMessage
    const securityResult = checkMessageSecurity(message.raw as any, security);
    if (!securityResult.allowed) {
      console.log(`🚫 Blocked: ${user.id} - ${securityResult.reason}`);
      return;
    }
    const sanitized = securityResult.sanitizedText ?? text;
    if (!sanitized.trim()) return;
    return processMessageInner(channel, message, sanitized, security, config, chatId, threadId, isForum);
  }

  // Non-Telegram channels: fail-closed until channel-specific security is implemented.
  // Every channel MUST implement its own security check before messages are processed.
  // For now, reject messages from channels that don't have security checks implemented.
  console.log(`🚫 Blocked: Channel type '${channelType}' does not have security checks implemented yet`);
  return;
}

async function processMessageInner(
  channel: Channel,
  message: ChannelMessage,
  prompt: string,
  security: SecurityConfig,
  config: Config,
  chatId: string,
  threadId: string,
  isForum: boolean,
  skipOwnershipCheck: boolean = false
): Promise<void> {
  const user = message.sender;
  const chatIdNum = parseInt(chatId) || 0;
  const threadIdNum = parseInt(threadId) || 0;

  // Acknowledge receipt immediately with 👀 reaction (if supported)
  if (channel.setReaction) {
    channel.setReaction(chatId, message.id, '👀');
  }

  // Check if it's a command
  if (prompt.startsWith('/')) {
    const cmdResult = await handleCommand(prompt, {
      chatId: chatIdNum,
      threadId: threadIdNum,
      userId: parseInt(user.id) || 0,
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

      await channel.send(chatId, cmdResult.response, {
        threadId: threadId !== '0' ? threadId : undefined,
        format: cmdResult.parseMode === 'Markdown' ? 'markdown' : cmdResult.parseMode === 'HTML' ? 'html' : 'plain',
      });
      return;
    }
  }

  // Check if it's a session selection (plain number after /sessions)
  const selectedSession = checkSessionSelection(prompt, chatIdNum, threadIdNum);
  if (selectedSession) {
    console.log(`🔄 Selected Chronicle session: ${selectedSession.id.slice(0, 8)}`);

    // If it's a forum, create a topic for this session
    if (isForum && threadId === '0' && channel.createThread) {
      try {
        const summary = selectedSession.summary?.slice(0, 50).replace(/[\n\r\t]+/g, ' ').trim() || `Session ${selectedSession.id.slice(0, 8)}`;
        const thread = await channel.createThread(chatId, `🤖 [${config.machine.name}] ${summary}`);
        const newThreadId = thread.threadId;
        // Create the mapping row AND set the override for the new topic
        createSessionWithTopic(chatIdNum, parseInt(newThreadId), selectedSession.id, summary, config.machine.id, config.machine.name);
        const newKey = getChatKey(chatId, newThreadId);
        sessionOverrides.set(newKey, selectedSession.id);
        // Clean up the old override (General chat)
        sessionOverrides.delete(getChatKey(chatId, '0'));
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

    await channel.send(chatId, `✅ Switched to: *${escapeMarkdown(selectedSession.summary?.slice(0, 50) || 'Unnamed')}*\n\nYour next message will continue this session.`, {
      threadId: threadId !== '0' ? threadId : undefined,
      format: 'markdown',
    });
    return;
  }

  // Get topic name if available (Telegram-specific, from raw message)
  let topicName: string | undefined;
  if (isForum && message.raw) {
    const raw = message.raw as any;
    topicName = raw.forum_topic_created?.name
      || raw.reply_to_message?.forum_topic_created?.name;
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
    // Default: use channel chat/thread mapping
    const session = getOrCreateSession(chatIdNum, threadIdNum, topicName, config.machine.id, config.machine.name);
    sessionId = session.id;
    sessionName = session.name;

    // Cross-machine ownership check: local SQLite only knows about THIS machine's sessions.
    // When a topic was created by another machine (e.g., Codespace), our local DB won't have it,
    // so getOrCreateSession creates a new row with OUR machine_id. Check the shared sync repo
    // (sessions.json) for the real owner before deciding whether to handoff.
    // SKIP for handoff-received messages — they were explicitly routed to us.
    let effectiveMachineId = session.machine_id;
    let effectiveMachineName = session.machine_name;
    if (!skipOwnershipCheck && config.github.enabled && config.github.syncEnabled) {
      if (!effectiveMachineId || effectiveMachineId === config.machine.id) {
        const repoOwner = lookupSessionOwner(config.github.repoPath, chatIdNum, threadIdNum, config.machine.id);
        if (repoOwner && repoOwner.machine_id !== config.machine.id) {
          effectiveMachineId = repoOwner.machine_id;
          effectiveMachineName = repoOwner.machine_name;
          // Correct local SQLite so future lookups are right and machine file exports are accurate
          claimSession(session.id, repoOwner.machine_id, repoOwner.machine_name);
          console.log(`🔍 [${sessionName}] Sync repo says owner is ${effectiveMachineName} (${effectiveMachineId.slice(0, 8)}) — corrected local DB`);
        }
      }
    }

    // Soft-route: if session belongs to a different machine, trigger handoff
    if (effectiveMachineId && effectiveMachineId !== config.machine.id) {
      const targetName = effectiveMachineName || 'another machine';
      const targetId = effectiveMachineId;

      // If GitHub sync is enabled, trigger a leader handoff
      if (config.github.enabled && config.github.syncEnabled) {
        console.log(`🔀 [${sessionName}] Handing off to ${targetName} (${targetId.slice(0, 8)})`);
        writeHandoffRequest(
          config.github.repoPath,
          config.machine.id, config.machine.name,
          targetId, targetName,
          `Message in session "${sessionName}" owned by ${targetName}`,
          { chat_id: chatId, thread_id: threadId, text: message.text, from_user: message.sender?.displayName, from_user_id: message.sender?.id }
        );
        // Push handoff immediately so target picks it up fast
        const { gitCommitAndPush: pushNow, hasChanges: checkDirty } = await import('./github/repo');
        let pushSucceeded = false;
        try {
          if (await checkDirty(config.github.repoPath)) {
            pushSucceeded = await pushNow(config.github.repoPath, `handoff: ${config.machine.name} → ${targetName}`);
          }
        } catch (pushErr) {
          console.log(`⚠️ Handoff push failed: ${pushErr}`);
        }

        if (pushSucceeded) {
          // Yield leadership — target will pick up the handoff
          isLeader = false;
          await channel.send(chatId, `🔄 Routing to *${targetName}*... it will pick this up shortly.`, {
            threadId: threadId !== '0' ? threadId : undefined,
            format: 'markdown',
          });
          return;
        }
        // Push failed — delete the local handoff.json to prevent stale handoff
        // being published later by the sync loop (which would cause duplicate processing)
        const { clearHandoffRequest } = await import('./github/sync');
        clearHandoffRequest(config.github.repoPath);
        console.log(`⚠️ [${sessionName}] Handoff push failed — claiming locally instead`);
        claimSession(session.id, config.machine.id, config.machine.name);
      }

      // No sync repo — just claim and process locally
      console.log(`🔀 [${sessionName}] Claiming session from ${targetName} (${targetId.slice(0, 8)}) → ${config.machine.name}`);
      claimSession(session.id, config.machine.id, config.machine.name);
    }
  }

  // Auto-create topic for forum groups if message is in main chat (General)
  let targetThreadId = threadId;
  if (isForum && threadId === '0' && !override && channel.createThread) {
    try {
      // Create topic with placeholder name (instant, don't block on AI)
      const machineTag = config.machine.name;
      const placeholder = `🤖 [${machineTag}] ${prompt.slice(0, 30).trim().replace(/[\n\r\t]+/g, ' ') || 'New chat'}`;
      const thread = await channel.createThread(chatId, placeholder);
      targetThreadId = thread.threadId;
      createdTopic = true;

      // Send typing indicator in the new topic immediately so user sees activity
      channel.sendTyping(chatId, targetThreadId).catch(() => {});

      // Update the session mapping to use this topic
      const session = getOrCreateSession(chatIdNum, parseInt(targetThreadId), placeholder, config.machine.id, config.machine.name);
      sessionId = session.id;
      sessionName = session.name;
      setSessionTopicId(session.id, parseInt(targetThreadId));

      console.log(`📌 Auto-created topic ${targetThreadId}`);

      // Pin session ID to the topic for easy reference
      if (channel.pinMessage) {
        const pinMsg = await channel.send(chatId, `📌 Session: \`${session.id}\`\nResume: \`copilot --resume ${session.id}\``, { threadId: targetThreadId, format: 'markdown' });
        channel.pinMessage(chatId, pinMsg.id).catch(() => {});
      }

      // Generate AI title in background and rename
      const topicThreadId = targetThreadId;
      const sessionIdForRename = session.id;
      generateTopicTitle(prompt, config.copilot.cliPath).then(async (title) => {
        try {
          if (channel.renameThread) {
            await channel.renameThread(chatId, topicThreadId, `🤖 [${machineTag}] ${title}`);
          }
          renameSession(sessionIdForRename, title);
          console.log(`📝 Topic ${topicThreadId} renamed to: ${title}`);
        } catch (err) {
          console.log(`⚠️ Could not rename topic: ${err}`);
        }
      }).catch(err => {
        console.log(`⚠️ Title generation failed: ${err}`);
      });

      // Notify in the original location
      await channel.send(chatId, `📌 Created topic for this conversation. Continuing there...`, {});
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
    // Instructions are in .github/copilot-instructions.md (written on startup)
    // Copilot CLI reads them automatically — just send the user's message
    const fullPrompt = prompt;

    // Execute with Copilot CLI, resuming the session if we have one
    const sessionOptions: SessionOptions = {
      model: config.copilot.defaultModel,
      profile: config.copilot.defaultProfile,
      yoloMode: config.copilot.yoloMode,
      sessionId,  // May be undefined for fresh sessions
      cliPath: config.copilot.cliPath,
    };

    const generator = executePrompt(fullPrompt, sessionOptions);

    // Collect full response while streaming to channel
    const sendOpts: SendOptions = {
      threadId: targetThreadId !== '0' ? targetThreadId : undefined,
    };
    const collectedText = await streamToChannelCollecting(channel, chatId, generator, sendOpts);

    // Parse action blocks from the response
    const parsed = parseActionBlocks(collectedText);

    // Execute any actions the LLM triggered
    for (const action of parsed.actions) {
      console.log(`⚡ [${sessionName}] Executing action: ${action.action}`);
      try {
        const result = await executeAction(action, {
          chatId: chatIdNum,
          threadId: parseInt(targetThreadId) || 0,
          userId: parseInt(user.id) || 0,
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
          setPendingSessions(chatIdNum, parseInt(targetThreadId) || 0, result.pendingSessions);
        }

        // Send action result as follow-up message
        if (result.response) {
          await channel.send(chatId, result.response, {
            threadId: targetThreadId !== '0' ? targetThreadId : undefined,
            format: result.parseMode === 'Markdown' ? 'markdown' : result.parseMode === 'HTML' ? 'html' : 'plain',
          });
        }
      } catch (actionErr: any) {
        console.error(`❌ [${sessionName}] Action ${action.action} failed:`, actionErr);
        await channel.send(chatId, `⚠️ Action failed: ${actionErr.message || 'Unknown error'}`, {
          threadId: targetThreadId !== '0' ? targetThreadId : undefined,
        });
      }
    }

    // Update activity for the mapped session (only for default mapping, not overrides)
    if (!override) {
      const session = getOrCreateSession(chatIdNum, parseInt(targetThreadId) || 0, topicName, config.machine.id, config.machine.name);
      updateSessionActivity(session.id);
    }

    console.log(`✅ [${sessionName}] Response sent${createdTopic ? ' (in new topic)' : ''}${parsed.actions.length > 0 ? ` + ${parsed.actions.length} action(s)` : ''}`);

    // Clear the 👀 reaction now that we've responded (if supported)
    if (channel.setReaction) {
      channel.setReaction(chatId, message.id, '');
    }

  } catch (error) {
    console.error(`❌ [${sessionName}] Error:`, error);
    await channel.send(chatId, 'Sorry, an error occurred processing your request.', {
      threadId: targetThreadId !== '0' ? targetThreadId : undefined,
    });
  }
}

/**
 * Write ghclaw AGENTS.md instructions for Copilot CLI to load automatically.
 * Uses the config dir so we don't clobber the user's global copilot-instructions.md.
 * The COPILOT_CUSTOM_INSTRUCTIONS_DIRS env var points Copilot CLI to our dir.
 */
function writeCopilotInstructions(): void {
  // Load instructions from file (contains action block format + available actions)
  let instructions: string;
  try {
    const raw = loadPrompt('instructions');
    instructions = raw.trim();
  } catch {
    instructions = `You are ghclaw, a middle manager AI that coordinates work across GitHub Copilot CLI's capabilities.
Your role: Understand what the user needs, pick the best approach, and execute effectively.`;
  }

  // Build discovery vars
  let extras = '';

  if (discovery) {
    const slashCmds = discovery.features.filter(f => f.type === 'slash_command');
    if (slashCmds.length > 0) {
      extras += '\n\n## Copilot CLI Slash Commands\n\n';
      extras += slashCmds.map(f => `- ${f.name}: ${f.description}`).join('\n');
    }
    if (discovery.tools.length > 0) {
      extras += '\n\n## Copilot CLI Tools\n\n';
      extras += discovery.tools.slice(0, 15).join(', ');
    }
    if (discovery.models.length > 0) {
      extras += '\n\n## Available Models\n\n';
      extras += discovery.models.join(', ');
    }
  }

  const content = instructions + extras + '\n';

  // Write to ghclaw config dir as AGENTS.md
  // Copilot CLI loads AGENTS.md from dirs listed in COPILOT_CUSTOM_INSTRUCTIONS_DIRS
  const instructionsDir = getConfigDir();
  fs.writeFileSync(path.join(instructionsDir, 'AGENTS.md'), content, 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stream response to channel while collecting the full text for action parsing.
 * - Strips action blocks from the displayed text
 * - Returns the full raw text for action block parsing
 * - Works with any Channel implementation
 * - Sends multiple messages when output exceeds channel's max length (no truncation)
 */
async function streamToChannelCollecting(
  channel: Channel,
  chatId: string,
  generator: AsyncGenerator<{ type: string; content: string }>,
  options: SendOptions = {}
): Promise<string> {
  const ACTION_BLOCK_START = '```json:ghclaw-action';
  const ACTION_BLOCK_END = '```';

  const info = await channel.getInfo();
  const maxMessageLength = Math.max(info.maxMessageLength - 100, 500);
  const canEdit = info.supportsEditing;

  let currentMessageId: string | null = null;
  let fullText = '';      // Raw text (includes action blocks)
  let displayText = '';   // Text for current message
  let lastUpdate = 0;
  let chunkCount = 0;
  let inActionBlock = false;
  const minUpdateInterval = 300;
  const charThreshold = 20;

  let lastTypingTime = Date.now();
  try {
    await channel.sendTyping(chatId, options.threadId);
  } catch {
    // Typing indicator is best-effort
  }

  /** Finalize current message and reset for a new one */
  async function splitMessage(): Promise<void> {
    if (!currentMessageId || !displayText.trim()) return;
    try {
      await channel.edit(chatId, currentMessageId, displayText.trim(), options);
    } catch {
      // ignore edit errors
    }
    currentMessageId = null;
    displayText = '';
    lastUpdate = 0;
  }

  for await (const chunk of generator) {
    chunkCount++;

    // Re-send typing indicator every 4 seconds (Telegram's expires after ~5s)
    const now = Date.now();
    if (now - lastTypingTime > 4000) {
      channel.sendTyping(chatId, options.threadId).catch(() => {});
      lastTypingTime = now;
    }

    if (chunk.type === 'text') {
      fullText += chunk.content + '\n';

      // Track whether we're inside an action block to hide it from display
      const line = chunk.content;
      if (line.includes(ACTION_BLOCK_START)) {
        inActionBlock = true;
      } else if (inActionBlock && line.trim() === ACTION_BLOCK_END) {
        inActionBlock = false;
      } else if (!inActionBlock) {
        displayText += line + '\n';

        // Split to new message if current exceeds limit
        if (displayText.length > maxMessageLength) {
          let splitAt = displayText.lastIndexOf('\n', maxMessageLength);
          if (splitAt <= 0) splitAt = maxMessageLength;

          const overflow = displayText.slice(splitAt);
          displayText = displayText.slice(0, splitAt);
          await splitMessage();
          displayText = overflow;
        }

        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdate;
        const shouldUpdate = canEdit &&
          timeSinceLastUpdate >= minUpdateInterval &&
          (!currentMessageId || displayText.length - (lastUpdate > 0 ? 0 : displayText.length) >= charThreshold || displayText.length < 100);

        if (shouldUpdate) {
          try {
            const showText = displayText + ' ▌';
            if (!currentMessageId) {
              const sent = await channel.send(chatId, showText, options);
              currentMessageId = sent.id;
            } else {
              await channel.edit(chatId, currentMessageId, showText, options);
            }
            lastUpdate = now;
          } catch {
            // Ignore edit errors
          }
        }
      }
    } else if (chunk.type === 'done' || chunk.type === 'error') {
      let finalDisplay = displayText.trim() || (chunk.type === 'error' ? `❌ ${chunk.content || 'Unknown error'}` : '✓');

      try {
        if (currentMessageId && canEdit) {
          await channel.edit(chatId, currentMessageId, finalDisplay, options);
        } else {
          await channel.send(chatId, finalDisplay, options);
        }
      } catch {
        await channel.send(chatId, finalDisplay, options);
      }
      break;
    }
  }

  if (chunkCount === 0) {
    await channel.send(chatId, 'No response received.', options);
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
 * Sync Chronicle sessions to channel topics/threads
 * Uses getRecentSessions (top 5 by recency) instead of time-based active sessions.
 * Synced session IDs are persisted in SQLite to survive daemon restarts.
 * Max 3 topics auto-created per sync cycle.
 */
async function syncChronicleToTopics(
  channel: Channel,
  chatId: string,
  config: Config
): Promise<void> {
  if (!isChronicleAvailable()) return;
  if (!channel.createThread) return;

  const chatIdNum = parseInt(chatId) || 0;

  try {
    // Get the 5 most recent Chronicle sessions (regardless of age)
    const chronicleSessions = getChronicleRecentSessions(5);

    if (chronicleSessions.length === 0) return;

    // Get existing sessions with topics
    const existingTopics = getSessionsWithTopics(chatIdNum);
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

        const thread = await channel.createThread(chatId, `🤖 [${config.machine.name}] ${topicName}`);

        createSessionWithTopic(chatIdNum, parseInt(thread.threadId), session.id, topicName, config.machine.id, config.machine.name);

        console.log(`📌 [Sync] Created topic for Chronicle session: ${session.id.slice(0, 8)} -> "${topicName}"`);

        // Send welcome message
        try {
          const fullSummary = session.summary || 'New session';
          const dirInfo = session.cwd ? `\n📁 ${require('path').basename(session.cwd)}` : '';
          const timeInfo = `\n🕐 ${ts}`;
          const sessionInfo = `\n🔗 ${session.id}`;
          const lastMsg = session.lastMessage ? `\n\n💬 Last message:\n${session.lastMessage.slice(0, 300)}` : '';
          const lastReply = session.lastAssistantMessage ? `\n\n🤖 Last reply:\n${session.lastAssistantMessage.slice(0, 300)}` : '';
          const resumeCmd = `\nResume: copilot --resume ${session.id}`;
          const welcomeMsg = await channel.send(chatId, `📚 Session imported from Copilot CLI${dirInfo}${timeInfo}${sessionInfo}\n\n${fullSummary.slice(0, 200)}${lastMsg}${lastReply}\n\n${resumeCmd}\n\nContinue this session by sending a message here.`, {
            threadId: thread.threadId,
          });
          // Pin the welcome message (contains session ID)
          if (channel.pinMessage) {
            channel.pinMessage(chatId, welcomeMsg.id).catch(() => {});
          }
        } catch (msgErr: any) {
          console.log(`⚠️ [Sync] Welcome message failed for ${session.id.slice(0, 8)}: ${msgErr.message}`);
          try {
            await channel.send(chatId, `📚 Session imported from Copilot CLI\n\n${(session.summary || 'New session').slice(0, 200)}\n\nResume: copilot --resume ${session.id}`, {
              threadId: thread.threadId,
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
  channel: Channel,
  chatId: string,
  config: Config
): Promise<void> {
  console.log('🔄 Starting Chronicle sync (every 10s)...');

  while (isRunning) {
    await syncChronicleToTopics(channel, chatId, config);
    await sleep(10000); // Check every 10 seconds
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}

export { main };
