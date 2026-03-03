#!/usr/bin/env bun
/**
 * GHClaw CLI
 * Personal AI assistant powered by Copilot CLI
 *
 * Usage: ghclaw <command>
 */

import { Command } from 'commander';
import { runSetup } from '../src/cli/setup';
import { runDoctor, formatDoctorReport } from '../src/cli/doctor';
import { main as startDaemon } from '../src/daemon';
import { discoverCopilotFeatures, formatDiscovery } from '../src/copilot/discovery';
import { TelegramClient } from '../src/telegram/client';
import { getSecuritySetupInstructions } from '../src/telegram/security';
import { getConfigAsync, getConfigDir, isConfigComplete } from '../src/config';
import { getActiveSessions, archiveOldSessions, getSessionStats, getSessionsByMachine } from '../src/memory/session-mapper';
import { getSyncState, startSyncLoop } from '../src/github/sync';
import { checkGhAuth } from '../src/github/auth';
import {
  setSecret,
  getSecret,
  deleteSecret,
  listSecrets,
  isKeychainAvailable,
  getManualInstructions,
  migrateFromEnv,
  getPlatform,
} from '../src/secrets/keychain';
import { getVersion } from '../src/version';

const program = new Command();

program
  .name('ghclaw')
  .description('Personal AI assistant powered by Copilot CLI')
  .version(getVersion());

// ============================================================================
// Status
// ============================================================================

program
  .command('status')
  .description('Show current bot status at a glance')
  .action(async () => {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                     GHClaw Status                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log(`Version: v${getVersion()}`);

    // Config status
    const { complete, missing } = await isConfigComplete();
    console.log(`Config: ${complete ? '✅ Complete' : '❌ Incomplete (' + missing.join(', ') + ')'}`);

    // Machine info
    if (complete) {
      try {
        const config = await getConfigAsync();
        console.log(`Machine: ${config.machine.name} (${config.machine.id.slice(0, 8)})`);
      } catch {}
    }
    // Keychain
    console.log(`Keychain: ${await isKeychainAvailable() ? '✅ Available' : '❌ Not available'}`);

    // Secrets
    const secrets = await listSecrets();
    console.log(`Secrets: ${secrets.length > 0 ? secrets.join(', ') : 'none'}`);

    // Telegram connection
    if (complete) {
      try {
        const config = await getConfigAsync();
        const client = new TelegramClient(config.telegram.botToken);
        const me = await client.getMe();
        console.log(`Telegram: ✅ @${me.username}`);
        console.log(`YOLO Mode: ${config.copilot.yoloMode ? '🔥 Enabled' : '❌ Disabled'}`);
      } catch (error) {
        console.log(`Telegram: ❌ Not connected`);
      }
    }

    // Memory stats
    try {
      const stats = getSessionStats();
      console.log(`\nSessions:`);
      console.log(`  Active: ${stats.activeSessions}`);
      console.log(`  Total messages: ${stats.totalMessages}`);
      console.log(`  (Memory via Copilot CLI Chronicle)`);

      // Show machine-specific session counts
      try {
        const config = await getConfigAsync();
        const mySessions = getSessionsByMachine(config.machine.id);
        const otherCount = stats.activeSessions - mySessions.length;
        if (otherCount > 0) {
          console.log(`  This machine: ${mySessions.length}, Other machines: ${otherCount}`);
        }
      } catch {}
    } catch {
      console.log(`\nSessions: No sessions yet`);
    }

    // Daemon status (check for lock file or process)
    const fs = require('fs');
    const lockFile = `${getConfigDir()}/daemon.lock`;
    if (fs.existsSync(lockFile)) {
      const pid = fs.readFileSync(lockFile, 'utf-8').trim();
      console.log(`\nDaemon: 🟢 Running (PID ${pid})`);
    } else {
      console.log(`\nDaemon: ⚪ Not running`);
    }

    console.log('');
  });

// ============================================================================
// Setup & Configuration
// ============================================================================

program
  .command('setup')
  .description('Interactive setup wizard')
  .action(async () => {
    await runSetup();
  });

program
  .command('doctor')
  .description('Check system health, dependencies, auth, and security')
  .option('--fix', 'Auto-fix issues where possible')
  .action(async (options) => {
    const report = await runDoctor(options.fix);
    console.log(formatDoctorReport(report));

    // Exit with error code if there are errors
    if (report.errors > 0) {
      process.exit(1);
    }
    process.exit(0);
  });

