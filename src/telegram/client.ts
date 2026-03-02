/**
 * Telegram Client with Security
 * Handles polling, message sending, topics/threads, and streaming updates
 */

import { getConfig } from '../config';

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  message_thread_id?: number; // Topic/thread ID
  reply_to_message?: TelegramMessage;
  forum_topic_created?: {
    name: string;
  };
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  is_forum?: boolean; // Indicates topics are enabled
}

export interface SendMessageOptions {
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  message_thread_id?: number; // Reply to specific topic
  reply_to_message_id?: number;
  disable_notification?: boolean;
}

export class TelegramClient {
  private token: string;
  private baseUrl: string;
  private lastUpdateId = 0;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Poll for new updates (long polling)
   */
  async getUpdates(timeout = 30): Promise<TelegramUpdate[]> {
    // Telegram API max timeout is 50 seconds
    const clampedTimeout = Math.min(timeout, 50);
    const params = new URLSearchParams({
      timeout: clampedTimeout.toString(),
      offset: (this.lastUpdateId + 1).toString(),
      allowed_updates: JSON.stringify(['message']),
    });

    const response = await fetch(`${this.baseUrl}/getUpdates?${params}`);
    const data = await response.json() as { ok: boolean; result: TelegramUpdate[] };

    if (!data.ok) {
      throw new Error('Failed to get updates');
    }

    // Update offset
    if (data.result.length > 0) {
      this.lastUpdateId = Math.max(...data.result.map(u => u.update_id));
    }

    return data.result;
  }

