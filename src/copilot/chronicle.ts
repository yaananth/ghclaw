/**
 * Chronicle Integration
 *
 * Reads from Copilot CLI's session-state directory (~/.copilot/session-state/)
 * Each session is a directory containing workspace.yaml with metadata.
 */

import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export interface ChronicleSession {
  id: string;
  summary: string | null;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  turn_count?: number;
  lastMessage?: string | null;
  lastAssistantMessage?: string | null;
}

export interface ChronicleCheckpoint {
  id: number;
  session_id: string;
  checkpoint_number: number;
  title: string | null;
  overview: string | null;
  work_done: string | null;
  next_steps: string | null;
  created_at: string;
}

export interface ChronicleMessagePair {
  turnNumber: number;
  userMessage: string;
  assistantMessage: string;
  timestamp?: string;
}

// ============================================================================
// Session State Directory Access
// ============================================================================

function getSessionStateDir(): string {
  const home = process.env.HOME || '~';
  return path.join(home, '.copilot', 'session-state');
}

/**
 * Parse a workspace.yaml file (simple key: value parser, no YAML lib needed)
 */
function parseWorkspaceYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let currentKey = '';
  let multilineValue = '';
  let inMultiline = false;

  for (const line of content.split('\n')) {
    if (inMultiline) {
      // Multiline YAML block scalar
      if (line.startsWith('  ') || line === '') {
        multilineValue += (multilineValue ? '\n' : '') + line.trimStart();
        continue;
      } else {
        result[currentKey] = multilineValue.trim();
        inMultiline = false;
        multilineValue = '';
      }
    }

    const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (match) {
      currentKey = match[1];
      const value = match[2].trim();
      if (value === '|-' || value === '|' || value === '>-' || value === '>') {
        inMultiline = true;
        multilineValue = '';
      } else {
        result[currentKey] = value;
      }
    }
  }

  // Flush any remaining multiline
  if (inMultiline && currentKey) {
    result[currentKey] = multilineValue.trim();
  }

  return result;
}

/**
 * Read a session from its workspace.yaml
 */