program
  .command('config')
  .description('Show configuration status and paths')
  .action(async () => {
    console.log('Configuration:\n');
    console.log(`  Config directory: ${getConfigDir()}`);
    console.log(`  Platform: ${getPlatform()}`);
    console.log(`  Keychain available: ${await isKeychainAvailable()}`);
    console.log('');

    const { complete, missing } = await isConfigComplete();
    if (complete) {
      console.log('✅ Configuration is complete\n');
      try {
        const config = await getConfigAsync();
        console.log('Current config (secrets redacted):');
        console.log(JSON.stringify({
          telegram: {
            ...config.telegram,
            botToken: config.telegram.botToken ? '***configured***' : 'NOT SET',
            secretPrefix: config.telegram.secretPrefix ? '***configured***' : undefined,
          },
          copilot: config.copilot,
          memory: config.memory,
        }, null, 2));
      } catch (error) {
        console.log(`Could not load config: ${error}`);
      }
    } else {
      console.log('❌ Configuration incomplete\n');
      console.log('Missing:');
      for (const key of missing) {
        console.log(`  - ${key}`);
      }
      console.log('\nRun: ghclaw setup');
    }
  });

// ============================================================================
// Secrets Management
// ============================================================================

const secretsCmd = program.command('secrets').description('Manage secrets in OS keychain');

secretsCmd
  .command('list')
  .description('List stored secret keys')
  .action(async () => {
    const keys = await listSecrets();
    if (keys.length === 0) {
      console.log('No secrets stored. Run: ghclaw setup');
    } else {
      console.log('Stored secrets:');
      for (const key of keys) {
        console.log(`  - ${key}`);
      }
    }
  });

secretsCmd
  .command('set <key> <value>')
  .description('Store a secret')
  .action(async (key, value) => {
    const success = await setSecret(key, value);
    if (success) {
      console.log(`✅ Secret '${key}' stored in keychain`);
    } else {
      console.log(`❌ Failed to store secret`);
      console.log(getManualInstructions());
    }
  });

secretsCmd
  .command('get <key>')
  .description('Retrieve a secret')
  .action(async (key) => {
    const value = await getSecret(key);
    if (value) {
      console.log(value);
    } else {
      console.log(`Secret '${key}' not found`);
    }
  });

secretsCmd
  .command('delete <key>')
  .description('Delete a secret')
  .action(async (key) => {
    const success = await deleteSecret(key);
    console.log(success ? `✅ Deleted '${key}'` : `❌ Could not delete '${key}'`);
  });

secretsCmd
  .command('migrate')
  .description('Migrate secrets from .env file to keychain')
  .action(async () => {
    const envPath = `${process.cwd()}/.env`;
    console.log(`Migrating secrets from ${envPath} to keychain...\n`);

    const { migrated, failed } = await migrateFromEnv(envPath);

    if (migrated.length > 0) {
      console.log('✅ Migrated:');
      for (const key of migrated) {
        console.log(`   - ${key}`);
      }
    }
    if (failed.length > 0) {
      console.log('❌ Failed:');
      for (const key of failed) {
        console.log(`   - ${key}`);
      }
    }
    if (migrated.length === 0 && failed.length === 0) {
      console.log('No secrets found to migrate');
    }

    if (migrated.length > 0) {
      console.log('\n⚠️  You can now delete sensitive values from .env');
    }
  });

secretsCmd
  .command('manual')
  .description('Show manual keychain instructions for your OS')
  .action(() => {
    console.log(getManualInstructions());
  });

// ============================================================================
// Daemon Control
// ============================================================================

program
  .command('start')
  .description('Start the Telegram polling daemon')
  .option('-f, --foreground', 'Run in foreground (for debugging)')
  .action(async (options) => {
    // Run doctor first
    console.log('🏥 Running pre-flight checks...\n');
    const report = await runDoctor(true);

    if (report.errors > 0) {
      console.log(formatDoctorReport(report));
      console.log('\n❌ Fix errors before starting');
      process.exit(1);
    }

    console.log('✅ All checks passed\n');

    if (options.foreground) {
      await startDaemon();
    } else {
      // Background by default
      const { spawn } = require('child_process');
      const logFile = `${getConfigDir()}/daemon.log`;
      const out = require('fs').openSync(logFile, 'a');
      const err = require('fs').openSync(logFile, 'a');

      const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground'], {
        detached: true,
        stdio: ['ignore', out, err],
      });

      child.unref();
      console.log(`🚀 Daemon started in background (PID ${child.pid})`);
      console.log(`   Logs: ghclaw logs`);
      console.log(`   Stop: ghclaw stop\n`);
      process.exit(0);
    }
  });

