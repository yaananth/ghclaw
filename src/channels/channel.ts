/**
 * Channel Interface
 *
 * Abstraction layer for messaging channels. Telegram is the first implementation.
 * Future channels: Discord, Slack, CLI, etc.
 *
 * The interface captures the core messaging operations that ghclaw needs:
 * - Receiving incoming messages (polling or webhook)
 * - Sending messages (with optional threading)
 * - Editing messages (for streaming updates)
 * - Typing indicators
 */

// ============================================================================
// Core Types
// ============================================================================

/** A normalized incoming message from any channel */
export interface ChannelMessage {
  /** Unique message ID within the channel */
  id: string;
  /** Channel-specific chat/conversation ID */
  chatId: string;
  /** Thread/topic ID if applicable (e.g., Telegram forum topics) */
  threadId?: string;
  /** Message text content */
  text: string;
  /** Sender info */
  sender: {
    id: string;
    username?: string;
    displayName: string;
    isBot: boolean;
  };
  /** Original timestamp */
  timestamp: Date;
  /** Whether the chat supports threading/topics */
  isThreaded: boolean;
  /** Channel-specific raw data (for channel-specific features) */
  raw?: unknown;
}

/** Options for sending a message */
export interface SendOptions {
  /** Thread/topic to send in */
  threadId?: string;
  /** Reply to a specific message */
  replyTo?: string;
  /** Text formatting mode */
  format?: 'plain' | 'markdown' | 'html';
  /** Suppress notifications */
  silent?: boolean;
}

/** Result of sending a message */
export interface SentMessage {
  /** Channel-assigned message ID */
  id: string;
  /** Chat/conversation ID */
  chatId: string;
  /** Thread ID if sent in a thread */
  threadId?: string;
}

/** A chunk from streaming a response */
export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  content: string;
}

/** Channel identity info */
export interface ChannelInfo {
  /** Channel type identifier */
  type: string;
  /** Bot/user display name on the channel */
  botName: string;
  /** Bot username/handle */
  botUsername?: string;
  /** Whether the channel supports threading */
  supportsThreads: boolean;
  /** Whether the channel supports message editing (for streaming) */
  supportsEditing: boolean;
  /** Max message length */
  maxMessageLength: number;
}

// ============================================================================
// Channel Interface
// ============================================================================

/**
 * Abstract channel interface that all messaging platforms implement.
 */
export interface Channel {
  /** Get channel info/capabilities */
  getInfo(): Promise<ChannelInfo>;

  /**
   * Poll for new messages.
   * Returns an array of new messages since last poll.
   * Implementations handle their own offset/cursor tracking.
   */
  poll(timeoutSeconds?: number): Promise<ChannelMessage[]>;

  /** Send a text message */
  send(chatId: string, text: string, options?: SendOptions): Promise<SentMessage>;

  /** Edit an existing message (for streaming updates) */
  edit(chatId: string, messageId: string, text: string, options?: SendOptions): Promise<void>;

  /** Send a typing/activity indicator */
  sendTyping(chatId: string, threadId?: string): Promise<void>;

  /** Start the channel (connect, verify auth, etc.) */
  start(): Promise<void>;

  /** Stop the channel (cleanup, disconnect) */
  stop(): Promise<void>;

  // ---- Optional capabilities (channel-specific) ----

  /** React to a message with an emoji (e.g. 👀 acknowledgment). Pass empty string to clear. */
  setReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /** Create a thread/topic in the channel */
  createThread?(chatId: string, name: string): Promise<{ threadId: string; name: string }>;

  /** Rename an existing thread/topic */
  renameThread?(chatId: string, threadId: string, name: string): Promise<void>;

  /** Get chat/group info (e.g. check if forum mode is enabled) */
  getChatInfo?(chatId: string): Promise<{ isForum: boolean; title?: string }>;

  /** Register bot commands (shown in command menu) */
  setCommands?(commands: { command: string; description: string }[]): Promise<void>;

  /** Delete webhook (needed for polling-based channels) */
  deleteWebhook?(): Promise<void>;

  /** Pin a message in a chat/thread */
  pinMessage?(chatId: string, messageId: string): Promise<void>;
}

// ============================================================================
// Stream Helper
// ============================================================================

/**
 * Stream a generator response to a channel with live updates.
 * Handles rate limiting and message length limits.
 * Sends multiple messages when output exceeds max length (no truncation).
 * Works with any Channel implementation that supports editing.
 */
export async function streamToChannel(
  channel: Channel,
  chatId: string,
  generator: AsyncGenerator<StreamChunk>,
  options: SendOptions = {}
): Promise<void> {
  const info = await channel.getInfo();
  const maxLen = Math.max(info.maxMessageLength - 100, 500);
  const canEdit = info.supportsEditing;

  let currentMessageId: string | null = null;
  let fullText = '';
  let lastUpdate = 0;
  let chunkCount = 0;
  const minUpdateInterval = 300;
  const charThreshold = 20;

  try {
    await channel.sendTyping(chatId, options.threadId);
  } catch {
    // Typing indicator is best-effort, don't abort stream
  }

  /** Finalize current message and reset for a new one */
  async function splitMessage(): Promise<void> {
    if (!currentMessageId || !fullText.trim()) return;
    try {
      await channel.edit(chatId, currentMessageId, fullText.trim(), options);
    } catch {
      // ignore edit errors
    }
    currentMessageId = null;
    fullText = '';
    lastUpdate = 0;
  }

  for await (const chunk of generator) {
    chunkCount++;

    if (chunk.type === 'text') {
      fullText += chunk.content + '\n';

      // Split to new message if current exceeds limit
      if (fullText.length > maxLen) {
        let splitAt = fullText.lastIndexOf('\n', maxLen);
        if (splitAt <= 0) splitAt = maxLen;

        const overflow = fullText.slice(splitAt);
        fullText = fullText.slice(0, splitAt);
        await splitMessage();
        fullText = overflow;
      }

      const now = Date.now();
      const timeSinceLastUpdate = now - lastUpdate;
      const shouldUpdate = canEdit &&
        timeSinceLastUpdate >= minUpdateInterval &&
        (!currentMessageId || fullText.length >= charThreshold || fullText.length < 100);

      if (shouldUpdate) {
        try {
          const displayText = fullText + ' ▌';
          if (!currentMessageId) {
            const sent = await channel.send(chatId, displayText, options);
            currentMessageId = sent.id;
          } else {
            await channel.edit(chatId, currentMessageId, displayText, options);
          }
          lastUpdate = now;
        } catch {
          // Ignore edit errors
        }
      }
    } else if (chunk.type === 'done' || chunk.type === 'error') {
      let finalText = fullText.trim() || (chunk.type === 'error' ? `Error: ${chunk.content || 'Unknown'}` : 'Done');

      try {
        if (currentMessageId && canEdit) {
          await channel.edit(chatId, currentMessageId, finalText, options);
        } else {
          await channel.send(chatId, finalText, options);
        }
      } catch {
        await channel.send(chatId, finalText, options);
      }
      break;
    }
  }

  if (chunkCount === 0) {
    await channel.send(chatId, 'No response received.', options);
  }
}
