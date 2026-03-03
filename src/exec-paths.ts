/**
 * Resolve git/gh to absolute paths at import time.
 *
 * When the daemon runs detached (`detached: true` in spawn),
 * Bun.spawn may fail to resolve bare command names if the child
 * process inherits a stripped-down PATH. Resolving once at startup
 * while the full shell PATH is still available fixes this on
 * macOS, Linux, and Windows.
 */

function which(cmd: string): string {
  // Windows: use 'where', others: use 'which'
  const isWin = process.platform === 'win32';
  const lookup = isWin ? ['where', cmd] : ['which', cmd];

  try {
    const result = Bun.spawnSync(lookup, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = result.stdout.toString().trim();
    // 'where' on Windows may return multiple lines; take the first
    const firstLine = out.split('\n')[0]?.trim();
    if (result.exitCode === 0 && firstLine) {
      return firstLine;
    }
  } catch {
    // fall through
  }

  // Fallback: return bare name and hope PATH works at call time
  return cmd;
}

/** Absolute path to git (or bare 'git' as fallback) */
export const GIT = which('git');

/** Absolute path to gh CLI (or bare 'gh' as fallback) */
export const GH = which('gh');