program
  .command('stop')
  .description('Stop the running daemon')
  .action(() => {
    const fs = require('fs');
    const lockFile = `${getConfigDir()}/daemon.lock`;

    if (!fs.existsSync(lockFile)) {
      console.log('⚪ No daemon running');
      return;
    }

    const pid = fs.readFileSync(lockFile, 'utf-8').trim();
    const pidNum = parseInt(pid);
    if (isNaN(pidNum) || pidNum <= 0) {
      console.log('⚠️  Invalid PID in lock file, removing');
      fs.unlinkSync(lockFile);
      return;
    }
    try {
      process.kill(pidNum, 'SIGTERM');
      console.log(`🛑 Sent stop signal to daemon (PID ${pidNum})`);
      // Wait for process to actually exit before cleaning up lock file
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        try {
          process.kill(pidNum, 0); // Check if still alive
          if (attempts >= 10) {
            clearInterval(checkInterval);
            console.log(`⚠️  Daemon still running after 5s. Lock file retained.`);
          }
        } catch {
          // Process gone — safe to clean up
          clearInterval(checkInterval);
          if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
          }
          console.log(`✅ Daemon stopped`);
        }
      }, 500);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        console.log('⚠️  Daemon not running, cleaning up stale lock file');
        fs.unlinkSync(lockFile);
      } else {
        console.error('Error stopping daemon:', err);
      }
    }
  });

program
  .command('logs')
  .description('View daemon logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .action(async (options) => {
    const { spawn } = require('child_process');
    const logFile = `${getConfigDir()}/daemon.log`;
    const fs = require('fs');

    if (!fs.existsSync(logFile)) {
      console.log('📭 No logs yet. Start the daemon first: ghclaw start');
      return;
    }

    if (options.follow) {
      const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
      process.on('SIGINT', () => tail.kill());
    } else {
      const tail = spawn('tail', ['-n', options.lines, logFile], { stdio: 'inherit' });
      await new Promise(resolve => tail.on('close', resolve));
    }
  });

program
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    const fs = require('fs');
    const { spawn } = require('child_process');
    const lockFile = `${getConfigDir()}/daemon.lock`;

    // Stop existing daemon
    if (fs.existsSync(lockFile)) {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim());
      if (!isNaN(pid) && pid > 0) {
        console.log(`🛑 Stopping daemon (PID ${pid})...`);
        try {
          process.kill(pid, 'SIGTERM');
          // Wait for exit
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            try { process.kill(pid, 0); } catch { break; }
          }
          // Force kill if still alive
          try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
        } catch {}
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        console.log('   ✅ Stopped');
      } else {
        fs.unlinkSync(lockFile);
      }
    } else {
      console.log('⚪ No daemon running');
    }

    // Start new daemon
    console.log('🚀 Starting daemon...');
    const logFile = `${getConfigDir()}/daemon.log`;
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');

    const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground'], {
      detached: true,
      stdio: ['ignore', out, err],
    });

    child.unref();
    console.log(`✅ Daemon restarted (PID ${child.pid})`);
    console.log(`   Logs: ghclaw logs -f`);
    process.exit(0);
  });

