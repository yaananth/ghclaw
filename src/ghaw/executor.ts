/**
 * gh-aw (GitHub Agentic Workflows) Executor
 *
 * Thin wrapper around the `gh aw` CLI extension.
 * Used for scheduled agentic workflows that need LLM capabilities
 * (e.g., "every Monday review open PRs").
 *
 * Prerequisites: `gh extension install github/gh-aw`
 *
 * SECURITY:
 * - All spawns use argv arrays (no shell interpolation)
 * - Subcommands are allowlisted
 * - Workflow names validated against strict charset
 * - Fixed working directory
 * - Output captured (not inherited)
 */

import { GH } from '../exec-paths';

/** Allowed gh-aw subcommands */
const ALLOWED_SUBCOMMANDS = new Set(['init', 'new', 'compile', 'run', 'list', '--help']);

/** Workflow name: lowercase alphanumeric + hyphens, no leading hyphen/dot, max 30 chars */
const WORKFLOW_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]?$/;

/**
 * Validate a gh-aw subcommand
 */
function validateSubcommand(cmd: string): string {
  if (!ALLOWED_SUBCOMMANDS.has(cmd)) {
    throw new Error(`Disallowed gh-aw subcommand: ${cmd}`);
  }
  return cmd;
}

/**
 * Validate a workflow name for safe use as a CLI argument and filename
 */
function validateWorkflowName(name: string): string {
  if (!name || name.length > 30) {
    throw new Error('Workflow name must be 1-30 characters');
  }
  if (!WORKFLOW_NAME_REGEX.test(name)) {
    throw new Error('Workflow name must be lowercase alphanumeric with hyphens only (no leading hyphen)');
  }
  return name;
}

/**
 * Initialize gh-aw in a repository
 */
export async function ghAwInit(repoPath: string): Promise<boolean> {
  return runGhAw(repoPath, ['init']);
}

/**
 * Create a new agentic workflow markdown file
 */
export async function ghAwNew(repoPath: string, name: string): Promise<boolean> {
  const safeName = validateWorkflowName(name);
  return runGhAw(repoPath, ['new', safeName]);
}

/**
 * Compile workflow markdown to GitHub Actions YAML
 */
export async function ghAwCompile(repoPath: string): Promise<boolean> {
  return runGhAw(repoPath, ['compile']);
}

/**
 * Run an agentic workflow
 */
export async function ghAwRun(repoPath: string, name: string): Promise<boolean> {
  const safeName = validateWorkflowName(name);
  return runGhAw(repoPath, ['run', safeName]);
}

/**
 * List existing agentic workflows
 */
export async function ghAwList(repoPath: string): Promise<string> {
  const proc = Bun.spawn([GH, 'aw', 'list'], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutPromise = readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_SIZE);
  const stderrPromise = readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_SIZE);

  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (exitCode !== 0) {
    throw new Error(`gh aw list failed: ${stderr.trim().slice(0, 200)}`);
  }

  return stdout.trim();
}

/**
 * Check if gh-aw extension is installed
 */
export async function isGhAwInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn([GH, 'aw', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Internal
// ============================================================================

/** Max output to capture from gh-aw (prevents memory abuse) */
const MAX_OUTPUT_SIZE = 10_000;

/**
 * Read a stream with a size cap. Returns at most maxBytes characters.
 */
async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (totalSize < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - totalSize;
      if (value.length <= remaining) {
        chunks.push(value);
        totalSize += value.length;
      } else {
        chunks.push(value.subarray(0, remaining));
        totalSize += remaining;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  const combined = Buffer.concat(chunks);
  return combined.toString('utf-8');
}

async function runGhAw(repoPath: string, args: string[]): Promise<boolean> {
  // Validate the subcommand (first arg)
  if (args.length > 0) {
    validateSubcommand(args[0]);
  }

  const proc = Bun.spawn([GH, 'aw', ...args], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutPromise = readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_SIZE);
  const stderrPromise = readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_SIZE);

  const exitCode = await proc.exited;
  const [, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (exitCode !== 0) {
    throw new Error(`gh aw ${args[0]} failed: ${stderr.trim().slice(0, 200)}`);
  }

  return true;
}
