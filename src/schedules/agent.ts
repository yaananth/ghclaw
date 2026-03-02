/**
 * CCA (Copilot Coding Agent) Integration
 *
 * Creates Copilot Coding Agent tasks via the enterprise API.
 * Falls back to GitHub Issues assigned to @copilot if API is unavailable.
 */

import { createCodingAgentTask, type CreateTaskResult } from '../copilot/agent';

/**
 * Create a task for Copilot Coding Agent
 * Tries the enterprise API first, falls back to gh issue create
 */
export async function createAgentTask(
  username: string,
  repoName: string,
  description: string,
  createdBy: string
): Promise<{ issueNumber: number; issueUrl: string; taskId?: string; sessionId?: string }> {
  // Try the Copilot Agent API first
  try {
    const result = await createCodingAgentTask(username, repoName, description);
    return {
      issueNumber: 0,
      issueUrl: '',
      taskId: result.taskId,
      sessionId: result.sessionId ?? undefined,
    };
  } catch (apiErr: any) {
    console.log(`⚠️ Copilot Agent API failed (${apiErr.message}), falling back to gh issue create`);
  }

  // Fallback: create a GitHub Issue assigned to @copilot
  const title = description.split('\n')[0].slice(0, 60).trim() || 'Agent task';

  const body = `## Task

${description}

---
*Created by ghclaw via Telegram (@${createdBy || 'unknown'})*`;

  const proc = Bun.spawn([
    'gh', 'issue', 'create',
    '--repo', `${username}/${repoName}`,
    '--title', title,
    '--body', body,
    '--assignee', '@me',
    '--label', 'copilot',
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create issue: ${stderr}`);
  }

  const issueUrl = stdout;
  const numberMatch = issueUrl.match(/\/issues\/(\d+)/);
  const issueNumber = numberMatch ? parseInt(numberMatch[1]) : 0;

  return { issueNumber, issueUrl };
}