  /**
   * Delete any existing webhook (required for getUpdates to work)
   */
  async deleteWebhook(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/deleteWebhook`);
    const data = await response.json() as { ok: boolean };
    return data.ok;
  }

  /**
   * Flush any pending updates (clear the queue)
   */
  async flushUpdates(): Promise<void> {
    // Get updates without offset to find the latest update_id
    const response = await fetch(`${this.baseUrl}/getUpdates?timeout=1`);
    const data = await response.json() as { ok: boolean; result: TelegramUpdate[] };
    if (data.ok && data.result.length > 0) {
      // Set offset to latest + 1 to mark all as read
      const maxId = Math.max(...data.result.map(u => u.update_id));
      this.lastUpdateId = maxId;
      // Confirm by calling with new offset
      await fetch(`${this.baseUrl}/getUpdates?offset=${maxId + 1}&timeout=1`);
    }
  }

  /**
   * Send a message
   */
  async sendMessage(
    chatId: number,
    text: string,
    options: SendMessageOptions = {}
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096), // Telegram limit
      ...options,
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; result: TelegramMessage; description?: string };
    if (!data.ok) {
      throw new Error(`Failed to send message: ${data.description}`);
    }

    return data.result;
  }

  /**
   * Edit a message (for streaming updates)
   */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    options: Omit<SendMessageOptions, 'reply_to_message_id'> = {}
  ): Promise<TelegramMessage | boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096),
      ...options,
    };

    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; result: TelegramMessage | boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Failed to edit message: ${data.description || 'Unknown error'}`);
    }
    return data.result;
  }

  /**
   * React to a message with an emoji (e.g. 👀 to acknowledge receipt)
   * Pass empty string to clear reactions.
   */
  async setReaction(chatId: number, messageId: number, emoji: string = '👀'): Promise<void> {
    const reaction = emoji ? [{ type: 'emoji', emoji }] : [];
    await fetch(`${this.baseUrl}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction,
      }),
    }).catch(() => {}); // Best-effort, don't block on failure
  }

  /**
   * Send typing indicator
   */
  async sendTyping(chatId: number, threadId?: number): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      action: 'typing',
    };
    if (threadId) {
      body.message_thread_id = threadId;
    }

    await fetch(`${this.baseUrl}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Register bot commands with Telegram (shows in / menu)
   */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = await response.json() as { ok: boolean };
    return data.ok;
  }

  /**
   * Get bot info
   */
  async getMe(): Promise<TelegramUser> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const data = await response.json() as { ok: boolean; result: TelegramUser; description?: string };
    if (!data.ok) {
      throw new Error(`Failed to get bot info: ${data.description || 'Invalid token'}`);
    }
    return data.result;
  }

  /**
   * Get chat information
   */
  async getChat(chatId: number): Promise<TelegramChat & { is_forum?: boolean }> {
    const response = await fetch(`${this.baseUrl}/getChat?chat_id=${chatId}`);
    const data = await response.json() as { ok: boolean; result: TelegramChat & { is_forum?: boolean }; description?: string };
    if (!data.ok) {
      throw new Error(`Failed to get chat: ${data.description}`);
    }
    return data.result;
  }

  /**
   * Create a topic in a forum group
   */
  async createForumTopic(
    chatId: number,
    name: string,
    iconColor?: number
  ): Promise<{ message_thread_id: number; name: string }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      name: name.slice(0, 128), // Telegram topic name limit
    };
    if (iconColor) {
      body.icon_color = iconColor;
    }

    const response = await fetch(`${this.baseUrl}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; result?: { message_thread_id: number; name: string }; description?: string };

    if (!data.ok || !data.result) {
      throw new Error(`Failed to create topic: ${data.description || 'Unknown error'}`);
    }

    return data.result;
  }

  /**
   * Edit a forum topic name
   */
  async editForumTopic(
    chatId: number,
    messageThreadId: number,
    name: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      name: name.slice(0, 128),
    };

    const response = await fetch(`${this.baseUrl}/editForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; description?: string };
    return data.ok;
  }

  /**
   * Pin a message in a chat
   */
  async pinChatMessage(chatId: number, messageId: number, options: { disable_notification?: boolean } = {}): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    };
    const response = await fetch(`${this.baseUrl}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Failed to pin message: ${data.description || 'Unknown error'}`);
    }
  }

  /**
   * Delete a forum topic and all its messages
   */
  async deleteForumTopic(
    chatId: number,
    messageThreadId: number,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_thread_id: messageThreadId,
    };

    const response = await fetch(`${this.baseUrl}/deleteForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; description?: string };
    return data.ok;
  }
}

/**
 * Stream response to Telegram with live updates
 * Handles Telegram's 4096-char limit by truncating with a resume hint
 */
export async function streamToTelegram(
  client: TelegramClient,
  chatId: number,
  generator: AsyncGenerator<{ type: string; content: string }>,
  options: SendMessageOptions = {}
): Promise<void> {
  let messageId: number | null = null;
  let fullText = '';
  let lastUpdate = 0;
  let chunkCount = 0;
  const minUpdateInterval = 300; // Minimum 300ms between edits (Telegram rate limit)
  const charThreshold = 20; // Update after this many new characters
  const maxMessageLength = 4000; // Leave room for truncation notice (Telegram limit is 4096)
  let truncated = false;

  await client.sendTyping(chatId, options.message_thread_id);

  for await (const chunk of generator) {
    chunkCount++;

    if (chunk.type === 'text') {
      const prevLength = fullText.length;
      fullText += chunk.content + '\n';
      const newChars = fullText.length - prevLength;

      // Check if we've exceeded the message limit
      if (fullText.length > maxMessageLength && !truncated) {
        truncated = true;
        fullText = fullText.slice(0, maxMessageLength);
      }

      // Stop updating display if already truncated
      if (truncated && prevLength >= maxMessageLength) continue;

      const now = Date.now();
      const timeSinceLastUpdate = now - lastUpdate;

      // Update if: enough time has passed AND (first message OR enough new chars)
      const shouldUpdate = timeSinceLastUpdate >= minUpdateInterval &&
        (!messageId || newChars >= charThreshold || fullText.length < 100);

      if (shouldUpdate) {
        try {
          const displayText = truncated ? fullText + ' ▌' : fullText + ' ▌';
          if (!messageId) {
            // Send initial message with typing cursor
            const msg = await client.sendMessage(chatId, displayText, options);
            messageId = msg.message_id;
          } else {
            // Edit existing message
            await client.editMessage(chatId, messageId, displayText, {
              parse_mode: options.parse_mode,
              message_thread_id: options.message_thread_id,
            });
          }
          lastUpdate = now;
        } catch (err) {
          // Ignore edit errors (message not modified, etc)
        }
      }
    } else if (chunk.type === 'done' || chunk.type === 'error') {
      let finalText = fullText.trim() || (chunk.type === 'error' ? `❌ ${chunk.content || 'Unknown error'}` : '✓');

      if (truncated) {
        finalText = finalText.slice(0, maxMessageLength) + '\n\n_(Output truncated — use terminal for full response)_';
      }

      // ALWAYS send a response
      try {
        if (messageId) {
          await client.editMessage(chatId, messageId, finalText, {
            parse_mode: options.parse_mode,
            message_thread_id: options.message_thread_id,
          });
        } else {
          // No streaming message was created - send final response now
          await client.sendMessage(chatId, finalText, options);
        }
      } catch (err) {
        // If edit fails, send new message
        await client.sendMessage(chatId, finalText, options);
      }
      break; // Done processing, exit the generator loop
    }
  }

  // Fallback: if no chunks at all, send something
  if (chunkCount === 0) {
    await client.sendMessage(chatId, 'No response received.', options);
  }
}
