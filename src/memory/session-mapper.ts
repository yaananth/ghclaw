/**
 * Session Mapper
 *
 * Minimal database that maps channel chats to Copilot CLI sessions.
 * ALL actual memory, context, and history is handled by Copilot CLI's
 * Chronicle feature (~/.copilot/session-store.db).
 *
 * We only store:
 * - Channel chat_id + thread_id -> Copilot session_id
 * - Basic session metadata (name, status, channel_type)
 * - Topic IDs for threaded channels
 */

import { Database } from 'bun:sqlite';
import { getConfigDir } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

/** @deprecated Use ChannelSession instead. Kept as alias for backward compat. */
export type TelegramSession = ChannelSession;

export interface ChannelSession {
  id: string;                      // Copilot session ID (UUID)
  chat_id: number;                 // Channel chat/conversation ID
  thread_id: number;               // Channel thread/topic ID (0 for main chat)
  name: string;                    // Session name (from topic or generated)
  status: 'active' | 'archived';
  created_at: string;
  last_activity: string;
  message_count: number;
  topic_id?: number;               // Auto-created topic ID
  machine_id?: string;             // Machine that owns this session
  machine_name?: string;           // Human-readable machine name
  channel_type?: string;           // 'telegram' | 'discord' | 'slack' | ...
}

// ============================================================================
// Database
// ============================================================================

let db: Database | null = null;

function getDbPath(): string {
  const dataDir = path.join(getConfigDir(), 'data');
  return path.join(dataDir, 'sessions.sqlite');
}

export function initDatabase(): Database {
  if (db) return db;

  const dbPath = getDbPath();

  // Ensure data directory has restrictive permissions
  const dataDir = path.dirname(dbPath);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    // Ignore permission errors (best-effort hardening)
  }

  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  // Set restrictive permissions on database files (including WAL/SHM)
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // File may not exist yet on first run
    }
  }

  db.exec(`
    -- Maps Telegram chats to Copilot CLI sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,              -- Copilot session UUID
      chat_id INTEGER NOT NULL,         -- Telegram chat ID
      thread_id INTEGER DEFAULT 0,      -- Telegram topic/thread ID
      name TEXT NOT NULL,               -- Session name
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      created_at TEXT DEFAULT (datetime('now')),
      last_activity TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      topic_id INTEGER,                 -- Auto-created Telegram topic ID
      UNIQUE(chat_id, thread_id)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_topic ON sessions(chat_id, topic_id);
  `);

  // Migration: add topic_id column if missing
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN topic_id INTEGER');
  } catch {
    // Column already exists
  }

  // Migration: add machine_id and machine_name columns if missing
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN machine_id TEXT');
  } catch {
    // Column already exists
  }
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN machine_name TEXT');
  } catch {
    // Column already exists
  }

  // Migration: add channel_type column if missing (defaults to 'telegram' for existing rows)
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN channel_type TEXT DEFAULT 'telegram'");
  } catch {
    // Column already exists
  }

  // Table for persisting Chronicle sync state across daemon restarts
  db.exec(`
    CREATE TABLE IF NOT EXISTS synced_chronicle_sessions (
      session_id TEXT PRIMARY KEY,
      synced_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Generate a Copilot-compatible session UUID
 */
function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Get or create a session for a Telegram chat/topic
 */
export function getOrCreateSession(
  chatId: number,
  threadId: number = 0,
  topicName?: string,
  machineId?: string,
  machineName?: string
): TelegramSession {
  const db = initDatabase();

  // Try to find existing session
  let session = db.prepare(`
    SELECT * FROM sessions WHERE chat_id = ? AND thread_id = ?
  `).get(chatId, threadId) as TelegramSession | undefined;

  if (session) {
    return session;
  }

  // Create new session with fresh UUID
  const id = generateSessionId();
  // Limit name length to prevent storage bloat
  const rawName = topicName || `Chat ${chatId}${threadId ? ` Topic ${threadId}` : ''}`;
  const name = rawName.slice(0, 100);

  db.prepare(`
    INSERT INTO sessions (id, chat_id, thread_id, name, machine_id, machine_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, chatId, threadId, name, machineId || null, machineName || null);

  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as TelegramSession;
}

/**
 * Get session by Telegram chat/topic
 */
export function getSession(chatId: number, threadId: number = 0): TelegramSession | null {
  const db = initDatabase();
  return db.prepare(`
    SELECT * FROM sessions WHERE chat_id = ? AND thread_id = ?
  `).get(chatId, threadId) as TelegramSession | null;
}

/**
 * Update session after a message
 */
export function updateSessionActivity(sessionId: string): void {
  const db = initDatabase();
  db.prepare(`
    UPDATE sessions SET
      last_activity = datetime('now'),
      message_count = message_count + 1
    WHERE id = ?
  `).run(sessionId);
}

/**
 * Rename a session
 */
