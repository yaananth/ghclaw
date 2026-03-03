/**
 * GitHub CLI Auth Module
 * Centralized gh CLI authentication, scope checking, and token management.
 * Replaces duplicated getGhToken() across session.ts, discovery.ts, daemon.ts, doctor.ts.
 */

import { GH } from '../exec-paths';

const REQUIRED_SCOPES = ['repo', 'workflow'];

/**
 * Get GitHub token from gh CLI
 */
export async function getGhToken(): Promise<string | null> {
  try {
    const proc = Bun.spawn([GH, 'auth', 'token'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const token = (await new Response(proc.stdout).text()).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get authenticated GitHub username
 */
export async function getGhUsername(): Promise<string | null> {
  try {
    const proc = Bun.spawn([GH, 'api', 'user', '--jq', '.login'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const username = (await new Response(proc.stdout).text()).trim();
    return username || null;
  } catch {
    return null;
  }
}

/**
 * Get current auth scopes from gh CLI
 */
export async function getGhScopes(): Promise<string[]> {
  try {
    const proc = Bun.spawn([GH, 'auth', 'status'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    // Parse scopes from "Token scopes: 'repo', 'workflow', ..." format
    const scopeMatch = output.match(/Token scopes?:\s*(.+)/i);
    if (!scopeMatch) return [];

    return scopeMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check full GitHub auth status
 */
export async function checkGhAuth(): Promise<{
  authenticated: boolean;
  username: string | null;
  scopes: string[];
  missingScopes: string[];
}> {
  const token = await getGhToken();
  if (!token) {
    return { authenticated: false, username: null, scopes: [], missingScopes: REQUIRED_SCOPES };
  }

  const [username, scopes] = await Promise.all([
    getGhUsername(),
    getGhScopes(),
  ]);

  const missingScopes = REQUIRED_SCOPES.filter(s => !scopes.includes(s));

  return {
    authenticated: true,
    username,
    scopes,
    missingScopes,
  };
}

/**
 * Get the list of scopes required for ghclaw GitHub features
 */
export function getRequiredScopes(): string[] {
  return [...REQUIRED_SCOPES];
}

/**
 * Get the command to re-authenticate with missing scopes
 */
export function getReauthCommand(missingScopes: string[]): string {
  const allScopes = [...new Set([...REQUIRED_SCOPES, ...missingScopes])];
  return `gh auth refresh -s ${allScopes.join(',')}`;
}
