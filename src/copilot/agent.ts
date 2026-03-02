/**
 * Copilot Coding Agent API Client
 *
 * Creates tasks for GitHub Copilot Coding Agent via the enterprise API.
 * Based on the hubot-copilot reference implementation.
 *
 * API: https://api.enterprise.githubcopilot.com
 */

import { getGhToken } from '../github/auth';

const DEFAULT_BASE_URL = 'https://api.enterprise.githubcopilot.com';
const INTEGRATION_ID = 'vscode-chat';
const HTTP_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

interface CopilotTask {
  id: string;
  creator_id: number;
  status: string;
  artifacts: CopilotArtifact[];
  sessions: CopilotSession[];
}

interface CopilotSession {
  id: string;
  state: string;
}

interface CopilotArtifact {
  provider: string;
  type: string;
  data: {
    id: number;
    type: string;
    global_id: string;
  };
}

export interface CreateTaskResult {
  taskId: string;
  sessionId: string | null;
  status: string;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * GitHub owner/repo name regex.
 * Allows alphanumeric, hyphens, dots, and underscores.
 * Must start with alphanumeric. Max lengths enforced.
 */
const GITHUB_NAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const MAX_OWNER_LENGTH = 39;
const MAX_REPO_LENGTH = 100;

function validateGitHubName(value: string, label: string, maxLen: number): string {
  if (!value || value.length > maxLen) {
    throw new Error(`Invalid ${label}: must be 1-${maxLen} characters`);
  }
  if (!GITHUB_NAME_REGEX.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
  // Extra safety: no path traversal or URL-breaking chars
  if (value.includes('..') || value.includes('/') || value.includes('%')) {
    throw new Error(`Invalid ${label}: contains path traversal characters`);
  }
  return value;
}

/**
 * Validate an API-returned ID (task or session).
 * These come from Copilot API responses, not user input, but defense-in-depth.
 */
const API_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function validateApiId(value: string, label: string): string {
  if (!value || !API_ID_REGEX.test(value)) {
    throw new Error(`Invalid ${label} ID format`);
  }
  return value;
}

/**
 * Build a safe API URL with validated and encoded path segments.
 */
function buildApiUrl(pathSegments: string[]): string {
  const base = getBaseUrl().replace(/\/+$/, '');
  const encodedPath = pathSegments.map(s => encodeURIComponent(s)).join('/');
  return `${base}/${encodedPath}`;
}

// ============================================================================
// API Client
// ============================================================================

function getBaseUrl(): string {
  return process.env.COPILOT_AGENT_BASE_URL || DEFAULT_BASE_URL;
}

async function getHeaders(): Promise<Record<string, string>> {
  const token = await getGhToken();
  if (!token) throw new Error('GitHub token not available. Run: gh auth login');

  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Copilot-Integration-Id': INTEGRATION_ID,
  };
}

/**
 * Create a Copilot Coding Agent task
 */
export async function createCodingAgentTask(
  owner: string,
  repo: string,
  description: string,
): Promise<CreateTaskResult> {
  const safeOwner = validateGitHubName(owner, 'owner', MAX_OWNER_LENGTH);
  const safeRepo = validateGitHubName(repo, 'repo', MAX_REPO_LENGTH);
  const url = buildApiUrl(['agents', 'repos', safeOwner, safeRepo, 'tasks']);
  const headers = await getHeaders();

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      problem_statement: description,
      create_pull_request: true,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Copilot Agent API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { task: CopilotTask };
  const task = data.task;

  // Validate API-returned IDs before propagating
  const validatedTaskId = validateApiId(task.id, 'task');

  let sessionId: string | null = null;
  if (task.sessions?.length > 0) {
    sessionId = validateApiId(task.sessions[0].id, 'session');
  }

  // Poll for session ID if not immediately available (up to 3 attempts, 2s apart)
  if (!sessionId) {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const updated = await getTask(owner, repo, validatedTaskId);
        if (updated.sessions?.length > 0) {
          sessionId = validateApiId(updated.sessions[0].id, 'session');
          break;
        }
      } catch {
        // Continue polling
      }
    }
  }

  return {
    taskId: validatedTaskId,
    sessionId,
    status: task.status,
  };
}

/**
 * Get a Copilot Coding Agent task by ID
 */
export async function getTask(
  owner: string,
  repo: string,
  taskId: string,
): Promise<CopilotTask> {
  const safeOwner = validateGitHubName(owner, 'owner', MAX_OWNER_LENGTH);
  const safeRepo = validateGitHubName(repo, 'repo', MAX_REPO_LENGTH);
  const url = buildApiUrl(['agents', 'repos', safeOwner, safeRepo, 'tasks', validateApiId(taskId, 'task')]);
  const headers = await getHeaders();

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Copilot Agent API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { task: CopilotTask };
  return data.task;
}

/**
 * Send a follow-up command to an active Copilot session
 */
export async function postCommand(
  sessionId: string,
  content: string,
): Promise<string> {
  const safeSessionId = validateApiId(sessionId, 'session');
  const url = buildApiUrl(['agents', 'sessions', safeSessionId, 'commands']);
  const headers = await getHeaders();

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Copilot Agent API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { id: string };
  return data.id;
}

/**
 * Check if a session has ended
 */
function isSessionEnded(state: string): boolean {
  const ended = ['completed', 'stopped', 'failed', 'cancelled', 'canceled'];
  return ended.includes(state.toLowerCase());
}