export function renameSession(sessionId: string, name: string): void {
  const db = initDatabase();
  db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`).run(name, sessionId);
}

/**
 * Claim a session for this machine (transfer ownership)
 */
export function claimSession(sessionId: string, machineId: string, machineName: string): void {
  const db = initDatabase();
  db.prepare(`
    UPDATE sessions SET machine_id = ?, machine_name = ? WHERE id = ?
  `).run(machineId, machineName, sessionId);
}

/**
 * Archive a session
 */
export function archiveSession(sessionId: string): void {
  const db = initDatabase();
  db.prepare(`UPDATE sessions SET status = 'archived' WHERE id = ?`).run(sessionId);
}

/**
 * Get active sessions
 */
export function getActiveSessions(limit: number = 20): TelegramSession[] {
  const db = initDatabase();
  return db.prepare(`
    SELECT * FROM sessions
    WHERE status = 'active'
    ORDER BY last_activity DESC
    LIMIT ?
  `).all(limit) as TelegramSession[];
}

/**
 * Archive old sessions
 */
export function archiveOldSessions(daysOld: number = 7): number {
  const db = initDatabase();
  const result = db.prepare(`
    UPDATE sessions SET status = 'archived'
    WHERE last_activity < datetime('now', '-' || ? || ' days')
    AND status = 'active'
  `).run(daysOld);
  return result.changes;
}

/**
 * Get session stats
 */
export function getSessionStats(): {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  dbSizeBytes: number;
} {
  const db = initDatabase();
  const dbPath = getDbPath();

  const total = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  const active = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'").get() as { count: number };
  const messages = db.prepare('SELECT SUM(message_count) as sum FROM sessions').get() as { sum: number | null };

  let dbSize = 0;
  try {
    dbSize = fs.statSync(dbPath).size;
  } catch {}

  return {
    totalSessions: total.count,
    activeSessions: active.count,
    totalMessages: messages.sum || 0,
    dbSizeBytes: dbSize,
  };
}

/**
 * Delete a session mapping (doesn't affect Copilot CLI's data)
 */
export function deleteSession(sessionId: string): void {
  const db = initDatabase();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Set the Telegram topic ID for a session
 */
export function setSessionTopicId(sessionId: string, topicId: number): void {
  const db = initDatabase();
  db.prepare('UPDATE sessions SET topic_id = ? WHERE id = ?').run(topicId, sessionId);
}

/**
 * Get session by topic ID
 */
export function getSessionByTopicId(chatId: number, topicId: number): TelegramSession | null {
  const db = initDatabase();
  return db.prepare(`
    SELECT * FROM sessions WHERE chat_id = ? AND topic_id = ?
  `).get(chatId, topicId) as TelegramSession | null;
}

/**
 * Get the machine that owns a session (by chat/thread)
 * Returns { machine_id, machine_name } or null if unassigned
 */
export function getSessionMachine(chatId: number, threadId: number): { machine_id: string; machine_name: string } | null {
  const db = initDatabase();
  const row = db.prepare(`
    SELECT machine_id, machine_name FROM sessions WHERE chat_id = ? AND thread_id = ?
  `).get(chatId, threadId) as { machine_id: string | null; machine_name: string | null } | undefined;
  if (row?.machine_id) {
    return { machine_id: row.machine_id, machine_name: row.machine_name || 'unknown' };
  }
  return null;
}

/**
 * Get sessions owned by a specific machine
 */
export function getSessionsByMachine(machineId: string): TelegramSession[] {
  const db = initDatabase();
  return db.prepare(`
    SELECT * FROM sessions WHERE machine_id = ? AND status = 'active'
    ORDER BY last_activity DESC
  `).all(machineId) as TelegramSession[];
}

/**
 * Get all sessions with topics for a chat
 */
export function getSessionsWithTopics(chatId: number): TelegramSession[] {
  const db = initDatabase();
  return db.prepare(`
    SELECT * FROM sessions
    WHERE chat_id = ? AND topic_id IS NOT NULL AND status = 'active'
    ORDER BY last_activity DESC
  `).all(chatId) as TelegramSession[];
}

/**
 * Create or update session with topic
 */
export function createSessionWithTopic(
  chatId: number,
  topicId: number,
  sessionId: string,
  name: string,
  machineId?: string,
  machineName?: string
): TelegramSession {
  const db = initDatabase();

  // Check if session already exists for this topic
  const existing = getSessionByTopicId(chatId, topicId);
  if (existing) {
    // Update existing session
    db.prepare(`
      UPDATE sessions SET
        id = ?,
        name = ?,
        last_activity = datetime('now'),
        machine_id = COALESCE(?, machine_id),
        machine_name = COALESCE(?, machine_name)
      WHERE chat_id = ? AND topic_id = ?
    `).run(sessionId, name, machineId || null, machineName || null, chatId, topicId);
  } else {
    // Create new session with topic
    db.prepare(`
      INSERT OR REPLACE INTO sessions (id, chat_id, thread_id, name, topic_id, status, machine_id, machine_name)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(sessionId, chatId, topicId, name, topicId, machineId || null, machineName || null);
  }

  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as TelegramSession;
}

// ============================================================================
// Chronicle Sync Persistence
// ============================================================================

/**
 * Get all synced Chronicle session IDs (persists across daemon restarts)
 */
export function getSyncedSessionIds(): Set<string> {
  const db = initDatabase();
  const rows = db.prepare('SELECT session_id FROM synced_chronicle_sessions').all() as { session_id: string }[];
  return new Set(rows.map(r => r.session_id));
}

/**
 * Mark a Chronicle session ID as synced
 */
export function addSyncedSessionId(sessionId: string): void {
  const db = initDatabase();
  db.prepare('INSERT OR IGNORE INTO synced_chronicle_sessions (session_id) VALUES (?)').run(sessionId);
}