program
  .command('upgrade')
  .description('Pull latest code, install deps, and restart daemon')
  .action(async () => {
    const fs = require('fs');
    const { spawnSync, spawn } = require('child_process');
    const projectDir = require('path').resolve(__dirname, '..');

    const beforeVersion = getVersion();
    console.log(`📦 Upgrading ghclaw from v${beforeVersion}...\n`);

    // Check for git remote
    const remoteCheck = spawnSync('git', ['remote', '-v'], { cwd: projectDir });
    if (!remoteCheck.stdout?.toString().trim()) {
      console.log('⚠️  No git remote configured. Adding origin...');
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/yaananth/ghclaw.git'], { cwd: projectDir });
    }

    // Pull latest (autostash handles local uncommitted changes)
    console.log('🔄 Pulling latest changes...');
    const pull = spawnSync('git', ['pull', '--rebase', '--autostash'], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    if (pull.status !== 0) {
      console.log('❌ Pull failed. Fix conflicts and retry.');
      process.exit(1);
    }

    // Install deps
    console.log('\n📥 Installing dependencies...');
    const install = spawnSync(process.execPath, ['install'], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    if (install.status !== 0) {
      console.log('❌ Install failed.');
      process.exit(1);
    }

    // Re-link binary (suppress output — it's just a re-registration)
    console.log('\n🔗 Linking binary...');
    const link = spawnSync(process.execPath, ['link'], { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' });
    if (link.status === 0) {
      console.log('✅ Binary linked');
    } else {
      console.log('⚠️  Link failed:', link.stderr?.toString().trim());
    }

    // Run health check in a fresh process (so it uses the newly-pulled code)
    // Doctor exits 1 only on errors (not warnings), but also handle unexpected exit codes
    console.log('\n🩺 Running health check...');
    const doctorProc = Bun.spawnSync([process.execPath, process.argv[1], 'doctor', '--fix'], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });
    const doctorOk = doctorProc.exitCode !== 1; // Only block on explicit error exit

    // If config is incomplete, prompt setup
    if (!isConfigComplete()) {
      console.log('\n⚠️  Configuration incomplete. Running setup...\n');
      await runSetup();
      return; // setup handles daemon start
    }

    if (!doctorOk) {
      console.log('\n⚠️  Health check found errors. Run: ghclaw doctor --fix');
    }

    // (Re)start daemon
    const lockFile = `${getConfigDir()}/daemon.lock`;
    let daemonRunning = false;
    if (fs.existsSync(lockFile)) {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim());
      if (!isNaN(pid) && pid > 0) {
        try { process.kill(pid, 0); daemonRunning = true; } catch {}
      }
    }

    if (daemonRunning) {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim());
      console.log('\n🔄 Restarting daemon...');
      try {
        process.kill(pid, 'SIGTERM');
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          try { process.kill(pid, 0); } catch { break; }
        }
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
      } catch {}
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    }

    // Start daemon (fresh or restart)
    if (doctorOk) {
      console.log(daemonRunning ? '' : '\n🚀 Starting daemon...');
      const logFile = `${getConfigDir()}/daemon.log`;
      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground'], {
        detached: true,
        stdio: ['ignore', out, err],
      });
      child.unref();
      console.log(`✅ Daemon ${daemonRunning ? 'restarted' : 'started'} (PID ${child.pid})`);
    } else {
      console.log('\n⚠️  Skipping daemon start — fix health check errors first');
    }

    console.log(`\n✅ Upgrade complete! v${beforeVersion} → v${getVersion()}`);
    process.exit(0);
  });

program
  .command('sync-logs')
  .description('Show GitHub sync activity logs')
  .option('-n, --lines <n>', 'Number of lines', '30')
  .option('-f, --follow', 'Follow sync output')
  .action(async (options) => {
    const fs = require('fs');
    const { spawn } = require('child_process');
    const logFile = `${getConfigDir()}/daemon.log`;

    if (!fs.existsSync(logFile)) {
      console.log('📭 No logs yet. Start the daemon first: ghclaw start');
      return;
    }

    if (options.follow) {
      // Follow mode: grep sync lines from tail -f
      const tail = spawn('bash', ['-c', `tail -f "${logFile}" | grep --line-buffered -E '(Sync|sync|🔄|📌|⚠️.*sync|git|push|pull)'`], {
        stdio: 'inherit',
      });
      process.on('SIGINT', () => tail.kill());
    } else {
      // Static: grep sync lines from last N lines
      const tail = spawn('bash', ['-c', `tail -${options.lines * 5} "${logFile}" | grep -E '(Sync|sync|🔄|📌|⚠️.*sync|git|push|pull)' | tail -${options.lines}`], {
        stdio: 'inherit',
      });
      await new Promise(resolve => tail.on('close', resolve));
    }
  });

