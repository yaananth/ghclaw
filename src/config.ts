/**
 * Configuration Module
 * Loads config from keychain (secrets) and local config file (non-secrets)
 */

import { getSecret, isKeychainAvailable } from './secrets/keychain';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface Config {
  telegram: {
    botToken: string;
    allowedGroupId?: number;
    allowedUserIds?: number[];
    allowedTopicIds?: number[];
    secretPrefix?: string;
    blockPrivateMessages: boolean;
    pollIntervalMs: number;
    pollTimeoutSeconds: number;  // Long-polling timeout (default: 30s, Telegram max: 50s)
  };
  copilot: {
    cliPath: string;
    defaultModel?: string;
    defaultProfile?: string;
    defaultAgent?: string;
    autopilot: boolean;
  };
  memory: {
    dbPath: string;
    maxContextMessages: number;
    maxContextTokens: number;
    compactThreshold: number;
  };
  machine: {
    id: string;    // Auto-generated UUID, persisted
    name: string;  // Human-readable: hostname or user-chosen name
  };
  github: {
    enabled: boolean;        // false until setup completes
    username: string;        // from gh auth
    repoName: string;        // '.ghclaw'
    repoPath: string;        // ~/.ghclaw/repo/
    syncIntervalMs: number;  // 5000
    syncEnabled: boolean;    // true
  };
  channels: {
    active: string;          // 'telegram' (auto-detected or user-chosen)
    configured: string[];    // ['telegram'] — populated at startup
  };
}

let cachedConfig: Config | null = null;

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), '.ghclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface LocalConfig {
  telegram?: {
    blockPrivateMessages?: boolean;
    pollIntervalMs?: number;
    pollTimeoutSeconds?: number;
    allowedTopicIds?: number[];
  };
  copilot?: {
    cliPath?: string;
    defaultModel?: string;
    defaultProfile?: string;
    defaultAgent?: string;
    autopilot?: boolean;
    yoloMode?: boolean;
  };
  memory?: {
    dbPath?: string;
    maxContextMessages?: number;
    maxContextTokens?: number;
    compactThreshold?: number;
  };
  machine?: {
    id?: string;
    name?: string;
  };
  github?: {
    enabled?: boolean;
    username?: string;
    repoName?: string;
    repoPath?: string;
    syncIntervalMs?: number;
    syncEnabled?: boolean;
  };
  channels?: {
    active?: string;
    configured?: string[];
  };
}

/**
 * Load local (non-secret) config from file
 */
function loadLocalConfig(): LocalConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (error) {
    console.warn('Could not load config file:', error);
  }
  return {};
}

/**
 * Save local config to file
 */
export function saveLocalConfig(config: LocalConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Ignore permission errors (best-effort hardening)
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Ignore permission errors (best-effort hardening)
  }
}

/**
 * Ensure machine config exists (auto-generate on first run)
 * Returns the machine config, persisting it if newly generated.
 */
function ensureMachineConfig(local: LocalConfig): { id: string; name: string } {
  if (local.machine?.id && local.machine?.name) {
    return { id: local.machine.id, name: local.machine.name };
  }

  const machine = {
    id: local.machine?.id || crypto.randomUUID(),
    name: local.machine?.name || os.hostname().split('.')[0], // Short hostname
  };

  // Persist the generated machine config
  const updated = { ...local, machine };
  saveLocalConfig(updated);

  return machine;
}

/**
 * Get config - loads from keychain and local file
 */
