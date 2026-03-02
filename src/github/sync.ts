/**
 * GitHub Sync Loop
 * Periodically syncs local session data to the GitHub repo.
 * Runs every N seconds, exports sessions to JSON, commits & pushes if changes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { gitPull, gitCommitAndPush, hasChanges } from './repo';
import { type Config } from '../config';
import {
  getActiveSessions,
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

/**
 * Export sessions to JSON files in the repo
 */
export function exportSessionsToJson(repoPath: string, sessions: TelegramSession[]): void {
  const sessionsPath = path.join(repoPath, 'memory', 'sessions.json');
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });

  const data = {
    exportedAt: new Date().toISOString(),
    count: sessions.length,
    sessions: sessions.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      created_at: s.created_at,
      last_activity: s.last_activity,
      message_count: s.message_count,
      machine_id: s.machine_id,
      machine_name: s.machine_name,
    })),
  };

  fs.writeFileSync(sessionsPath, JSON.stringify(data, null, 2));
}

/**
 * Export machine-specific info
 */
export function exportMachineInfo(
  repoPath: string,
  machineId: string,
  machineName: string,
  sessions: TelegramSession[]
): void {
  const machinePath = path.join(repoPath, 'memory', 'machines', `${machineId}.json`);
  fs.mkdirSync(path.dirname(machinePath), { recursive: true });

  const data = {
    machineId,
    machineName,
    updatedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    sessions: sessions.map(s => ({
      id: s.id,
      name: s.name,
      last_activity: s.last_activity,
      message_count: s.message_count,
    })),
  };

  fs.writeFileSync(machinePath, JSON.stringify(data, null, 2));
}

/**
 * Import sessions from other machines in the repo (read-only, for visibility)
 */
export function importSessionsFromRepo(repoPath: string): { machines: string[]; totalSessions: number } {
  const machinesDir = path.join(repoPath, 'memory', 'machines');
  if (!fs.existsSync(machinesDir)) return { machines: [], totalSessions: 0 };

  const files = fs.readdirSync(machinesDir).filter(f => f.endsWith('.json'));
  let totalSessions = 0;

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(machinesDir, file), 'utf-8'));
      totalSessions += data.sessionCount || 0;
    } catch {
      // Skip corrupt files
    }
  }

  return { machines: files.map(f => f.replace('.json', '')), totalSessions };
}

/**
 * Get current sync state
 */
export function getSyncState(): SyncState {
  return { ...syncState };
}

/**
 * Start the git sync loop
 */
export async function startSyncLoop(config: Config, isRunning: () => boolean): Promise<void> {
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

  while (isRunning()) {
    try {
      // Pull first
      await gitPull(repoPath);

      // Export local data
      const allSessions = getActiveSessions(100);
      exportSessionsToJson(repoPath, allSessions);

      const machineSessions = getSessionsByMachine(config.machine.id);
      exportMachineInfo(repoPath, config.machine.id, config.machine.name, machineSessions);

      // Push if changes
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
      // Don't spam logs — only log on first error or every 60th attempt
      if (syncState.syncCount === 0 || syncState.syncCount % 12 === 0) {
        console.log(`⚠️ GitHub sync error: ${error}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, config.github.syncIntervalMs));
  }
}