program
  .command('chronicle-logs')
  .description('Show Chronicle sync activity (session → Telegram topic creation)')
  .option('-n, --lines <n>', 'Number of lines', '30')
  .option('-f, --follow', 'Follow output')
  .action(async (options) => {
    const fs = require('fs');
    const { spawn } = require('child_process');
    const logFile = `${getConfigDir()}/daemon.log`;

    if (!fs.existsSync(logFile)) {
      console.log('📭 No logs yet. Start the daemon first: ghclaw start');
      return;
    }

    const pattern = '(Chronicle|chronicle|\\[Sync\\]|Created topic|synced_chronicle|startChronicleSync)';

    if (options.follow) {
      const tail = spawn('bash', ['-c', `tail -f "${logFile}" | grep --line-buffered -E '${pattern}'`], {
        stdio: 'inherit',
      });
      process.on('SIGINT', () => tail.kill());
    } else {
      const tail = spawn('bash', ['-c', `tail -${options.lines * 5} "${logFile}" | grep -E '${pattern}' | tail -${options.lines}`], {
        stdio: 'inherit',
      });
      await new Promise(resolve => tail.on('close', resolve));
    }
  });

// ============================================================================
// Telegram Utilities
// ============================================================================

program
  .command('detect-group')
  .description('Listen for messages to detect and save group/chat IDs')
  .action(async () => {
    const inquirer = (await import('inquirer')).default;
    const { setSecret } = await import('../src/secrets/keychain');
    const config = await getConfigAsync();
    const client = new TelegramClient(config.telegram.botToken);

    console.log('👂 Listening for messages to detect group IDs...');
    console.log('   Send a message in your group to see its ID');
    console.log('   Press Ctrl+C to stop\n');

    while (true) {
      const updates = await client.getUpdates(30);
      for (const update of updates) {
        if (update.message) {
          const chat = update.message.chat;
          const user = update.message.from;
          const thread = update.message.message_thread_id;

          console.log('📍 Detected:');
          console.log(`   Chat ID: ${chat.id}`);
          console.log(`   Chat Type: ${chat.type}`);
          console.log(`   Chat Title: ${chat.title || 'N/A'}`);
          console.log(`   User ID: ${user?.id}`);
          console.log(`   Username: @${user?.username || 'N/A'}`);
          if (thread) {
            console.log(`   Topic/Thread ID: ${thread}`);
          }
          if (chat.is_forum) {
            console.log(`   📋 This is a forum group with topics enabled`);
          }
          console.log('');

          // Auto-save with confirmation
          if (chat.type === 'group' || chat.type === 'supergroup') {
            const { saveGroup } = await inquirer.prompt([{
              type: 'confirm',
              name: 'saveGroup',
              message: `Save this group (${chat.title || chat.id}) as allowed?`,
              default: true,
            }]);

            if (saveGroup) {
              await setSecret('telegram-allowed-group', chat.id.toString());
              console.log('✅ Group ID saved to keychain\n');

              if (user) {
                const { saveUser } = await inquirer.prompt([{
                  type: 'confirm',
                  name: 'saveUser',
                  message: `Also restrict to your user ID (${user.id})?`,
                  default: false,
                }]);

                if (saveUser) {
                  await setSecret('telegram-allowed-users', user.id.toString());
                  console.log('✅ User ID saved to keychain\n');
                }
              }

              console.log('🎉 Done! Run: ghclaw start\n');
              process.exit(0);
            }
          }
        }
      }
    }
  });

