/**
 * Doctor - System Health Check
 * Validates all dependencies, auth, security, and configuration
 */

import { getConfigAsync, clearConfigCache } from '../config';
import { getSecret, listSecrets, isKeychainAvailable } from '../secrets/keychain';
import { TelegramClient } from '../telegram/client';
import { getSecuritySetupInstructions } from '../telegram/security';
import { checkGhAuth as checkGhAuthStatus, getGhToken, getGhScopes } from '../github/auth';
import { checkRepoExists, fixGitCredentialHelper } from '../github/repo';
import { getSyncState } from '../github/sync';

export interface DiagnosticResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  fix?: string;
  autoFixable?: boolean;
}

export interface DoctorReport {
  results: DiagnosticResult[];
  passed: number;
  warnings: number;
  errors: number;
}

/**
 * Run all diagnostic checks
 */
export async function runDoctor(autoFix = false): Promise<DoctorReport> {
  const results: DiagnosticResult[] = [];

  // 1. Check GitHub CLI auth
  results.push(await checkGhAuth());

  // 2. Check Copilot CLI installed and auth
  results.push(await checkCopilotCli());

  // 3. Check Copilot CLI auth
  results.push(await checkCopilotAuth());

  // 4. Check secrets configured (keychain)
  results.push(await checkSecretsConfigured());

  // 5. Check Telegram bot token
  results.push(await checkTelegramToken());

  // 6. Check security configuration
  results.push(...await checkSecurityConfig());

  // 7. Check data directory
  results.push(await checkDataDirectory(autoFix));

  // 8. Check for common misconfigurations
  results.push(...checkMisconfigurations());

  // 9. GitHub integration checks
  results.push(...await checkGithubIntegration(autoFix));

  // Summary
  const passed = results.filter(r => r.status === 'ok').length;
  const warnings = results.filter(r => r.status === 'warn').length;
  const errors = results.filter(r => r.status === 'error').length;

  return { results, passed, warnings, errors };
}

async function checkGhAuth(): Promise<DiagnosticResult> {
  try {
    const auth = await checkGhAuthStatus();
    if (auth.authenticated) {
      let message = auth.username ? `Authenticated as ${auth.username}` : 'Authenticated';
      if (auth.missingScopes.length > 0) {
        message += ` (missing scopes: ${auth.missingScopes.join(', ')})`;
      }
      return {
        name: 'GitHub CLI',
        status: auth.missingScopes.length > 0 ? 'warn' : 'ok',
        message,
        fix: auth.missingScopes.length > 0 ? `Run: gh auth refresh -s ${auth.missingScopes.join(',')}` : undefined,
      };
    } else {
      return {
        name: 'GitHub CLI',
        status: 'warn',
        message: 'Not authenticated',
        fix: 'Run: gh auth login',
        autoFixable: false,
      };
    }
  } catch {
    return {
      name: 'GitHub CLI',
      status: 'warn',
      message: 'gh CLI not installed',
      fix: 'Install: brew install gh',
      autoFixable: false,
    };
  }
}

async function checkCopilotCli(): Promise<DiagnosticResult> {
  try {
    const proc = Bun.spawn(['copilot', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      const version = (await new Response(proc.stdout).text()).trim();
      return {
        name: 'Copilot CLI',
        status: 'ok',
        message: `Installed (${version})`,
      };
    } else {
      return {
        name: 'Copilot CLI',
        status: 'error',
        message: 'Not working',
        fix: 'Reinstall: npm install -g @githubnext/copilot-cli',
        autoFixable: false,
      };
    }
  } catch {
    return {
      name: 'Copilot CLI',
      status: 'error',
      message: 'Not installed',
      fix: 'Install: npm install -g @githubnext/copilot-cli',
      autoFixable: false,
    };
  }
}

async function checkCopilotAuth(): Promise<DiagnosticResult> {
  try {
    // Try a simple copilot command to verify auth
    const proc = Bun.spawn(['copilot', '-p', 'Say OK', '--model', 'gpt-5-mini'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GITHUB_TOKEN: (await getGhToken()) || '',
      },
    });

    // Give it 10 seconds max
    const timeout = setTimeout(() => proc.kill(), 10000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode === 0) {
      return {
        name: 'Copilot Auth',
        status: 'ok',
        message: 'Working',
      };
    } else {
      const stderr = await new Response(proc.stderr).text();
      return {
        name: 'Copilot Auth',
        status: 'warn',
        message: stderr.slice(0, 100) || 'Auth may need refresh',
        fix: 'Run: copilot auth login',
        autoFixable: false,
      };
    }
  } catch (error) {
    return {
      name: 'Copilot Auth',
      status: 'warn',
      message: `Could not verify: ${error}`,
      fix: 'Run: copilot auth login',
    };
  }
}

