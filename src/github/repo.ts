/**
 * GitHub Repo Provisioning & Git Operations
 * Handles creating/cloning the .ghclaw sync repo and git operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getGhToken } from './auth';

// Simple async mutex to prevent concurrent git operations on the same repo.
// The sync loop and handoff push both operate on the same working tree —
// concurrent git add/commit/push causes silent failures.
let gitLock: Promise<void> = Promise.resolve();

export async function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const prev = gitLock;
  gitLock = new Promise<void>(resolve => { release = resolve; });
  await prev; // Wait for previous operation to finish
  try {
    return await fn();
  } finally {
    release!();
  }
}

/**
 * Build env for gh/git CLI calls.
 * In Codespaces (CODESPACES=true), strips GITHUB_TOKEN which has limited scopes
 * and overrides stored user auth. Outside Codespaces, returns process.env as-is.
 */
function cleanGhEnv(): Record<string, string> | undefined {
  if (process.env.CODESPACES !== 'true') return undefined; // use default env
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'GITHUB_TOKEN') continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Check if the sync repo exists on GitHub
 */
export async function checkRepoExists(username: string, repoName: string = '.ghclaw'): Promise<boolean> {
  const env = cleanGhEnv();

  // Try gh repo view first
  const proc = Bun.spawn(['gh', 'repo', 'view', `${username}/${repoName}`, '--json', 'name'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) return true;
  const viewErr = (await new Response(proc.stderr).text()).trim();

  // Fallback: try REST API directly (handles tokens that can't use GraphQL)
  const apiProc = Bun.spawn(['gh', 'api', `repos/${username}/${repoName}`, '--jq', '.name'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const apiExit = await apiProc.exited;
  if (apiExit === 0) return true;
  const apiErr = (await new Response(apiProc.stderr).text()).trim();

  // Log errors for debugging
  if (viewErr || apiErr) {
    console.log(`   (repo check: view=${viewErr || 'exit ' + exitCode}, api=${apiErr || 'exit ' + apiExit})`);
  }
  return false;
}

/**
 * Create the private sync repo on GitHub
 */
export async function createRepo(username: string, repoName: string = '.ghclaw'): Promise<boolean> {
  // Double-check it doesn't already exist (avoid unnecessary create attempts)
  if (await checkRepoExists(username, repoName)) {
    return true;
  }

  const proc = Bun.spawn([
    'gh', 'repo', 'create', `${username}/${repoName}`,
    '--private',
    '--description', 'ghclaw cross-machine sync (auto-managed)',
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanGhEnv(),
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // If create failed, check if it actually exists (Codespace tokens may lack create permission)
    if (await checkRepoExists(username, repoName)) {
      return true;
    }
    console.error(`Failed to create repo: ${stderr}`);
  }
  return exitCode === 0;
}

/**
 * Clone the sync repo to local path
 */
export async function cloneRepo(username: string, localPath: string, repoName: string = '.ghclaw'): Promise<void> {
  // Remove existing dir if empty
  if (fs.existsSync(localPath)) {
    const contents = fs.readdirSync(localPath);
    if (contents.length === 0) {
      fs.rmdirSync(localPath);
    } else if (fs.existsSync(path.join(localPath, '.git'))) {
      // Already cloned — ensure credential helper is correct
      await fixGitCredentialHelper(localPath);
      return;
    }
  }

  const proc = Bun.spawn([
    'gh', 'repo', 'clone', `${username}/${repoName}`, localPath,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanGhEnv(),
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to clone repo: ${stderr}`);
  }

  // In Codespaces, override the credential helper so git uses gh auth
  // instead of the Codespace-provided helper (which returns a limited token)
  await fixGitCredentialHelper(localPath);
}

/**
 * Fix git credentials for Codespaces.
 * The Codespace-provided credential helper returns a limited GITHUB_TOKEN.
 * Replace remote URL with token-authenticated URL using gh auth token.
 */
export async function fixGitCredentialHelper(repoPath: string): Promise<void> {
  // Only needed in Codespaces where the credential helper returns a limited token
  if (process.env.CODESPACES !== 'true') return;

  // Check if current remote uses github.com https
  const proc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repoPath,
  });
  await proc.exited;
  const remoteUrl = (await new Response(proc.stdout).text()).trim();
  if (!remoteUrl.startsWith('https://github.com/')) return;

  // Already has token embedded
  if (remoteUrl.includes('x-access-token:')) return;

  // Get the proper user token via gh auth (with GITHUB_TOKEN cleared)
  const tokenProc = Bun.spawn(['gh', 'auth', 'token'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanGhEnv(),
  });
  const tokenExit = await tokenProc.exited;
  if (tokenExit !== 0) return;
  const token = (await new Response(tokenProc.stdout).text()).trim();
  if (!token) return;

  // Set remote URL with token embedded
  const repoPath_ = remoteUrl.replace('https://github.com/', '');
  const newUrl = `https://x-access-token:${token}@github.com/${repoPath_}`;
  const setProc = Bun.spawn(['git', 'remote', 'set-url', 'origin', newUrl], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repoPath,
  });
  await setProc.exited;
}

/**
 * Initialize repo structure with required directories and files
 */
export async function initRepoStructure(repoPath: string): Promise<void> {
  // Create directories
  fs.mkdirSync(path.join(repoPath, 'memory', 'machines'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, '.github', 'workflows'), { recursive: true });

  // README
  const readmePath = path.join(repoPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# .ghclaw

Auto-managed repository for cross-machine sync.

## Structure

- \`memory/\` — Session data exported from local SQLite
- \`memory/machines/\` — Per-machine session snapshots
- \`.github/workflows/\` — Reminders, schedules, and notification workflows

## How it works

ghclaw syncs local session data to this repo every 5 seconds.
GitHub Actions workflows handle reminders and recurring schedules.
Telegram notifications are sent via the \`TELEGRAM_BOT_TOKEN\` secret.

> This repo is auto-managed. Manual edits may be overwritten.
`);
  }

  // Base notification workflow (reusable)
  const notifyPath = path.join(repoPath, '.github', 'workflows', 'notify.yml');
  if (!fs.existsSync(notifyPath)) {
    fs.writeFileSync(notifyPath, `name: Send Notification
on:
  workflow_call:
    inputs:
      message:
        required: true
        type: string
      chat_id:
        required: false
        type: string
      thread_id:
        required: false
        type: string
    secrets:
      TELEGRAM_BOT_TOKEN:
        required: true
      TELEGRAM_CHAT_ID:
        required: true
      TELEGRAM_THREAD_ID:
        required: false

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Send Telegram message
        run: |
          CHAT_ID="\${INPUT_CHAT_ID:-\${{ secrets.TELEGRAM_CHAT_ID }}}"
          THREAD_ID="\${INPUT_THREAD_ID:-\${{ secrets.TELEGRAM_THREAD_ID }}}"
          curl -s -X POST "https://api.telegram.org/bot\${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \\
            --data-urlencode "chat_id=$CHAT_ID" \\
            --data-urlencode "text=$NOTIFY_MESSAGE" \\
            \${THREAD_ID:+--data-urlencode "message_thread_id=$THREAD_ID"}
        env:
          INPUT_CHAT_ID: \${{ inputs.chat_id }}
          INPUT_THREAD_ID: \${{ inputs.thread_id }}
          NOTIFY_MESSAGE: \${{ inputs.message }}
`);
  }

  // Commit if there are changes
  await gitCommitAndPush(repoPath, 'Initialize repo structure');
}

/**
 * Set repository secrets using gh CLI
 */
export async function setRepoSecrets(
  username: string,
  repoName: string,
  secrets: Record<string, string>
): Promise<{ set: string[]; failed: string[] }> {
  const set: string[] = [];
  const failed: string[] = [];

  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;

    // Pipe secret via stdin to avoid exposing in process args (visible via ps)
    const proc = Bun.spawn([
      'gh', 'secret', 'set', name,
      '--repo', `${username}/${repoName}`,
    ], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: cleanGhEnv(),
    });
    proc.stdin.write(value);
    proc.stdin.end();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      set.push(name);
    } else {
      failed.push(name);
    }
  }

  return { set, failed };
}

/**
 * Pull latest changes from remote
 */
export async function gitPull(repoPath: string): Promise<boolean> {
  return withGitLock(async () => {
    await fixGitCredentialHelper(repoPath);

    // Abort any stuck rebase first
    const statusProc = Bun.spawn(['git', 'status'], {
      stdout: 'pipe', stderr: 'pipe', cwd: repoPath,
    });
    await statusProc.exited;
    const statusOut = (await new Response(statusProc.stdout).text());
    if (statusOut.includes('rebase in progress') || statusOut.includes('rebasing')) {
      Bun.spawn(['git', 'rebase', '--abort'], {
        stdout: 'pipe', stderr: 'pipe', cwd: repoPath, env: cleanGhEnv(),
      });
      await new Promise(r => setTimeout(r, 500));
    }

    // Use merge (not rebase) to avoid conflicts between concurrent machine syncs
    const proc = Bun.spawn(['git', 'pull', '--no-rebase', '--quiet', '--strategy=recursive', '--strategy-option=theirs'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoPath,
      env: cleanGhEnv(),
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  });
}

/**
 * Commit and push changes if any exist
 */
export async function gitCommitAndPush(repoPath: string, message: string): Promise<boolean> {
  return withGitLock(async () => {
    if (!(await hasChangesUnsafe(repoPath))) return false;
    await fixGitCredentialHelper(repoPath);

    // Stage only known managed paths (avoid staging unexpected files)
    const add = Bun.spawn(['git', 'add', 'memory/', '.github/workflows/', 'README.md'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoPath,
      env: cleanGhEnv(),
    });
    await add.exited;

    // Commit
    const commit = Bun.spawn(['git', 'commit', '-m', message, '--quiet'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoPath,
      env: cleanGhEnv(),
    });
    const commitExit = await commit.exited;
    if (commitExit !== 0) return false;

    // Push
    const push = Bun.spawn(['git', 'push', '--quiet'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoPath,
      env: cleanGhEnv(),
    });
    const pushExit = await push.exited;
    return pushExit === 0;
  });
}

/**
 * Check if there are uncommitted changes in the repo (no lock — safe for internal use)
 */
async function hasChangesUnsafe(repoPath: string): Promise<boolean> {
  const proc = Bun.spawn(['git', 'status', '--porcelain'], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repoPath,
  });
  await proc.exited;
  const output = (await new Response(proc.stdout).text()).trim();
  return output.length > 0;
}

/**
 * Check if there are uncommitted changes in the repo
 */
export async function hasChanges(repoPath: string): Promise<boolean> {
  return hasChangesUnsafe(repoPath);
}
