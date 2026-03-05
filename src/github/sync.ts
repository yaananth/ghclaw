/**
 * GitHub Sync Loop
 * Periodically syncs local session data to the GitHub repo.
 * Runs every N seconds, exports sessions to JSON, commits & pushes if changes.
 * Maintains leader.json as a "who's running" indicator.
 */

import * as fs from 'fs';
import * as path from 'path';
import { gitPull, gitCommitAndPush, hasChanges } from './repo';
import { type Config } from '../config';
import {
  getSessionsByMachine,
  type TelegramSession,
} from '../memory/session-mapper';

interface SyncState {
  lastSync: Date | null;
  lastError: string | null;
  syncCount: number;
}

const syncState: SyncState = {
  lastSync: null,
  lastError: null,
  syncCount: 0,
};

// Leader coordination (used as "who's running" indicator)
export interface LeaderClaim {
  machine_id: string;
  machine_name: string;
  claimed_at: string;
}

/**
 * Write a leader claim to the sync repo
 */
export function writeLeaderClaim(repoPath: string, machineId: string, machineName: string): void {
  const leaderPath = path.join(repoPath, 'memory', 'leader.json');
  fs.mkdirSync(path.dirname(leaderPath), { recursive: true });
  const claim: LeaderClaim = {
    machine_id: machineId,
    machine_name: machineName,
    claimed_at: new Date().toISOString(),
  };
  fs.writeFileSync(leaderPath, JSON.stringify(claim, null, 2));
}

/**
 * Remove the leader claim from the sync repo (e.g., on graceful shutdown)
 */
