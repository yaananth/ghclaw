/**
 * Telegram Channel Implementation
 *
 * Wraps the existing TelegramClient to implement the Channel interface.
 * This adapter translates between the generic Channel types and
 * Telegram-specific types (TelegramMessage, TelegramUpdate, etc.).
 */

import {
  type Channel,
  type ChannelInfo,
  type ChannelMessage,
  type SendOptions,
  type SentMessage,
} from './channel';
import { TelegramClient, type TelegramMessage, type TelegramUpdate, type SendMessageOptions } from '../telegram/client';

export class TelegramChannel implements Channel {
  private client: TelegramClient;
  private botToken: string;
  private botInfo: { username: string; firstName: string } | null = null;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.client = new TelegramClient(botToken);
  }

  /** Expose the underlying TelegramClient for Telegram-specific operations */
  getClient(): TelegramClient {
    return this.client;
  }

  async getInfo(): Promise<ChannelInfo> {
    if (!this.botInfo) {
      const me = await this.client.getMe();
      this.botInfo = { username: me.username || '', firstName: me.first_name };
    }

    return {
      type: 'telegram',
      botName: this.botInfo.firstName,
      botUsername: this.botInfo.username,
      supportsThreads: true,  // Telegram forum topics
      supportsEditing: true,
      maxMessageLength: 4096,
    };
  }

  async poll(timeoutSeconds = 30): Promise<ChannelMessage[]> {
    const updates = await this.client.getUpdates(timeoutSeconds);
    return updates
      .filter(u => u.message?.text && u.message.from)
      .map(u => this.normalizeMessage(u.message!));
  }

  async send(chatId: string, text: string, options: SendOptions = {}): Promise<SentMessage> {
    const telegramOptions = this.toTelegramOptions(options);
    const msg = await this.client.sendMessage(parseInt(chatId), text, telegramOptions);

    return {
      id: msg.message_id.toString(),
      chatId: msg.chat.id.toString(),
      threadId: msg.message_thread_id?.toString(),
    };
  }

  async edit(chatId: string, messageId: string, text: string, options: SendOptions = {}): Promise<void> {
    const telegramOptions = this.toTelegramOptions(options);
    await this.client.editMessage(parseInt(chatId), parseInt(messageId), text, {
      parse_mode: telegramOptions.parse_mode,
      message_thread_id: telegramOptions.message_thread_id,
    });
  }

  async sendTyping(chatId: string, threadId?: string): Promise<void> {
    await this.client.sendTyping(parseInt(chatId), threadId ? parseInt(threadId) : undefined);
  }

  async start(): Promise<void> {
    // Verify the bot token works
    const me = await this.client.getMe();
    this.botInfo = { username: me.username || '', firstName: me.first_name };
    // Delete any existing webhook so polling works
    await this.client.deleteWebhook();
  }

  async stop(): Promise<void> {
    // No persistent connections to close for polling-based Telegram
  }

  // ============================================================================
  // Telegram-specific helpers
  // ============================================================================

  /** Normalize a Telegram message to the generic ChannelMessage format */
  private normalizeMessage(msg: TelegramMessage): ChannelMessage {
    return {
      id: msg.message_id.toString(),
      chatId: msg.chat.id.toString(),
      threadId: msg.message_thread_id?.toString(),
      text: msg.text || '',
      sender: {
        id: msg.from!.id.toString(),
        username: msg.from!.username,
        displayName: msg.from!.first_name + (msg.from!.last_name ? ` ${msg.from!.last_name}` : ''),
        isBot: msg.from!.is_bot,
      },
      timestamp: new Date(msg.date * 1000),
      isThreaded: msg.chat.is_forum || false,
      raw: msg,  // Preserve original for Telegram-specific features
    };
  }

  /** Convert generic SendOptions to Telegram-specific options */
  private toTelegramOptions(options: SendOptions): SendMessageOptions {
    const telegramOpts: SendMessageOptions = {};

    if (options.threadId) {
      telegramOpts.message_thread_id = parseInt(options.threadId);
    }
    if (options.replyTo) {
      telegramOpts.reply_to_message_id = parseInt(options.replyTo);
    }
    if (options.format === 'markdown') {
      telegramOpts.parse_mode = 'Markdown';
    } else if (options.format === 'html') {
      telegramOpts.parse_mode = 'HTML';
    }
    if (options.silent) {
      telegramOpts.disable_notification = true;
    }

    return telegramOpts;
  }
}
