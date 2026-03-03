/**
 * Version management for ghclaw
 *
 * Reads version from package.json (single source of truth).
 * Provides update checking against the GitHub remote.
 */

import * as path from 'path';
import * as fs from 'fs';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');

/** Get current installed version from package.json */
export function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Get the git commit hash (short) for the installed version */
export function getCommitHash(): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.stdout.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Check if there are updates available on the remote */
export async function checkForUpdates(): Promise<{
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  behindBy: number;
}> {
  const current = getVersion();

  try {
    // Fetch remote without changing local state
    Bun.spawnSync(['git', 'fetch', '--quiet', 'origin', 'main'], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Count commits behind
    const behindResult = Bun.spawnSync(
      ['git', 'rev-list', '--count', 'HEAD..origin/main'],
      { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    const behindBy = parseInt(behindResult.stdout.toString().trim()) || 0;

    // Read remote package.json version
    let latest: string | null = null;
    if (behindBy > 0) {
      const remoteVersionResult = Bun.spawnSync(
        ['git', 'show', 'origin/main:package.json'],
        { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' }
      );
      try {
        const remotePkg = JSON.parse(remoteVersionResult.stdout.toString());
        latest = remotePkg.version || null;
      } catch {
        latest = null;
      }
    }

    return {
      current,
      latest: latest || current,
      updateAvailable: behindBy > 0,
      behindBy,
    };
  } catch {
    return { current, latest: null, updateAvailable: false, behindBy: 0 };
  }
}