program
  .command('clean-topics')
  .description('Delete all bot-created topics from the Telegram group')
  .option('--scan', 'Scan for untracked topics (send a message in each topic first)')
  .option('--id <ids...>', 'Delete specific topic/thread IDs')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (options) => {
    const config = await getConfigAsync();
    const client = new TelegramClient(config.telegram.botToken);

    if (!config.telegram.allowedGroupId) {
      console.log('❌ No group configured. Run: ghclaw setup');
      return;
    }

    const chatId = config.telegram.allowedGroupId;
    const topicIds = new Set<number>();

    // 1. Get all topic IDs from DB
    const { initDatabase } = await import('../src/memory/session-mapper');
    const db = initDatabase();
    const rows = db.prepare(`
      SELECT DISTINCT topic_id FROM sessions WHERE topic_id IS NOT NULL AND topic_id > 0
      UNION
      SELECT DISTINCT thread_id FROM sessions WHERE thread_id > 0
    `).all() as { topic_id: number }[];
    for (const r of rows) topicIds.add(r.topic_id);

    // 2. Add manually specified IDs
    if (options.id) {
      for (const id of options.id) {
        const parsed = parseInt(id);
        if (!isNaN(parsed) && parsed > 0) {
          topicIds.add(parsed);
        } else {
          console.log(`⚠️ Skipping invalid topic ID: ${id}`);
        }
      }
    }

    // 3. Scan mode: poll for messages to discover untracked topics
    if (options.scan) {
      console.log('👂 Scanning for topics... Send a message in each topic you want deleted.');
      console.log('   Waiting 15 seconds...\n');
      await client.deleteWebhook();
      await client.flushUpdates();

      const scanEnd = Date.now() + 15000;
      while (Date.now() < scanEnd) {
        const updates = await client.getUpdates(3);
        for (const update of updates) {
          const threadId = update.message?.message_thread_id;
          if (threadId && update.message?.chat.id === chatId) {
            topicIds.add(threadId);
            console.log(`  📍 Found topic ${threadId}`);
          }
        }
      }
      console.log('');
    }

    if (topicIds.size === 0) {
      console.log('No topics found. Use --scan or --id <thread_id> to target specific topics.');
      return;
    }

    // Confirmation
    console.log(`Found ${topicIds.size} topic(s) to delete: ${[...topicIds].join(', ')}`);
    if (!options.yes) {
      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete ${topicIds.size} topic(s)? This is irreversible.`,
        default: false,
      }]);
      if (!confirm) {
        console.log('Cancelled.');
        return;
      }
    }

    console.log(`\nDeleting ${topicIds.size} topic(s)...\n`);

    const actuallyDeleted: number[] = [];
    let failed = 0;
    for (const topicId of topicIds) {
      try {
        const ok = await client.deleteForumTopic(chatId, topicId);
        if (ok) {
          console.log(`  ✅ Deleted topic ${topicId}`);
          actuallyDeleted.push(topicId);
        } else {
          console.log(`  ⚠️ Could not delete topic ${topicId}`);
          failed++;
        }
      } catch (err) {
        console.log(`  ❌ Error deleting topic ${topicId}: ${err}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Clean up DB entries only for topics we actually deleted, scoped to this group
    if (actuallyDeleted.length > 0) {
      const deletedStrs = actuallyDeleted.map(id => id.toString());
      const placeholders = deletedStrs.map(() => '?').join(',');
      db.prepare(`DELETE FROM sessions WHERE chat_id = ? AND (topic_id IN (${placeholders}) OR thread_id IN (${placeholders}))`).run(chatId, ...deletedStrs, ...deletedStrs);
    }
    console.log(`\n✅ Done: ${actuallyDeleted.length} deleted, ${failed} failed. DB cleaned.`);
  });

program
  .command('test')
  .description('Test Telegram and Copilot connections')
  .action(async () => {
    // Run doctor which does all the testing
    const report = await runDoctor(false);
    console.log(formatDoctorReport(report));
  });

program
  .command('security')
  .description('Show security setup instructions')
  .action(() => {
    console.log(getSecuritySetupInstructions());
  });

// ============================================================================
// Copilot Features
// ============================================================================

program
  .command('discover')
  .description('Discover available Copilot CLI features')
  .action(async () => {
    console.log('🔍 Discovering Copilot CLI features...\n');
    try {
      const discovery = await discoverCopilotFeatures();
      console.log(formatDiscovery(discovery));
    } catch (error) {
      console.error('Failed to discover features:', error);
    }
  });

// ============================================================================
// Memory Management
// ============================================================================

const memoryCmd = program.command('memory').description('Manage session mappings (memory handled by Copilot CLI Chronicle)');

memoryCmd
  .command('stats')
  .description('Show session statistics')
  .action(() => {
    try {
      const stats = getSessionStats();
      console.log('Session Statistics:\n');
      console.log(`  Total sessions: ${stats.totalSessions}`);
      console.log(`  Active sessions: ${stats.activeSessions}`);
      console.log(`  Total messages: ${stats.totalMessages}`);
      console.log(`  Mapping DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`);
      console.log('\n  Note: Full conversation history is managed by');
      console.log('  Copilot CLI Chronicle (~/.copilot/session-store.db)');
    } catch {
      console.log('No sessions yet');
    }
  });

memoryCmd
  .command('sessions')
  .description('List active chat sessions')
  .action(() => {
    try {
      const sessions = getActiveSessions();
      if (sessions.length === 0) {
        console.log('No active sessions');
        return;
      }
      console.log('Active Sessions:\n');
      for (const session of sessions) {
        console.log(`  📝 ${session.name}`);
        console.log(`     Copilot Session: ${session.id}`);
        console.log(`     Telegram: chat ${session.chat_id}${session.thread_id ? `, topic ${session.thread_id}` : ''}`);
        console.log(`     Messages: ${session.message_count}`);
        console.log(`     Status: ${session.status}`);
        console.log(`     Last Activity: ${session.last_activity}`);
        console.log(`     Resume: copilot --resume ${session.id}\n`);
      }
    } catch {
      console.log('No sessions yet');
    }
  });