export function removeLeaderClaim(repoPath: string): boolean {
  const leaderPath = path.join(repoPath, 'memory', 'leader.json');
  try {
    fs.unlinkSync(leaderPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current leader claim from the sync repo
 */
export function readLeaderClaim(repoPath: string): LeaderClaim | null {
  const leaderPath = path.join(repoPath, 'memory', 'leader.json');
  try {
    return JSON.parse(fs.readFileSync(leaderPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Export sessions to JSON files in the repo.
 * Returns true if data actually changed (skips write if unchanged to avoid needless commits).
 */
export function exportSessionsToJson(repoPath: string, sessions: TelegramSession[]): boolean {
  const sessionsPath = path.join(repoPath, 'memory', 'sessions.json');
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });

  const sessionData = sessions.map(s => ({
    id: s.id,
    chat_id: s.chat_id,
    thread_id: s.thread_id,
    name: s.name,
    status: s.status,
    created_at: s.created_at,
    last_activity: s.last_activity,
    message_count: s.message_count,
    machine_id: s.machine_id,
    machine_name: s.machine_name,
  }));

  const newFingerprint = JSON.stringify(sessionData);
  try {
    const existing = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    if (JSON.stringify(existing.sessions) === newFingerprint) {
      return false;
    }
  } catch {
    // File doesn't exist or corrupt — write it
  }

  const data = {
    exportedAt: new Date().toISOString(),
    count: sessions.length,
    sessions: sessionData,
  };

  fs.writeFileSync(sessionsPath, JSON.stringify(data, null, 2));
  return true;
}

/**
 * Export machine-specific info.
 * Returns true if data actually changed.
 */
export function exportMachineInfo(
  repoPath: string,
  machineId: string,
  machineName: string,
  sessions: TelegramSession[]
): boolean {
  const machinePath = path.join(repoPath, 'memory', 'machines', `${machineId}.json`);
  fs.mkdirSync(path.dirname(machinePath), { recursive: true });

  const sessionData = sessions.map(s => ({
    id: s.id,
    chat_id: s.chat_id,
    thread_id: s.thread_id,
    name: s.name,
    last_activity: s.last_activity,
    message_count: s.message_count,
  }));

  const newFingerprint = JSON.stringify({ machineId, machineName, sessionCount: sessions.length, sessions: sessionData });
  try {
    const existing = JSON.parse(fs.readFileSync(machinePath, 'utf-8'));
    const existingFingerprint = JSON.stringify({
      machineId: existing.machineId,
      machineName: existing.machineName,
      sessionCount: existing.sessionCount,
      sessions: existing.sessions,
    });
    if (existingFingerprint === newFingerprint) {
      const lastUpdate = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      if (Date.now() - lastUpdate < 60_000) {
        return false;
      }
    }
  } catch {
    // File doesn't exist or corrupt — write it
  }

  const data = {
    machineId,
    machineName,
    updatedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    sessions: sessionData,
  };

  fs.writeFileSync(machinePath, JSON.stringify(data, null, 2));
  return true;
}

/**
 * List all known machines from the sync repo.
 * Reads memory/machines/*.json and cross-references leader.json for liveness.
 */
export interface MachineInfo {
  machineId: string;
  machineName: string;
  updatedAt: string;
  sessionCount: number;
  isLeader: boolean;
  isAlive: boolean;
}

export function listAllMachines(repoPath: string): MachineInfo[] {
  const machinesDir = path.join(repoPath, 'memory', 'machines');
  if (!fs.existsSync(machinesDir)) return [];

  const leader = readLeaderClaim(repoPath);
  const leaderAlive = leader
    ? (Date.now() - new Date(leader.claimed_at).getTime()) < 120_000
    : false;

  const files = fs.readdirSync(machinesDir).filter(f => f.endsWith('.json'));
  const machines: MachineInfo[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(machinesDir, file), 'utf-8'));
      const machineId = data.machineId || file.replace('.json', '');
      const isLeaderMachine = leader?.machine_id === machineId;
      const machineFileAge = data.updatedAt
        ? Date.now() - new Date(data.updatedAt).getTime()
        : Infinity;
      const isAlive = (isLeaderMachine && leaderAlive) || machineFileAge < 120_000;

      // Auto-prune stale machines: offline > 24h with 0 sessions
      const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
      if (!isAlive && (data.sessionCount || 0) === 0 && machineFileAge > STALE_THRESHOLD_MS) {
        try {
          fs.unlinkSync(path.join(machinesDir, file));
          console.log(`🗑️ Pruned stale machine: ${data.machineName || machineId} (offline ${Math.round(machineFileAge / 3600000)}h, 0 sessions)`);
        } catch { /* ignore cleanup errors */ }
        continue;
      }

      machines.push({
        machineId,
        machineName: data.machineName || 'unknown',
        updatedAt: data.updatedAt || '',
        sessionCount: data.sessionCount || 0,
        isLeader: isLeaderMachine,
        isAlive,
      });
    } catch {
      // Skip corrupt files
    }
  }

  return machines;
}

/**
 * Get current sync state
 */
export function getSyncState(): SyncState {
  return { ...syncState };
}

/**
 * Start the git sync loop.
 * Periodically exports session data and pushes to the GitHub repo.
 */
export async function startSyncLoop(
  config: Config,
  isRunning: () => boolean,
): Promise<void> {
  if (!config.github.enabled || !config.github.syncEnabled) {
    console.log('ℹ️ GitHub sync disabled');
    return;
  }

  const repoPath = config.github.repoPath;
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.log('⚠️ GitHub repo not cloned. Run: ghclaw setup');
    return;
  }

  console.log(`🔄 Starting GitHub sync (every ${config.github.syncIntervalMs / 1000}s)...`);

  let firstRun = true;
  let lastLeaderRefresh = 0;
  const LEADER_REFRESH_MS = 30_000;

  while (isRunning()) {
    try {
      await gitPull(repoPath);

      // On first run, claim leadership
      if (firstRun) {
        firstRun = false;
        writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
      }

      // Refresh leader.json timestamp periodically (heartbeat)
      if (Date.now() - lastLeaderRefresh > LEADER_REFRESH_MS) {
        writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
        lastLeaderRefresh = Date.now();
      }

      // Export local data (only writes files if data actually changed)
      const machineSessions = getSessionsByMachine(config.machine.id);
      const machineChanged = exportMachineInfo(repoPath, config.machine.id, config.machine.name, machineSessions);

      // Commit+push if data changed OR leader.json was refreshed
      if (await hasChanges(repoPath)) {
        const pushed = await gitCommitAndPush(repoPath, `sync: ${config.machine.name} @ ${new Date().toISOString()}`);
        if (pushed) {
          syncState.syncCount++;
        }
      }

      syncState.lastSync = new Date();
      syncState.lastError = null;
    } catch (error) {
      syncState.lastError = String(error);
      if (syncState.syncCount === 0 || syncState.syncCount % 12 === 0) {
        console.log(`⚠️ GitHub sync error: ${error}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, config.github.syncIntervalMs));
  }
}
