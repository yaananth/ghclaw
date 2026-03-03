/**
 * GitHub Sync Loop
 * Periodically syncs local session data to the GitHub repo.
 * Runs every N seconds, exports sessions to JSON, commits & pushes if changes.
 * Also handles leader coordination for multi-machine polling.
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

// Leader coordination
export interface LeaderClaim {
  machine_id: string;
  machine_name: string;
  claimed_at: string;
}

export interface HandoffRequest {
  from_machine_id: string;
  from_machine_name: string;
  to_machine_id: string;
  to_machine_name: string;
  reason: string;
  requested_at: string;
  // Pending message that the target machine should process
  pending_message?: {
    chat_id: string;
    thread_id: string;
    text: string;
    from_user?: string;
    from_user_id?: string; // Original sender's ID for security validation
  };
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
 * Write a handoff request — asks a specific machine to become leader
 */
export function writeHandoffRequest(
  repoPath: string,
  fromId: string,
  fromName: string,
  toId: string,
  toName: string,
  reason: string,
  pendingMessage?: HandoffRequest['pending_message']
): void {
  const handoffPath = path.join(repoPath, 'memory', 'handoff.json');
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  const request: HandoffRequest = {
    from_machine_id: fromId,
    from_machine_name: fromName,
    to_machine_id: toId,
    to_machine_name: toName,
    reason,
    requested_at: new Date().toISOString(),
    pending_message: pendingMessage,
  };
  fs.writeFileSync(handoffPath, JSON.stringify(request, null, 2));
}

/**
 * Read a pending handoff request
 */