memoryCmd
  .command('archive')
  .description('Archive inactive sessions')
  .option('-d, --days <days>', 'Archive sessions inactive for N days', '7')
  .action((options) => {
    const days = parseInt(options.days);
    const archived = archiveOldSessions(days);
    console.log(`Archived ${archived} sessions inactive for ${days}+ days`);
  });

// ============================================================================
// GitHub Integration
// ============================================================================

const githubCmd = program.command('github').description('GitHub integration management');

githubCmd
  .command('status')
  .description('Show GitHub sync status, reminders, and schedules')
  .action(async () => {
    try {
      const config = await getConfigAsync();

      if (!config.github.enabled) {
        console.log('❌ GitHub integration not enabled. Run: ghclaw setup');
        return;
      }

      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║                   GitHub Integration                         ║');
      console.log('╚══════════════════════════════════════════════════════════════╝\n');

      console.log(`Repo: ${config.github.username}/${config.github.repoName}`);
      console.log(`Local: ${config.github.repoPath}`);
      console.log(`Sync interval: ${config.github.syncIntervalMs / 1000}s`);
      console.log(`Sync enabled: ${config.github.syncEnabled}`);

      const sync = getSyncState();
      console.log(`\nSync State:`);
      console.log(`  Last sync: ${sync.lastSync ? sync.lastSync.toISOString() : 'Never'}`);
      console.log(`  Sync count: ${sync.syncCount}`);
      if (sync.lastError) {
        console.log(`  Last error: ${sync.lastError}`);
      }

      // List reminders and schedules
      const { listReminders } = await import('../src/schedules/reminders');
      const { listSchedules } = await import('../src/schedules/recurring');

      const reminders = listReminders(config.github.repoPath);
      const schedules = listSchedules(config.github.repoPath);

      console.log(`\nReminders: ${reminders.length}`);
      for (const r of reminders) {
        console.log(`  🔔 ${r.id}: ${r.message} (${r.cronExpression})`);
      }

      console.log(`\nSchedules: ${schedules.length}`);
      for (const s of schedules) {
        console.log(`  📅 ${s.id}: ${s.name} (${s.cronExpression})`);
      }

      console.log('');
    } catch (err) {
      console.error('Error:', err);
    }
  });

githubCmd
  .command('sync')
  .description('Force a sync now')
  .action(async () => {
    try {
      const config = await getConfigAsync();
      if (!config.github.enabled) {
        console.log('❌ GitHub integration not enabled. Run: ghclaw setup');
        return;
      }

      console.log('🔄 Forcing sync...');
      const { gitPull, gitCommitAndPush, hasChanges } = await import('../src/github/repo');
      const { exportSessionsToJson, exportMachineInfo } = await import('../src/github/sync');

      await gitPull(config.github.repoPath);

      const sessions = getActiveSessions(100);
      exportSessionsToJson(config.github.repoPath, sessions);

      const machineSessions = getSessionsByMachine(config.machine.id);
      exportMachineInfo(config.github.repoPath, config.machine.id, config.machine.name, machineSessions);

      if (await hasChanges(config.github.repoPath)) {
        const pushed = await gitCommitAndPush(config.github.repoPath, `manual sync: ${config.machine.name}`);
        console.log(pushed ? '✅ Synced and pushed' : '❌ Push failed');
      } else {
        console.log('✅ Already up to date');
      }
    } catch (err) {
      console.error('Error:', err);
    }
  });

githubCmd
  .command('open')
  .description('Open the sync repo in browser')
  .action(async () => {
    try {
      const config = await getConfigAsync();
      if (!config.github.enabled) {
        console.log('❌ GitHub integration not enabled. Run: ghclaw setup');
        return;
      }

      const { spawn } = require('child_process');
      spawn('gh', ['repo', 'view', '--web', `${config.github.username}/${config.github.repoName}`], {
        stdio: 'inherit',
      });
    } catch (err) {
      console.error('Error:', err);
    }
  });

// ============================================================================
// Run
// ============================================================================

program.parse();
