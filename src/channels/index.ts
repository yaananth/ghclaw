/**
 * Channels Module
 *
 * Provides a unified messaging abstraction. Each channel (Telegram, Discord, Slack, etc.)
 * implements the Channel interface, allowing the core bot logic to be channel-agnostic.
 *
 * Currently implemented:
 * - Telegram (via TelegramChannel)
 *
 * Future channels can be added by implementing the Channel interface.
 */

export {
  type Channel,
  type ChannelInfo,
  type ChannelMessage,
  type SendOptions,
  type SentMessage,
  type StreamChunk,
  streamToChannel,
} from './channel';

export { TelegramChannel } from './telegram';

export {
  type ChannelConfig,
  detectConfiguredChannels,
  getActiveChannel,
  getActiveChannelType,
  clearChannelCache,
} from './registry';