export function readHandoffRequest(repoPath: string): HandoffRequest | null {
  const handoffPath = path.join(repoPath, 'memory', 'handoff.json');
  try {
    return JSON.parse(fs.readFileSync(handoffPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Clear the handoff request (after it's been processed)
 */
export function clearHandoffRequest(repoPath: string): void {
  const handoffPath = path.join(repoPath, 'memory', 'handoff.json');
  try {
    fs.unlinkSync(handoffPath);
  } catch {}
}

/**
 * Export sessions to JSON files in the repo.
 * Returns true if data actually changed (skips write if unchanged to avoid needless commits).
 */
export function exportSessionsToJson(repoPath: string, sessions: TelegramSession[]): boolean {
  const sessionsPath = path.join(repoPath, 'memory', 'sessions.json');
  fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });

  // Build session data WITHOUT volatile timestamps (exportedAt changes every cycle)
  // Include chat_id/thread_id so other machines can look up session ownership
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

  // Compare with existing file to skip needless writes
  const newFingerprint = JSON.stringify(sessionData);
  try {
    const existing = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    if (JSON.stringify(existing.sessions) === newFingerprint) {
      return false; // No meaningful change
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

  // Build session data WITHOUT volatile timestamp
  // Include chat_id/thread_id so other machines can look up session ownership
  const sessionData = sessions.map(s => ({
    id: s.id,
    chat_id: s.chat_id,
    thread_id: s.thread_id,
    name: s.name,
    last_activity: s.last_activity,
    message_count: s.message_count,
  }));

  // Compare with existing to skip needless writes
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
      return false; // No meaningful change
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
 * Look up session ownership from the shared sync repo.
 * Each machine has its own local SQLite, so when a message arrives for a topic
 * created by another machine, the local DB won't have the machine_id.
 * Checks per-machine files (memory/machines/{id}.json) which each machine exports
 * from its own local data — more reliable than sessions.json which gets overwritten.
 */
export function lookupSessionOwner(
  repoPath: string,
  chatId: number,
  threadId: number,
  excludeMachineId?: string
): { machine_id: string; machine_name: string } | null {
  const machinesDir = path.join(repoPath, 'memory', 'machines');
  if (!fs.existsSync(machinesDir)) return null;

  try {
    const files = fs.readdirSync(machinesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const machineId = file.replace('.json', '');
      if (excludeMachineId && machineId === excludeMachineId) continue; // Skip our own

      try {
        const data = JSON.parse(fs.readFileSync(path.join(machinesDir, file), 'utf-8'));
        if (!data.sessions) continue;
        for (const s of data.sessions) {
          if (s.chat_id === chatId && s.thread_id === threadId) {
            return { machine_id: data.machineId || machineId, machine_name: data.machineName || 'unknown' };
          }
        }
      } catch {
        // Skip corrupt files
      }
    }
  } catch {
    // Directory read error
  }
  return null;
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
 * Also checks for leader handoff requests.
 * onHandoff callback is called when this machine should become leader (with pending message if any).
 * onYield callback is called when this machine should yield leadership.
 */
export async function startSyncLoop(
  config: Config,
  isRunning: () => boolean,
  isLeader: () => boolean,
  onHandoff?: (pendingMessage?: HandoffRequest['pending_message']) => void | Promise<void>,
  onYield?: () => void,
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
  const LEADER_REFRESH_MS = 30_000; // Refresh leader.json every 30s (heartbeat for stale detection)
  const STALE_HANDOFF_SENDER_MS = 60_000;  // Sender reclaims after 60s
  const STALE_HANDOFF_OTHER_MS = 90_000;   // Other machines can pick up after 90s
  while (isRunning()) {
    try {
      // Pull first
      await gitPull(repoPath);

      // On first run, claim leadership only if daemon is actually the leader (polling).
      // If we already got 409 and yielded, don't write leader.json.
      if (firstRun) {
        firstRun = false;
        if (isLeader()) {
          writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
        }
      }

      // Check for handoff requests
      const handoff = readHandoffRequest(repoPath);
      if (handoff) {
        const handoffAge = Date.now() - new Date(handoff.requested_at).getTime();

        if (handoff.to_machine_id === config.machine.id) {
          // We're being asked to become leader
          console.log(`🔄 Handoff received from ${handoff.from_machine_name}: becoming leader`);
          clearHandoffRequest(repoPath);
          writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
          await gitCommitAndPush(repoPath, `leader: ${config.machine.name} (handoff from ${handoff.from_machine_name})`);
          await onHandoff?.(handoff.pending_message);
        } else if (handoff.from_machine_id === config.machine.id) {
          // We requested the handoff — target hasn't claimed yet
          // If target is offline (didn't pick up in time), reclaim and process ourselves
          if (handoffAge > STALE_HANDOFF_SENDER_MS) {
            console.log(`⏰ Handoff to ${handoff.to_machine_name} timed out (${Math.floor(handoffAge / 1000)}s) — reclaiming`);
            clearHandoffRequest(repoPath);
            writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
            await gitCommitAndPush(repoPath, `leader: ${config.machine.name} (handoff timeout, target: ${handoff.to_machine_name})`);
            await onHandoff?.(handoff.pending_message);
          }
        } else {
          // Handoff between other machines — if stale, we can recover
          // Give the sender priority to reclaim first (they timeout at 60s, we at 90s)
          if (handoffAge > STALE_HANDOFF_OTHER_MS) {
            console.log(`⏰ Stale handoff ${handoff.from_machine_name} → ${handoff.to_machine_name} (${Math.floor(handoffAge / 1000)}s) — recovering`);
            clearHandoffRequest(repoPath);
            writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
            await gitCommitAndPush(repoPath, `leader: ${config.machine.name} (stale handoff recovery)`);
            await onHandoff?.(handoff.pending_message);
          }
        }
      }

      // Refresh leader.json timestamp if we're ACTUALLY the leader (daemon is polling).
      // Only refresh every 30s to avoid committing every 5s cycle.
      // CRITICAL: check isLeader() from the daemon, not just leader.json —
      // leader.json may still say us even after we yielded (409).
      if (isLeader()) {
        const currentLeader = readLeaderClaim(repoPath);
        if (!currentLeader || currentLeader.machine_id === config.machine.id) {
          if (Date.now() - lastLeaderRefresh > LEADER_REFRESH_MS) {
            writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
            lastLeaderRefresh = Date.now();
          }
        }
      }

      // Export local data (only writes files if data actually changed)
      const allSessions = getActiveSessions(100);
      const sessionsChanged = exportSessionsToJson(repoPath, allSessions);

      const machineSessions = getSessionsByMachine(config.machine.id);
      const machineChanged = exportMachineInfo(repoPath, config.machine.id, config.machine.name, machineSessions);

      // Commit+push if session data changed OR leader.json was refreshed (heartbeat)
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