async function checkSecretsConfigured(): Promise<DiagnosticResult> {
  const keychainAvail = await isKeychainAvailable();

  if (!keychainAvail) {
    return {
      name: 'Keychain',
      status: 'warn',
      message: 'Keychain not available, using env vars',
    };
  }

  const token = await getSecret('telegram-bot-token');

  if (token) {
    return {
      name: 'Secrets',
      status: 'ok',
      message: 'Bot token configured in keychain',
    };
  } else {
    return {
      name: 'Secrets',
      status: 'error',
      message: 'Bot token not found in keychain',
      fix: 'Run: ghclaw setup',
      autoFixable: false,
    };
  }
}

async function checkTelegramToken(): Promise<DiagnosticResult> {
  try {
    const config = await getConfigAsync();
    const token = config.telegram.botToken;

    if (!token || token === 'your_bot_token_here') {
      return {
        name: 'Telegram Token',
        status: 'error',
        message: 'Token not configured',
        fix: 'Run: ghclaw setup',
        autoFixable: false,
      };
    }

    const client = new TelegramClient(token);
    const me = await client.getMe();

    return {
      name: 'Telegram Bot',
      status: 'ok',
      message: `Connected as @${me.username}`,
    };
  } catch (error) {
    return {
      name: 'Telegram Bot',
      status: 'error',
      message: `Failed: ${error}`,
      fix: 'Run: ghclaw setup',
      autoFixable: false,
    };
  }
}

async function checkSecurityConfig(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  try {
    const config = await getConfigAsync();

    // Check if DMs are blocked
    if (!config.telegram.blockPrivateMessages) {
      results.push({
        name: 'Security: Block DMs',
        status: 'warn',
        message: 'Private messages are allowed',
        fix: 'Run: ghclaw setup',
        autoFixable: true,
      });
    } else {
      results.push({
        name: 'Security: Block DMs',
        status: 'ok',
        message: 'Private messages blocked',
      });
    }

    // Check if group ID is set
    if (!config.telegram.allowedGroupId) {
      results.push({
        name: 'Security: Group Restriction',
        status: 'warn',
        message: 'No group restriction configured',
        fix: 'Run: ghclaw setup (or ghclaw detect-group)',
      });
    } else {
      results.push({
        name: 'Security: Group Restriction',
        status: 'ok',
        message: `Restricted to group ${config.telegram.allowedGroupId}`,
      });
    }

    // Check if user IDs are set
    if (!config.telegram.allowedUserIds || config.telegram.allowedUserIds.length === 0) {
      results.push({
        name: 'Security: User Restriction',
        status: 'warn',
        message: 'No user restriction configured',
        fix: 'Run: ghclaw setup',
      });
    } else {
      results.push({
        name: 'Security: User Restriction',
        status: 'ok',
        message: `Allowed users: ${config.telegram.allowedUserIds.join(', ')}`,
      });
    }

  } catch {
    results.push({
      name: 'Security Config',
      status: 'error',
      message: 'Could not load config',
      fix: 'Run: ghclaw setup',
    });
  }

  return results;
}

async function checkDataDirectory(autoFix: boolean): Promise<DiagnosticResult> {
  const fs = require('fs');
  const dataDir = `${process.cwd()}/data`;

  if (fs.existsSync(dataDir)) {
    return {
      name: 'Data Directory',
      status: 'ok',
      message: './data exists',
    };
  }

  if (autoFix) {
    fs.mkdirSync(dataDir, { recursive: true });
    return {
      name: 'Data Directory',
      status: 'ok',
      message: './data created (auto-fixed)',
    };
  }

  return {
    name: 'Data Directory',
    status: 'warn',
    message: './data does not exist',
    fix: 'Will be created on first run',
    autoFixable: true,
  };
}

