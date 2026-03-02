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
  const url = `${getBaseUrl()}/agents/repos/${owner}/${repo}/tasks`;
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

  let sessionId: string | null = null;
  if (task.sessions?.length > 0) {
    sessionId = task.sessions[0].id;
  }

  // Poll for session ID if not immediately available (up to 3 attempts, 2s apart)
  if (!sessionId) {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const updated = await getTask(owner, repo, task.id);
        if (updated.sessions?.length > 0) {
          sessionId = updated.sessions[0].id;
          break;
        }
      } catch {
        // Continue polling
      }
    }
  }

  return {
    taskId: task.id,
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
  const url = `${getBaseUrl()}/agents/repos/${owner}/${repo}/tasks/${taskId}`;
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
  const url = `${getBaseUrl()}/agents/sessions/${sessionId}/commands`;
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
