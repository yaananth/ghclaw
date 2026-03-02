/**
 * gh-aw (GitHub Agentic Workflows) Executor
 *
 * Thin wrapper around the `gh aw` CLI extension.
 * Used for scheduled agentic workflows that need LLM capabilities
 * (e.g., "every Monday review open PRs").
 *
 * Prerequisites: `gh extension install github/gh-aw`
 */

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
  return runGhAw(repoPath, ['new', name]);
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
  return runGhAw(repoPath, ['run', name]);
}

/**
 * List existing agentic workflows
 */
export async function ghAwList(repoPath: string): Promise<string> {
  const proc = Bun.spawn(['gh', 'aw', 'list'], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gh aw list failed: ${stderr.trim()}`);
  }

  return stdout.trim();
}

/**
 * Check if gh-aw extension is installed
 */
export async function isGhAwInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['gh', 'aw', '--help'], {
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

async function runGhAw(repoPath: string, args: string[]): Promise<boolean> {
  const proc = Bun.spawn(['gh', 'aw', ...args], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gh aw ${args[0]} failed: ${stderr.trim()}`);
  }

  return true;
}