function checkMisconfigurations(): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];
  const fs = require('fs');
  const envPath = `${process.cwd()}/.env`;

  if (!fs.existsSync(envPath)) {
    return results;
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');

  // Check for placeholder values
  if (envContent.includes('your_bot_token_here')) {
    results.push({
      name: 'Config: Token',
      status: 'error',
      message: 'Bot token is still placeholder',
      fix: 'Update TELEGRAM_BOT_TOKEN in .env',
    });
  }

  // Check for exposed secrets in wrong location
  if (envContent.length > 10000) {
    results.push({
      name: 'Config: Size',
      status: 'warn',
      message: '.env file is unusually large',
      fix: 'Review .env for unnecessary content',
    });
  }

  // Check for sensitive patterns that shouldn't be in .env
  const sensitivePatterns = [
    /password\s*=\s*\S+/i,
    /secret_key\s*=\s*\S+/i,
    /private_key/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(envContent)) {
      results.push({
        name: 'Config: Secrets',
        status: 'warn',
        message: 'Potentially sensitive data in .env',
        fix: 'Review .env for unnecessary secrets',
      });
      break;
    }
  }

  return results;
}

async function checkGithubIntegration(autoFix = false): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  try {
    const config = await getConfigAsync();
    if (!config.github.enabled) {
      results.push({
        name: 'GitHub Integration',
        status: 'warn',
        message: 'Not enabled',
        fix: 'Run: ghclaw setup (and enable GitHub integration)',
      });
      return results;
    }

    // Check repo exists
    const exists = await checkRepoExists(config.github.username, config.github.repoName);
    results.push({
      name: 'GitHub Repo',
      status: exists ? 'ok' : 'error',
      message: exists
        ? `${config.github.username}/${config.github.repoName} exists`
        : `${config.github.username}/${config.github.repoName} not found`,
      fix: exists ? undefined : 'Run: ghclaw setup',
    });

    // Check local clone
    const fs = require('fs');
    const cloneExists = fs.existsSync(require('path').join(config.github.repoPath, '.git'));
    results.push({
      name: 'GitHub Clone',
      status: cloneExists ? 'ok' : 'error',
      message: cloneExists ? `Cloned at ${config.github.repoPath}` : 'Not cloned',
      fix: cloneExists ? undefined : 'Run: ghclaw setup',
    });

    // Verify push access by doing a dry-run
    if (cloneExists) {
      try {
        await fixGitCredentialHelper(config.github.repoPath);
        // Pull first to avoid "rejected: fetch first" false positive
        const codespaceEnv = process.env.CODESPACES === 'true'
          ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GITHUB_TOKEN') as [string, string][])
          : undefined;
        const pullProc = Bun.spawn(['git', 'pull', '--rebase', '--quiet'], {
          cwd: config.github.repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
          env: codespaceEnv,
        });
        await pullProc.exited;

        const pushProc = Bun.spawn(['git', 'push', '--dry-run'], {
          cwd: config.github.repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
          env: codespaceEnv,
        });
        const pushExit = await pushProc.exited;
        const pushStderr = (await new Response(pushProc.stderr).text()).trim();
        // "rejected" means auth works but repo is out of sync — not an auth error
        const isAuthError = pushExit !== 0 && !pushStderr.includes('rejected') && !pushStderr.includes('fetch first');
        results.push({
          name: 'GitHub Push Access',
          status: pushExit === 0 || !isAuthError ? 'ok' : 'error',
          message: pushExit === 0 ? 'Push access verified' : isAuthError ? 'Cannot push to sync repo' : 'Push access verified (repo needs sync)',
          fix: isAuthError ? 'Check gh auth: gh auth refresh -s repo,workflow' : undefined,
        });
      } catch {
        results.push({
          name: 'GitHub Push Access',
          status: 'error',
          message: 'Could not verify push access',
          fix: 'Check git remote: cd ~/.ghclaw/repo && git remote -v',
        });
      }
    }

    // Check sync state
    const sync = getSyncState();

    // Check GH_PAT secret exists (needed for reminder self-cleanup)
    try {
      const secretListProc = Bun.spawn(
        ['gh', 'secret', 'list', '-R', `${config.github.username}/${config.github.repoName}`],
        { stdout: 'pipe', stderr: 'pipe',
          env: process.env.CODESPACES === 'true'
            ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GITHUB_TOKEN') as [string, string][])
            : undefined,
        }
      );
      const secretListExit = await secretListProc.exited;
      const secretListOut = await new Response(secretListProc.stdout).text();

      if (secretListExit !== 0) {
        // gh secret list failed (auth/permission issue) — don't misdiagnose
        results.push({
          name: 'GitHub GH_PAT Secret',
          status: 'warn',
          message: 'Could not list repo secrets (auth or permission issue)',
          fix: `Run: gh auth refresh -s repo,workflow (ran: gh secret list -R ${config.github.username}/${config.github.repoName})`,
        });
      } else {
        // Match exact secret name at start of line (gh secret list outputs "NAME\tUPDATED" per line)
        const hasGhPat = /^GH_PAT\b/m.test(secretListOut);

        if (!hasGhPat) {
          let fixed = false;
          if (autoFix) {
            const [token, scopes] = await Promise.all([getGhToken(), getGhScopes()]);
            if (token && scopes.includes('repo') && scopes.includes('workflow')) {
              const { setRepoSecrets } = await import('../github/repo');
              const result = await setRepoSecrets(config.github.username, config.github.repoName, { GH_PAT: token });
              fixed = result.set.includes('GH_PAT');
            }
          }
          results.push({
            name: 'GitHub GH_PAT Secret',
            status: fixed ? 'ok' : 'warn',
            message: fixed
              ? 'GH_PAT secret set (auto-fixed)'
              : 'GH_PAT repo secret missing (reminders cannot self-delete)',
            fix: fixed ? undefined : 'Run: ghclaw setup (or: gh secret set GH_PAT -R owner/repo)',
            autoFixable: !fixed,
          });
        } else {
          results.push({
            name: 'GitHub GH_PAT Secret',
            status: 'ok',
            message: 'GH_PAT secret configured (reminders can self-cleanup)',
          });
        }
      }
    } catch {
      results.push({
        name: 'GitHub GH_PAT Secret',
        status: 'warn',
        message: 'Could not check GH_PAT secret',
        fix: 'Run: gh secret set GH_PAT -R owner/repo',
      });
    }
    if (sync.lastSync) {
      const ageMs = Date.now() - sync.lastSync.getTime();
      const ageMin = Math.floor(ageMs / 60000);
      results.push({
        name: 'GitHub Sync',
        status: ageMin < 5 ? 'ok' : 'warn',
        message: `Last sync ${ageMin}m ago (${sync.syncCount} total)`,
        fix: ageMin >= 5 ? 'Sync loop may not be running. Start daemon: ghclaw start' : undefined,
      });
    } else {
      results.push({
        name: 'GitHub Sync',
        status: 'warn',
        message: 'Never synced',
        fix: 'Start daemon: ghclaw start',
      });
    }
  } catch {
    results.push({
      name: 'GitHub Integration',
      status: 'warn',
      message: 'Could not check (config may not be loaded)',
    });
  }

  return results;
}

/**
 * Format doctor report for display
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║                     GHClaw Doctor                          ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ];

  for (const result of report.results) {
    const icon = result.status === 'ok' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
    lines.push(`${icon} ${result.name}: ${result.message}`);
    if (result.fix && result.status !== 'ok') {
      lines.push(`   └─ Fix: ${result.fix}`);
    }
  }

  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────');
  lines.push(`Summary: ${report.passed} passed, ${report.warnings} warnings, ${report.errors} errors`);

  if (report.errors > 0) {
    lines.push('');
    lines.push('❌ Fix errors before starting the daemon');
  } else if (report.warnings > 0) {
    lines.push('');
    lines.push('⚠️ Warnings are non-blocking but should be addressed');
  } else {
    lines.push('');
    lines.push('✅ All checks passed! Run: ghclaw start');
  }

  return lines.join('\n');
}

// Run if called directly
if (import.meta.main) {
  const report = await runDoctor(false);
  console.log(formatDoctorReport(report));
}
