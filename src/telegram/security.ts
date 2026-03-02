/**
 * Telegram Security Module
 * Restricts bot access to authorized groups and users only
 */

import type { TelegramMessage, TelegramChat, TelegramUser } from './client';
import { getConfigAsync } from '../config';

export interface SecurityConfig {
  // Only respond to messages from this group (recommended)
  allowedGroupId?: number;

  // Only respond to these user IDs (additional layer)
  allowedUserIds?: number[];

  // Require messages to start with a secret prefix
  secretPrefix?: string;

  // Block DMs entirely (recommended for security)
  blockPrivateMessages: boolean;

  // Only respond in specific topics/threads
  allowedTopicIds?: number[];
}

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  sanitizedText?: string; // Text with secret prefix removed
}

/**
 * Check if a message passes security checks.
 *
 * Security model: fail-closed. If neither allowedGroupId nor allowedUserIds
 * is configured, ALL messages are rejected. At least one access control
 * must be set (the setup wizard always configures both).
 */
export function checkMessageSecurity(
  message: TelegramMessage,
  config: SecurityConfig
): SecurityCheckResult {
  const chat = message.chat;
  const user = message.from;
  const text = message.text || '';

  // Block DMs if configured
  if (config.blockPrivateMessages && chat.type === 'private') {
    return {
      allowed: false,
      reason: 'Private messages are disabled for this bot',
    };
  }

  // FAIL-CLOSED: If no access controls are configured, reject everything.
  // This prevents the bot from being open to any user/group if setup is incomplete.
  if (!config.allowedGroupId && (!config.allowedUserIds || config.allowedUserIds.length === 0)) {
    return {
      allowed: false,
      reason: 'No access controls configured. Run: ghclaw setup',
    };
  }

  // Check group ID allowlist
  if (config.allowedGroupId && chat.id !== config.allowedGroupId) {
    return {
      allowed: false,
      reason: `Chat ${chat.id} is not in the allowed list`,
    };
  }

  // Check user ID allowlist
  if (config.allowedUserIds && config.allowedUserIds.length > 0) {
    if (!user || !config.allowedUserIds.includes(user.id)) {
      return {
        allowed: false,
        reason: `User ${user?.id} is not authorized`,
      };
    }
  }

  // Check topic/thread allowlist
  // If topics are restricted, ONLY allow messages from those topics
  // (messages without a topic ID are rejected)
  if (config.allowedTopicIds && config.allowedTopicIds.length > 0) {
    const topicId = message.message_thread_id;
    if (!topicId || !config.allowedTopicIds.includes(topicId)) {
      return {
        allowed: false,
        reason: topicId
          ? `Topic ${topicId} is not in the allowed list`
          : 'Message is not from an allowed topic',
      };
    }
  }

  // Check secret prefix
  if (config.secretPrefix) {
    if (!text.startsWith(config.secretPrefix)) {
      return {
        allowed: false,
        reason: 'Message does not contain required secret prefix',
      };
    }
    // Remove prefix from text
    return {
      allowed: true,
      sanitizedText: text.slice(config.secretPrefix.length).trim(),
    };
  }

  return {
    allowed: true,
    sanitizedText: text,
  };
}

/**
 * Load security config from environment
 */
export async function loadSecurityConfig(): Promise<SecurityConfig> {
  const config = await getConfigAsync();

  return {
    allowedGroupId: config.telegram.allowedGroupId,
    allowedUserIds: config.telegram.allowedUserIds,
    secretPrefix: config.telegram.secretPrefix,
    blockPrivateMessages: config.telegram.blockPrivateMessages ?? true,
    allowedTopicIds: config.telegram.allowedTopicIds,
  };
}

/**
 * Format security setup instructions
 */
export function getSecuritySetupInstructions(): string {
  return `
## Telegram Bot Security Setup

### 1. Disable DMs via BotFather (Recommended)
1. Open @BotFather on Telegram
2. Send /mybots and select your bot
3. Go to Bot Settings > Group Privacy
4. Choose "Disable" to prevent reading all messages
5. Go to Bot Settings > Allow Groups?
6. Choose "Disable" if you only want specific group

### 2. Get Your Group ID
1. Add your bot to the group
2. Send a message in the group
3. Run: ghclaw detect-group
4. Copy the group ID to your config

### 3. Get Your User ID
1. Send a message to @userinfobot
2. Or check the logs when you message your bot

### 4. Configure Security
Store via OS keychain:
  ghclaw secrets set telegram-allowed-group <your_group_id>
  ghclaw secrets set telegram-allowed-users <your_user_id>,<other_user_id>

### 5. Optional: Secret Prefix
Add a secret prefix that must start every message:
  ghclaw secrets set telegram-secret-prefix "!ai"

### 6. Topics/Threads (Optional)
If using forum topics, restrict to specific topics via config.json:
  "telegram": { "allowedTopicIds": [123, 456] }
`.trim();
}
