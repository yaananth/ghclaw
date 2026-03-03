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
  const sessionData = sessions.map(s => ({
    id: s.id,
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
  const sessionData = sessions.map(s => ({
    id: s.id,
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
  let lastHeartbeatPush = 0; // Track when we last pushed a heartbeat
  const HEARTBEAT_INTERVAL_MS = 25_000; // Push heartbeat every 25s
  const STALE_THRESHOLD_MS = 60_000; // Consider leader dead after 60s without heartbeat
  while (isRunning()) {
    try {
      // Pull first
      await gitPull(repoPath);

      // On first run, claim leadership after pull (so working tree is clean)
      if (firstRun) {
        firstRun = false;
        const existingLeader = readLeaderClaim(repoPath);
        if (!existingLeader || existingLeader.machine_id === config.machine.id) {
          writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
        }
      }

      // Check for handoff requests
      const handoff = readHandoffRequest(repoPath);
      if (handoff) {
        if (handoff.to_machine_id === config.machine.id) {
          // We're being asked to become leader
          console.log(`🔄 Handoff received from ${handoff.from_machine_name}: becoming leader`);
          clearHandoffRequest(repoPath);
          writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
          await gitCommitAndPush(repoPath, `leader: ${config.machine.name} (handoff from ${handoff.from_machine_name})`);
          await onHandoff?.(handoff.pending_message);
        } else if (handoff.from_machine_id === config.machine.id) {
          // We requested the handoff — yield
          // (handoff file still present means target hasn't claimed yet, wait)
        } else {
          // Handoff between other machines, ignore
        }
      }

      // Leader heartbeat: refresh claimed_at so followers know we're alive
      const leader = readLeaderClaim(repoPath);
      const weAreLeader = leader && leader.machine_id === config.machine.id;
      if (weAreLeader) {
        writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
      }

      // Check leader claim — if another machine is leader
      if (leader && !weAreLeader) {
        // Stale leader detection: if leader hasn't refreshed in STALE_THRESHOLD_MS, take over
        const claimedAt = new Date(leader.claimed_at).getTime();
        const isStale = Date.now() - claimedAt > STALE_THRESHOLD_MS;

        if (isStale) {
          console.log(`👑 Leader ${leader.machine_name} appears dead (last heartbeat ${Math.floor((Date.now() - claimedAt) / 1000)}s ago) — taking over`);
          writeLeaderClaim(repoPath, config.machine.id, config.machine.name);
          // Also clear any stale handoff requests from the dead leader
          const staleHandoff = readHandoffRequest(repoPath);
          if (staleHandoff && staleHandoff.from_machine_id === leader.machine_id) {
            clearHandoffRequest(repoPath);
          }
          await gitCommitAndPush(repoPath, `leader: ${config.machine.name} (stale takeover from ${leader.machine_name})`);
          await onHandoff?.();
        } else {
          // Leader is alive — yield
          onYield?.();
        }
      }

      // Export local data (only writes files if data actually changed)
      const allSessions = getActiveSessions(100);
      const sessionsChanged = exportSessionsToJson(repoPath, allSessions);

      const machineSessions = getSessionsByMachine(config.machine.id);
      const machineChanged = exportMachineInfo(repoPath, config.machine.id, config.machine.name, machineSessions);

      // Only commit+push if something meaningful changed (avoids hammering on every cycle)
      // Also push heartbeat (leader.json) periodically so followers know we're alive
      const needsHeartbeat = weAreLeader && (Date.now() - lastHeartbeatPush > HEARTBEAT_INTERVAL_MS);
      if ((sessionsChanged || machineChanged || needsHeartbeat) && await hasChanges(repoPath)) {
        const pushed = await gitCommitAndPush(repoPath, `sync: ${config.machine.name} @ ${new Date().toISOString()}`);
        if (pushed) {
          syncState.syncCount++;
          if (weAreLeader) lastHeartbeatPush = Date.now();
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