export async function getConfigAsync(): Promise<Config> {
  if (cachedConfig) return cachedConfig;

  const local = loadLocalConfig();
  const machine = ensureMachineConfig(local);

  // Load secrets from keychain
  const botToken = await getSecret('telegram-bot-token');
  const allowedGroup = await getSecret('telegram-allowed-group');
  const allowedUsers = await getSecret('telegram-allowed-users');
  const secretPrefix = await getSecret('telegram-secret-prefix');

  // Fallback to env vars for backwards compatibility
  let envToken = botToken || process.env.TELEGRAM_BOT_TOKEN || null;
  let envGroup = allowedGroup || process.env.TELEGRAM_ALLOWED_GROUP_ID || null;
  let envUsers = allowedUsers || process.env.TELEGRAM_ALLOWED_USER_IDS || null;
  let envPrefix = secretPrefix || process.env.TELEGRAM_SECRET_PREFIX || null;

  if (!envToken) {
    throw new Error('Telegram bot token not configured. Run: ghclaw setup');
  }

  cachedConfig = {
    telegram: {
      botToken: envToken,
      allowedGroupId: envGroup ? parseInt(envGroup) : undefined,
      allowedUserIds: envUsers
        ? envUsers.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
        : undefined,
      allowedTopicIds: local.telegram?.allowedTopicIds,
      secretPrefix: envPrefix || undefined,
      blockPrivateMessages: local.telegram?.blockPrivateMessages ?? true,
      pollIntervalMs: local.telegram?.pollIntervalMs ?? 1000,
      pollTimeoutSeconds: Math.min(local.telegram?.pollTimeoutSeconds ?? 30, 50),
    },
    copilot: {
      cliPath: local.copilot?.cliPath ?? 'copilot',
      defaultModel: local.copilot?.defaultModel ?? 'claude-sonnet-4.5',
      defaultProfile: local.copilot?.defaultProfile,
      defaultAgent: local.copilot?.defaultAgent,
      autopilot: local.copilot?.autopilot ?? local.copilot?.yoloMode ?? false,
    },
    memory: {
      dbPath: local.memory?.dbPath ?? path.join(CONFIG_DIR, 'data', 'memory.sqlite'),
      maxContextMessages: local.memory?.maxContextMessages ?? 20,
      maxContextTokens: local.memory?.maxContextTokens ?? 8000,
      compactThreshold: local.memory?.compactThreshold ?? 50,
    },
    machine,
    github: {
      enabled: local.github?.enabled ?? false,
      username: local.github?.username ?? '',
      repoName: local.github?.repoName ?? '.ghclaw',
      repoPath: local.github?.repoPath ?? path.join(CONFIG_DIR, 'repo'),
      syncIntervalMs: local.github?.syncIntervalMs ?? 5000,
      syncEnabled: local.github?.syncEnabled ?? true,
    },
    channels: {
      active: local.channels?.active ?? 'telegram',
      configured: local.channels?.configured ?? (envToken ? ['telegram'] : []),
    },
  };

  return cachedConfig;
}

/**
 * Sync version for use in non-async contexts (uses cached or env fallback)
 */
export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  // Fallback to environment variables for sync access
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Config not loaded. Call getConfigAsync() first or set env vars.');
  }

  const local = loadLocalConfig();
  const machine = ensureMachineConfig(local);

  return {
    telegram: {
      botToken: token,
      allowedGroupId: process.env.TELEGRAM_ALLOWED_GROUP_ID
        ? parseInt(process.env.TELEGRAM_ALLOWED_GROUP_ID)
        : undefined,
      allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS
        ? process.env.TELEGRAM_ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim()))
        : undefined,
      allowedTopicIds: local.telegram?.allowedTopicIds,
      secretPrefix: process.env.TELEGRAM_SECRET_PREFIX,
      blockPrivateMessages: local.telegram?.blockPrivateMessages ?? true,
      pollIntervalMs: local.telegram?.pollIntervalMs ?? 1000,
      pollTimeoutSeconds: Math.min(local.telegram?.pollTimeoutSeconds ?? 30, 50),
    },
    copilot: {
      cliPath: local.copilot?.cliPath ?? 'copilot',
      defaultModel: local.copilot?.defaultModel ?? 'claude-sonnet-4.5',
      defaultProfile: local.copilot?.defaultProfile,
      defaultAgent: local.copilot?.defaultAgent,
      autopilot: local.copilot?.autopilot ?? local.copilot?.yoloMode ?? false,
    },
    memory: {
      dbPath: local.memory?.dbPath ?? path.join(CONFIG_DIR, 'data', 'memory.sqlite'),
      maxContextMessages: local.memory?.maxContextMessages ?? 20,
      maxContextTokens: local.memory?.maxContextTokens ?? 8000,
      compactThreshold: local.memory?.compactThreshold ?? 50,
    },
    machine,
    github: {
      enabled: local.github?.enabled ?? false,
      username: local.github?.username ?? '',
      repoName: local.github?.repoName ?? '.ghclaw',
      repoPath: local.github?.repoPath ?? path.join(CONFIG_DIR, 'repo'),
      syncIntervalMs: local.github?.syncIntervalMs ?? 5000,
      syncEnabled: local.github?.syncEnabled ?? true,
    },
    channels: {
      active: local.channels?.active ?? 'telegram',
      configured: local.channels?.configured ?? (token ? ['telegram'] : []),
    },
  };
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Check if config is complete
 */
export async function isConfigComplete(): Promise<{ complete: boolean; missing: string[] }> {
  const missing: string[] = [];

  // Check if at least one channel is configured
  const telegramToken = await getSecret('telegram-bot-token') || process.env.TELEGRAM_BOT_TOKEN;
  // Future: check discord, slack tokens too
  if (!telegramToken) {
    missing.push('channel (no telegram-bot-token found)');
  }

  return {
    complete: missing.length === 0,
    missing,
  };
}
