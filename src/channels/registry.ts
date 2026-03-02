/**
 * Channel Registry
 *
 * Detects which channels have valid configuration (tokens in keychain),
 * manages channel selection (auto-select if only one), and provides
 * the active channel instance.
 */

import type { Channel } from './channel';
import { TelegramChannel } from './telegram';
import { getSecret } from '../secrets/keychain';

export interface ChannelConfig {
  type: string;           // 'telegram' | 'discord' | 'slack' | ...
  enabled: boolean;
  channel: Channel;
}

let activeChannel: ChannelConfig | null = null;

/**
 * Detect which channels have valid config (tokens in keychain or env vars).
 * Returns an array of configured channels.
 */
export async function detectConfiguredChannels(): Promise<ChannelConfig[]> {
  const channels: ChannelConfig[] = [];

  // Check Telegram
  const telegramToken = await getSecret('telegram-bot-token') || process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    channels.push({
      type: 'telegram',
      enabled: true,
      channel: new TelegramChannel(telegramToken),
    });
  }

  // Future: Check Discord
  // const discordToken = await getSecret('discord-bot-token') || process.env.DISCORD_BOT_TOKEN;
  // if (discordToken) { channels.push({ type: 'discord', ... }); }

  // Future: Check Slack
  // const slackToken = await getSecret('slack-bot-token') || process.env.SLACK_BOT_TOKEN;
  // if (slackToken) { channels.push({ type: 'slack', ... }); }

  return channels;
}

/**
 * Get the active channel. Auto-selects if only one is configured.
 * If multiple are configured, uses the preference from config.channels.active.
 * Throws if no channels are configured.
 */
export async function getActiveChannel(preferredType?: string): Promise<ChannelConfig> {
  if (activeChannel) return activeChannel;

  const channels = await detectConfiguredChannels();

  if (channels.length === 0) {
    throw new Error('No channels configured. Run: ghclaw setup');
  }

  if (channels.length === 1) {
    activeChannel = channels[0];
    return activeChannel;
  }

  // Multiple channels: use the preferred type from config if specified
  if (preferredType) {
    const preferred = channels.find(c => c.type === preferredType);
    if (preferred) {
      activeChannel = preferred;
      return activeChannel;
    }
  }

  // Fallback to the first configured channel
  activeChannel = channels[0];
  return activeChannel;
}

/**
 * Get the active channel type string (e.g. 'telegram').
 * Returns 'telegram' as default if no channel is active yet.
 */
export function getActiveChannelType(): string {
  return activeChannel?.type || 'telegram';
}

/**
 * Clear the cached active channel (e.g. after config changes).
 */
export function clearChannelCache(): void {
  activeChannel = null;
}