function readSessionFromDir(sessionDir: string): ChronicleSession | null {
  const yamlPath = path.join(sessionDir, 'workspace.yaml');
  if (!fs.existsSync(yamlPath)) return null;

  try {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    const data = parseWorkspaceYaml(content);

    const id = data.id || path.basename(sessionDir);
    const summary = data.summary || null;
    const cwd = data.cwd || null;
    const repository = data.repository || null;
    const branch = data.branch || null;
    const created_at = data.created_at || '';
    const updated_at = data.updated_at || '';

    // Count user.message events and grab the last user + assistant messages
    let userMessageCount = 0;
    let lastMessage: string | null = null;
    let lastAssistantMessage: string | null = null;
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    try {
      if (fs.existsSync(eventsPath)) {
        const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
        for (const line of eventsContent.split('\n')) {
          if (line.includes('"user.message"')) {
            userMessageCount++;
            try {
              const event = JSON.parse(line);
              if (event.data?.content) {
                // Extract just the user's actual message (after "User: " prefix if present)
                const content = event.data.content as string;
                const userLineMatch = content.match(/\nUser: (.+?)$/s);
                lastMessage = userLineMatch ? userLineMatch[1].trim() : content.split('\n').pop()?.trim() || content;
              }
            } catch {}
          } else if (line.includes('"assistant.message"')) {
            try {
              const event = JSON.parse(line);
              if (event.data?.content) {
                lastAssistantMessage = (event.data.content as string).slice(0, 500);
              }
            } catch {}
          }
        }
      }
    } catch {}

    return {
      id,
      summary,
      cwd,
      repository,
      branch,
      created_at,
      updated_at,
      turn_count: userMessageCount,
      lastMessage,
      lastAssistantMessage,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Session Queries
// ============================================================================

/**
 * Get recent sessions from session-state directory
 * Scans workspace.yaml files sorted by updated_at
 */
export function getRecentSessions(limit: number = 10): ChronicleSession[] {
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) return [];

  // Get all session dirs with their mtime for quick sorting
  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  const sessions: ChronicleSession[] = [];

  // Sort by directory mtime (most recent first) to avoid reading all 100k+ dirs
  const dirStats: { name: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = fs.statSync(path.join(stateDir, entry.name, 'workspace.yaml'));
      dirStats.push({ name: entry.name, mtime: stat.mtimeMs });
    } catch {
      // No workspace.yaml, skip
    }
  }

  dirStats.sort((a, b) => b.mtime - a.mtime);

  // Only read the top N * 2 (some may be filtered out)
  const toRead = Math.min(dirStats.length, limit * 3);
  for (let i = 0; i < toRead; i++) {
    const session = readSessionFromDir(path.join(stateDir, dirStats[i].name));
    // Filter out one-shot -p sessions (1 turn) and ghclaw bot sessions
    if (session && session.summary
      && (session.turn_count || 0) > 1
      && !session.summary.includes('helpful AI assistant in a Telegram')) {
      sessions.push(session);
      if (sessions.length >= limit) break;
    }
  }

  return sessions;
}

/**
 * Get active sessions (updated within last N hours)
 * Only returns sessions with a summary (meaningful sessions)
 */
export function getActiveSessions(hoursAgo: number = 24): ChronicleSession[] {
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) return [];

  const cutoff = Date.now() - (hoursAgo * 60 * 60 * 1000);
  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  const sessions: ChronicleSession[] = [];

  // Quick filter by mtime first
  const recentDirs: { name: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = fs.statSync(path.join(stateDir, entry.name, 'workspace.yaml'));
      if (stat.mtimeMs >= cutoff) {
        recentDirs.push({ name: entry.name, mtime: stat.mtimeMs });
      }
    } catch {
      // Skip
    }
  }

  recentDirs.sort((a, b) => b.mtime - a.mtime);

  for (const dir of recentDirs) {
    const session = readSessionFromDir(path.join(stateDir, dir.name));
    // Only return multi-turn interactive sessions (>1 user messages)
    // One-shot -p sessions have exactly 1 user.message
    // Also skip ghclaw's own bot sessions (system prompt leaks into summary)
    if (session && session.summary && session.summary !== '|-' && (session.turn_count || 0) > 1
      && !session.summary.includes('helpful AI assistant in a Telegram')) {
      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * Get a specific session by ID
 */
export function getSession(sessionId: string): ChronicleSession | null {
  const sessionDir = path.join(getSessionStateDir(), sessionId);
  return readSessionFromDir(sessionDir);
}

/**
 * Search sessions by keyword in summary
 */
export function searchSessions(query: string, limit: number = 10): ChronicleSession[] {
  const recent = getRecentSessions(100);
  const lowerQuery = query.toLowerCase();
  return recent
    .filter(s =>
      s.summary?.toLowerCase().includes(lowerQuery) ||
      s.cwd?.toLowerCase().includes(lowerQuery) ||
      s.repository?.toLowerCase().includes(lowerQuery)
    )
    .slice(0, limit);
}

/**
 * Get the latest checkpoint for a session
 */
export function getLatestCheckpoint(sessionId: string): ChronicleCheckpoint | null {
  const checkpointDir = path.join(getSessionStateDir(), sessionId, 'checkpoints');
  const indexPath = path.join(checkpointDir, 'index.md');

  if (!fs.existsSync(indexPath)) return null;

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    // Parse the markdown table for checkpoint files
    const lines = content.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('Title'));
    if (lines.length === 0) return null;

    // Get last checkpoint entry
    const lastLine = lines[lines.length - 1];
    const cols = lastLine.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 3) return null;

    const num = parseInt(cols[0]);
    const title = cols[1];
    const file = cols[2];

    // Try to read the checkpoint file
    const checkpointFile = path.join(checkpointDir, file);
    let overview: string | null = null;
    if (fs.existsSync(checkpointFile)) {
      const cpContent = fs.readFileSync(checkpointFile, 'utf-8');
      overview = cpContent.slice(0, 500);
    }

    return {
      id: num,
      session_id: sessionId,
      checkpoint_number: num,
      title,
      overview,
      work_done: null,
      next_steps: null,
      created_at: '',
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Incremental Message Reading
// ============================================================================

/**
 * Fast turn count: count user.message lines in events.jsonl without full JSON parse
 */
export function getSessionTurnCount(sessionId: string): number {
  const eventsPath = path.join(getSessionStateDir(), sessionId, 'events.jsonl');
  try {
    if (!fs.existsSync(eventsPath)) return 0;
    const content = fs.readFileSync(eventsPath, 'utf-8');
    let count = 0;
    for (const line of content.split('\n')) {
      if (line.includes('"user.message"')) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Read message pairs (user + assistant) after a given turn number.
 * Returns only complete pairs where both user and assistant messages exist.
 */
export function getMessagesAfterTurn(sessionId: string, afterTurn: number, maxTurns: number = 5): ChronicleMessagePair[] {
  const eventsPath = path.join(getSessionStateDir(), sessionId, 'events.jsonl');
  try {
    if (!fs.existsSync(eventsPath)) return [];
    const content = fs.readFileSync(eventsPath, 'utf-8');
    const lines = content.split('\n');

    const pairs: ChronicleMessagePair[] = [];
    let turnNumber = 0;
    let currentUserMessage: string | null = null;
    let currentTimestamp: string | undefined;

    for (const line of lines) {
      if (!line.trim()) continue;

      if (line.includes('"user.message"')) {
        turnNumber++;
        if (turnNumber <= afterTurn) {
          currentUserMessage = null;
          continue;
        }
        if (pairs.length >= maxTurns) break;
        try {
          const event = JSON.parse(line);
          const rawContent = event.data?.content as string || '';
          // Extract user's actual message (after "User: " prefix if present)
          const userLineMatch = rawContent.match(/\nUser: (.+?)$/s);
          currentUserMessage = userLineMatch ? userLineMatch[1].trim() : rawContent.split('\n').pop()?.trim() || rawContent;
          currentTimestamp = event.timestamp;
        } catch {
          currentUserMessage = null;
        }
      } else if (line.includes('"assistant.message"') && currentUserMessage) {
        try {
          const event = JSON.parse(line);
          const assistantContent = (event.data?.content as string) || '';
          if (assistantContent.trim()) {
            pairs.push({
              turnNumber,
              userMessage: currentUserMessage,
              assistantMessage: assistantContent,
              timestamp: currentTimestamp,
            });
            currentUserMessage = null;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    return pairs;
  } catch {
    return [];
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a session for display in Telegram
 */
export function formatSessionForTelegram(session: ChronicleSession, index?: number): string {
  const parts: string[] = [];

  // Index number if provided
  const prefix = index !== undefined ? `${index + 1}. ` : '';

  // Session name from summary or generate one
  const name = session.summary?.slice(0, 50) || 'Unnamed Session';
  parts.push(`${prefix}*${escapeMarkdown(name)}*`);

  // Project/directory info
  if (session.repository) {
    const repoName = path.basename(session.repository);
    parts.push(`   📁 ${escapeMarkdown(repoName)}`);
  } else if (session.cwd) {
    const dirName = path.basename(session.cwd);
    parts.push(`   📁 ${escapeMarkdown(dirName)}`);
  }

  // Timing
  const timeAgo = formatTimeAgo(session.updated_at);
  parts.push(`   🕐 ${timeAgo}`);

  // Session ID (shortened for reference)
  parts.push(`   🔗 \`${session.id.slice(0, 8)}\``);

  return parts.join('\n');
}

/**
 * Format sessions list for Telegram
 */
export function formatSessionsList(sessions: ChronicleSession[], title: string): string {
  if (sessions.length === 0) {
    return `📭 *${title}*\n\nNo sessions found.`;
  }

  const header = `📚 *${title}*\n\n`;
  const sessionLines = sessions.map((s, i) => formatSessionForTelegram(s, i)).join('\n\n');
  const footer = `\n\n_Reply with a number (1-${sessions.length}) or session ID to continue_`;

  return header + sessionLines + footer;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Check if Chronicle is available
 */
export function isChronicleAvailable(): boolean {
  return fs.existsSync(getSessionStateDir());
}

/**
 * Get Chronicle stats
 */
export function getChronicleStats(): {
  totalSessions: number;
  totalTurns: number;
  oldestSession: string | null;
  newestSession: string | null;
} {
  const stateDir = getSessionStateDir();
  if (!fs.existsSync(stateDir)) {
    return { totalSessions: 0, totalTurns: 0, oldestSession: null, newestSession: null };
  }

  try {
    const entries = fs.readdirSync(stateDir, { withFileTypes: true });
    const totalSessions = entries.filter(e => e.isDirectory()).length;

    // Get recent non-(-p) sessions for stats — aggregate their turn counts
    const recent = getRecentSessions(5);
    const sampledTurns = recent.reduce((sum, s) => sum + (s.turn_count || 0), 0);
    const oldest = recent.length > 0 ? recent[recent.length - 1].created_at : null;
    const newest = recent.length > 0 ? recent[0].updated_at : null;

    return {
      totalSessions,
      totalTurns: sampledTurns,
      oldestSession: oldest,
      newestSession: newest,
    };
  } catch {
    return { totalSessions: 0, totalTurns: 0, oldestSession: null, newestSession: null };
  }
}
