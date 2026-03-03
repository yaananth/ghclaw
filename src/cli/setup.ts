/**
 * Interactive Setup Wizard
 * Guides user through secure bot configuration using OS keychain
 * Resumes from existing config - only asks for missing pieces
 */

import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import {
  setSecret,
  getSecret,
  isKeychainAvailable,
  isNativeKeychainAvailable,
  isCodespace,
  isGhAuthenticated,
  getStorageBackend,
  getPlatform,
} from '../secrets/keychain';
import { getConfigDir, getConfigAsync, saveLocalConfig } from '../config';
import { TelegramClient } from '../telegram/client';
import { isChronicleAvailable, getRecentSessions } from '../copilot/chronicle';
import { checkGhAuth, getGhUsername, getGhToken, getGhScopes } from '../github/auth';
import { checkRepoExists, createRepo, cloneRepo, initRepoStructure, setRepoSecrets } from '../github/repo';
import { detectConfiguredChannels } from '../channels/registry';
import { getVersion } from '../version';

export async function runSetup(): Promise<void> {
  const version = getVersion();
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  GHClaw Setup v${version.padEnd(40 - 18, ' ')}║
║         Local Telegram Bot powered by Copilot CLI            ║
╚══════════════════════════════════════════════════════════════╝
`);

  const platform = getPlatform();
  const nativeKeychain = await isNativeKeychainAvailable();
  const storageBackend = await getStorageBackend();

  console.log(`Platform: ${platform}`);
  console.log(`Secrets: ${storageBackend}${!nativeKeychain ? ' (no OS keychain)' : ''}\n`);

  if (!nativeKeychain && isCodespace()) {
    // Ensure gh is authenticated for Codespace secret storage
    const ghAuthed = await isGhAuthenticated();
    if (!ghAuthed) {
      console.log('  GitHub CLI not authenticated. Logging in...\n');
      const loginProc = Bun.spawn(['gh', 'auth', 'login'], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      });
      await loginProc.exited;
      if (!(await isGhAuthenticated())) {
        console.log('  ❌ gh auth failed. Secrets will only persist for this session.\n');
      }
    }
    console.log('  Running in Codespace — secrets auto-saved as Codespace Secrets');
    console.log('  (encrypted at rest, persists across rebuilds)\n');
  } else if (!nativeKeychain) {
    console.log('  No OS keychain available. Secrets stored in env vars for this session.');
    console.log('  For persistence, export env vars in your shell profile.\n');
  }

  // Channel detection: detect which channels are already configured
  const configuredChannels = await detectConfiguredChannels();
  let selectedChannel = 'telegram'; // default

  if (configuredChannels.length === 0) {
    console.log('─────────────────────────────────────────────────────────────');
    console.log('Channel Selection\n');
    console.log('  No channels configured yet. Currently supported:');
    console.log('  - Telegram (via Bot API)\n');
    // Only Telegram for now — auto-select
    selectedChannel = 'telegram';
    console.log(`  Auto-selected: Telegram\n`);
  } else if (configuredChannels.length === 1) {
    selectedChannel = configuredChannels[0].type;
    console.log(`Channel: ${selectedChannel} (only configured channel)\n`);
  } else {
    // Multiple channels configured — ask user
    const { channelChoice } = await inquirer.prompt([{
      type: 'list',
      name: 'channelChoice',
      message: 'Multiple channels configured. Which to set up?',
      choices: configuredChannels.map(c => ({ name: c.type, value: c.type })),
    }]);
    selectedChannel = channelChoice;
  }

  // Load existing config
  let token = await getSecret('telegram-bot-token') || '';
  let groupId = await getSecret('telegram-allowed-group') || '';
  let userIds = await getSecret('telegram-allowed-users') || '';
  let botUsername = '';

  // Step 1: Bot Token
  if (token) {
    console.log('🔍 Validating existing token...');
    const valid = await validateToken(token);
    if (valid) {
      botUsername = valid;
      console.log(`✅ Bot: @${botUsername}\n`);
    } else {
      console.log('⚠️  Token invalid, need new one\n');
      token = '';
    }
  }

  if (!token) {
    console.log('─────────────────────────────────────────────────────────────');
    console.log('Bot Token\n');
    console.log('  1. Message @BotFather on Telegram');
    console.log('  2. Send /newbot and follow prompts');
    console.log('  3. Copy the token\n');

    const { newToken } = await inquirer.prompt([{
      type: 'password',
      name: 'newToken',
      message: '🔒 Bot token:',
      mask: '*',
      validate: (input: string) => input.length >= 10 || 'Invalid token',
    }]);

    const valid = await validateToken(newToken);
    if (!valid) {
      console.log('❌ Invalid token');
      return;
    }

    token = newToken;
    botUsername = valid;
    console.log(`✅ Connected as @${botUsername}\n`);

    await setSecret('telegram-bot-token', token);
    console.log(`✅ Token saved${nativeKeychain ? ' to keychain' : isCodespace() ? ' as Codespace Secret' : ''}\n`);
  }

  // Step 2: Group ID
  if (!groupId) {
    console.log('─────────────────────────────────────────────────────────────');
    console.log('Group Restriction\n');

    const { setupGroup } = await inquirer.prompt([{
      type: 'confirm',
      name: 'setupGroup',
      message: 'Auto-detect your group? (or enter ID manually)',
      default: true,
    }]);

    if (setupGroup) {
      // Loop until we get a group — it's required
      while (!groupId) {
        console.log(`\n👂 Detecting your group...`);
        console.log(`   1. Add @${botUsername} to your group and make it admin`);
        console.log(`      (Admin is required — ghclaw needs it for topics and message access)`);
        console.log(`   2. Send any message in the group (e.g. "hello")\n`);

        const detected = await detectGroup(token);

        if (detected) {
          console.log(`\n   Detected group: ${detected.chatTitle || detected.chatId}`);
          console.log(`   Chat ID: ${detected.chatId}`);
          if (detected.userId) {
            console.log(`   Detected user: ${detected.userId}`);
          }

          const { confirmGroup } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmGroup',
            message: `Use this group (${detected.chatTitle || detected.chatId})?`,
            default: true,
          }]);

          if (confirmGroup) {
            groupId = detected.chatId.toString();
            await setSecret('telegram-allowed-group', groupId);
            console.log('✅ Group ID saved');
          }
        } else {
          // Auto-detect failed — offer manual entry or retry
          console.log('⚠️  No group detected.\n');

          const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: 'Group is required. What would you like to do?',
            choices: [
              { name: 'Retry detection (make sure bot is admin + send a message)', value: 'retry' },
              { name: 'Enter group ID manually', value: 'manual' },
            ],
          }]);

          if (action === 'manual') {
            const { manualGroupId } = await inquirer.prompt([{
              type: 'input',
              name: 'manualGroupId',
              message: 'Enter group chat ID (negative number, e.g. -1001234567890):',
              validate: (input: string) => {
                const trimmed = input.trim();
                if (!trimmed) return 'Group ID is required';
                if (!/^-?\d+$/.test(trimmed)) return 'Group ID must be a number (usually negative for groups)';
                return true;
              },
            }]);

            groupId = manualGroupId.trim();
            await setSecret('telegram-allowed-group', groupId);
            console.log(`✅ Group ID ${groupId} saved`);
          }
          // else: loops back to retry
        }
      }
    } else {
      // User said no to group restriction — but it's required
      console.log('\n⚠️  Group restriction is required for security.');
      console.log('   Without it, anyone can message your bot.\n');

      const { manualGroupId } = await inquirer.prompt([{
        type: 'input',
        name: 'manualGroupId',
        message: 'Enter group chat ID (or run ghclaw detect-group to find it):',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (!trimmed) return 'Group ID is required';
          if (!/^-?\d+$/.test(trimmed)) return 'Group ID must be a number (usually negative for groups)';
          return true;
        },
      }]);

      groupId = manualGroupId.trim();
      await setSecret('telegram-allowed-group', groupId);
      console.log(`✅ Group ID ${groupId} saved`);
    }
  } else {
    console.log(`✅ Group: ${groupId}`);
  }

  // Step 3: Verify supergroup with topics enabled
  if (groupId) {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('Group Verification\n');

    const baseUrl = `https://api.telegram.org/bot${token}`;
    let verified = false;

    while (!verified) {
      console.log(`   🔍 Checking group ${groupId}...`);
      try {
        const response = await fetch(`${baseUrl}/getChat?chat_id=${groupId}`);
        const data = await response.json() as { ok: boolean; result: any };

        if (!data.ok) {
          console.log(`   ❌ Could not fetch group info. Is the bot a member?\n`);
        } else {
          const chat = data.result;
          const isSupergroup = chat.type === 'supergroup';
          const isForum = chat.is_forum === true;

          console.log(`   Type: ${chat.type}${isSupergroup ? ' ✅' : ' ❌ (needs supergroup)'}`);
          console.log(`   Topics: ${isForum ? 'enabled ✅' : 'disabled ❌'}`);

          if (isSupergroup && isForum) {
            console.log(`   ✅ Group "${chat.title}" is ready\n`);
            verified = true;
            continue;
          }

          console.log('');
          if (!isSupergroup) {
            console.log('   To convert to Supergroup:');
            console.log('     Telegram → Group → Edit → Scroll down → Change to Supergroup');
          }
          if (!isForum) {
            console.log('   To enable Topics:');
            console.log('     Telegram → Group → Edit → Topics → Enable');
          }
          console.log('');
        }
      } catch (err) {
        console.log(`   ❌ Error checking group: ${err}\n`);
      }

      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'Supergroup with Topics is required. What would you like to do?',
        choices: [
          { name: 'Re-check (after making changes in Telegram)', value: 'recheck' },
          { name: 'Enter a different group ID', value: 'change' },
        ],
      }]);

      if (action === 'change') {
        const { newGroupId } = await inquirer.prompt([{
          type: 'input',
          name: 'newGroupId',
          message: 'Enter group chat ID (negative number, e.g. -1001234567890):',
          validate: (input: string) => {
            const trimmed = input.trim();
            if (!trimmed) return 'Group ID is required';
            if (!/^-?\d+$/.test(trimmed)) return 'Group ID must be a number';
            return true;
          },
        }]);
        groupId = newGroupId.trim();
        await setSecret('telegram-allowed-group', groupId);
        console.log(`   Updated group ID to ${groupId}\n`);
      }
    }
  }

  // Step 4: User restriction (optional)
  if (!userIds && groupId) {
    const { restrictUsers } = await inquirer.prompt([{
      type: 'confirm',
      name: 'restrictUsers',
      message: 'Also restrict to specific users? (recommended)',
      default: true,
    }]);

    if (restrictUsers) {
      console.log(`\n👂 Detecting your user ID...`);
      console.log(`   Send any message in your group (bot must be admin)\n`);

      const client = new TelegramClient(token);
      const targetGroupId = groupId ? parseInt(groupId) : undefined;
      const detected = await detectUser(client, targetGroupId);

      if (detected) {
        userIds = detected.userId.toString();
        await setSecret('telegram-allowed-users', userIds);
        console.log(`✅ User ID ${userIds} saved (only you can use the bot)`);
        console.log(`\n   💡 To add more users later:`);
        console.log(`      ghclaw secrets set telegram-allowed-users "${userIds},OTHER_ID"`);
        console.log(`      (Get IDs via ghclaw detect-group)\n`);
      } else {
        // Fallback to manual entry
        console.log('⚠️  Auto-detection timed out.\n');
        console.log('   💡 To find your user ID:');
        console.log('      1. Message @userinfobot on Telegram');
        console.log('      2. It will reply with your user ID\n');

        const { manualId } = await inquirer.prompt([{
          type: 'input',
          name: 'manualId',
          message: 'Enter your user ID (or press Enter to skip):',
          validate: (input: string) => {
            if (!input.trim()) return true; // Allow empty to skip
            if (!/^\d+$/.test(input.trim())) return 'User ID must be a number (get it from @userinfobot)';
            return true;
          },
        }]);

        if (manualId && manualId.trim()) {
          userIds = manualId.trim();
          await setSecret('telegram-allowed-users', userIds);
          console.log(`✅ User ID ${userIds} saved\n`);
        } else {
          console.log('⚠️  Skipped. Bot will allow any user in the group.\n');
        }
      }
    }
  } else if (userIds) {
    console.log(`✅ Users: ${userIds}`);
  }

  // Step 4: Final settings
  console.log('\n─────────────────────────────────────────────────────────────');

  console.log('Tool Access Mode\n');
  console.log('  Default (No):  Copilot CLI uses safe defaults — read-only tools,');
  console.log('                 prompts before file edits or shell commands');
  console.log('  YOLO (Yes):    All tools auto-approved — file edits, shell, web search,');
  console.log('                 no confirmation prompts (--allow-all-tools)\n');

  const { yoloMode } = await inquirer.prompt([{
    type: 'confirm',
    name: 'yoloMode',
    message: '🔥 Enable YOLO mode? (default: No)',
    default: false,
  }]);

  // Step 5: GitHub Integration (auto-configured)
  // Check if already configured
  let githubConfig = {
    enabled: false,
    username: '',
    repoName: '.ghclaw',
    repoPath: '',
    syncIntervalMs: 5000,
    syncEnabled: true,
  };

  // Try to load existing GitHub config
  try {
    const existingConfig = await getConfigAsync();
    if (existingConfig.github.enabled && existingConfig.github.username && existingConfig.github.repoPath) {
      // Verify the repo is still cloned locally
      const repoGitDir = path.join(existingConfig.github.repoPath, '.git');
      if (fs.existsSync(repoGitDir)) {
        githubConfig = {
          enabled: true,
          username: existingConfig.github.username,
          repoName: existingConfig.github.repoName,
          repoPath: existingConfig.github.repoPath,
          syncIntervalMs: existingConfig.github.syncIntervalMs,
          syncEnabled: existingConfig.github.syncEnabled,
        };
        console.log('\n─────────────────────────────────────────────────────────────');
        console.log(`GitHub: ${githubConfig.username}/${githubConfig.repoName} (already configured)\n`);

        // Verify auth is still valid
        console.log('🔍 Verifying GitHub auth...');
        const auth = await checkGhAuth();
        if (!auth.authenticated) {
          console.log('❌ GitHub CLI not authenticated. Running: gh auth login');
          const loginProc = Bun.spawn(['gh', 'auth', 'login', '-s', 'repo,workflow'], {
            stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
          });
          await loginProc.exited;
        } else if (auth.missingScopes.length > 0) {
          console.log(`⚠️  Missing scopes: ${auth.missingScopes.join(', ')}`);
          const refreshProc = Bun.spawn(['gh', 'auth', 'refresh', '-s', 'repo,workflow'], {
            stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
          });
          await refreshProc.exited;
        } else {
          console.log(`✅ Auth: ${auth.username} (scopes: ${auth.scopes.join(', ')})`);
        }

        // Verify push access
        console.log('🔍 Verifying push access...');
        const pushProc = Bun.spawn(['git', 'push', '--dry-run'], {
          cwd: existingConfig.github.repoPath,
          stdout: 'pipe', stderr: 'pipe',
        });
        const pushExit = await pushProc.exited;
        if (pushExit === 0) {
          console.log('✅ Push access verified');
        } else {
          const pushErr = await new Response(pushProc.stderr).text();
          console.log(`❌ Push failed: ${pushErr.trim()}`);
          console.log('   Fix: gh auth refresh -s repo,workflow');
        }
      }
    }
  } catch {
    // No existing config, proceed with setup
  }

  if (!githubConfig.enabled) {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('GitHub Integration\n');
    console.log('  ghclaw uses GitHub as its backbone for:');
    console.log('  - Cross-machine memory sync');
    console.log('  - Reminders & schedules (via GitHub Actions)');
    console.log('  - Agent delegation (Copilot Coding Agent)');
    console.log('  - Session persistence\n');

  // Auto-detect gh CLI auth
  console.log('🔍 Checking GitHub CLI auth...');
  const auth = await checkGhAuth();

  if (!auth.authenticated) {
    console.log('⚠️  GitHub CLI not authenticated.');
    console.log('   Running: gh auth login\n');
    // Auto-launch gh auth login
    const loginProc = Bun.spawn(['gh', 'auth', 'login', '-s', 'repo,workflow'], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await loginProc.exited;
    // Re-check
    const recheck = await checkGhAuth();
    if (!recheck.authenticated) {
      console.log('❌ GitHub auth failed. GitHub features will be disabled.');
      console.log('   Run later: gh auth login -s repo,workflow\n');
    } else {
      Object.assign(auth, recheck);
    }
  }

  if (auth.authenticated && auth.missingScopes.length > 0) {
    console.log(`⚠️  Missing scopes: ${auth.missingScopes.join(', ')}`);
    console.log('   Refreshing auth scopes...\n');
    const refreshProc = Bun.spawn(['gh', 'auth', 'refresh', '-s', 'repo,workflow'], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await refreshProc.exited;
    // Re-check scopes
    const recheck = await checkGhAuth();
    Object.assign(auth, recheck);
  }

  if (auth.authenticated && auth.missingScopes.length === 0) {
    const username = auth.username || await getGhUsername() || '';
    console.log(`✅ Authenticated as ${username} (scopes: ${auth.scopes.join(', ')})`);

    const configDir = getConfigDir();

    // Auto-detect existing .ghclaw repo before asking
    let targetOrg = username;
    let targetRepo = '.ghclaw';

    console.log(`\n🔍 Checking for ${targetOrg}/${targetRepo}...`);
    let exists = await checkRepoExists(targetOrg, targetRepo);

    if (exists) {
      console.log(`   ✅ Found existing repo: ${targetOrg}/${targetRepo}`);
    } else {
      // Not found — ask user for org/repo
      console.log(`   Not found. Configure manually:\n`);

      const { repoOrg } = await inquirer.prompt([{
        type: 'input',
        name: 'repoOrg',
        message: 'GitHub org/user for sync repo:',
        default: username,
        validate: (input: string) => input.trim().length > 0 || 'Required',
      }]);

      const { repoName } = await inquirer.prompt([{
        type: 'input',
        name: 'repoName',
        message: 'Repository name:',
        default: '.ghclaw',
        validate: (input: string) => input.trim().length > 0 || 'Required',
      }]);

      targetOrg = repoOrg.trim();
      targetRepo = repoName.trim();

      // Re-check with user-provided values
      if (targetOrg !== username || targetRepo !== '.ghclaw') {
        exists = await checkRepoExists(targetOrg, targetRepo);
      }

      if (!exists) {
        console.log(`   Creating private repo ${targetOrg}/${targetRepo}...`);
        const created = await createRepo(targetOrg, targetRepo);
        if (created) {
          console.log('   ✅ Repo created');
          exists = true;
        } else {
          console.log('   ❌ Failed to create repo. GitHub features will be disabled.\n');
        }
      } else {
        console.log(`   ✅ Repo exists`);
      }
    }

    const repoPath = path.join(configDir, 'repo');

    if (exists) {
      console.log(`   Cloning to ${repoPath}...`);
      try {
        await cloneRepo(targetOrg, repoPath, targetRepo);
        console.log('   ✅ Cloned');

        // Init structure
        console.log('   Initializing repo structure...');
        await initRepoStructure(repoPath);
        console.log('   ✅ Structure initialized');

        // Try to initialize gh-aw (best-effort — skip if not installed)
        try {
          const ghAwCheck = Bun.spawn(['gh', 'aw', '--help'], { stdout: 'pipe', stderr: 'pipe' });
          if ((await ghAwCheck.exited) === 0) {
            console.log('   Initializing gh-aw (agentic workflows)...');
            const ghAwInit = Bun.spawn(['gh', 'aw', 'init'], { cwd: repoPath, stdout: 'pipe', stderr: 'pipe' });
            if ((await ghAwInit.exited) === 0) {
              console.log('   ✅ gh-aw initialized');
            } else {
              console.log('   ⚠️ gh-aw init failed (non-critical)');
            }
          }
        } catch {
          // gh-aw not installed — skip silently
        }

        // Set secrets automatically
        console.log('   Setting repo secrets...');
        const ghToken = await getGhToken();
        const ghScopes = await getGhScopes();
        const secrets: Record<string, string> = {
          TELEGRAM_BOT_TOKEN: token,
        };
        if (groupId) secrets.TELEGRAM_CHAT_ID = groupId;
        if (ghToken && ghScopes.includes('workflow')) {
          secrets.GH_PAT = ghToken;
        } else if (ghToken) {
          console.log('   ⚠️  gh auth token missing "workflow" scope — skipping GH_PAT');
          console.log('      Reminders will not self-delete. Fix: gh auth refresh -s repo,workflow');
        }

        const secretResult = await setRepoSecrets(targetOrg, targetRepo, secrets);
        if (secretResult.set.length > 0) {
          console.log(`   ✅ Secrets set: ${secretResult.set.join(', ')}`);
        }
        if (secretResult.failed.length > 0) {
          console.log(`   ⚠️  Failed to set: ${secretResult.failed.join(', ')}`);
        }

        // Verify push access
        console.log('   Verifying push access...');
        const pushProc = Bun.spawn(['git', 'push', '--dry-run'], {
          cwd: repoPath,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const pushExit = await pushProc.exited;
        if (pushExit === 0) {
          console.log('   ✅ Push access verified');
        } else {
          const pushErr = await new Response(pushProc.stderr).text();
          console.log(`   ⚠️  Push access failed: ${pushErr.trim()}`);
          console.log('   Fix: gh auth refresh -s repo,workflow');
        }

        githubConfig = {
          enabled: true,
          username: targetOrg,
          repoName: targetRepo,
          repoPath,
          syncIntervalMs: 5000,
          syncEnabled: true,
        };

        console.log('\n   ✅ GitHub backbone configured!');
      } catch (err) {
        console.log(`   ❌ Clone failed: ${err}`);
      }
    }
  }
  } // end if (!githubConfig.enabled)

  // Save config
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(configDir, 'data'), { recursive: true, mode: 0o700 });

  saveLocalConfig({
    telegram: {
      blockPrivateMessages: true,
      pollIntervalMs: 1000,
      pollTimeoutSeconds: 30,
    },
    copilot: { yoloMode },
    memory: { dbPath: path.join(configDir, 'data', 'memory.sqlite') },
    github: githubConfig,
    channels: {
      active: selectedChannel,
      configured: [selectedChannel],
    },
  });

  // Summary
  // Load config to get machine info (auto-generates if first run)
  const config = await getConfigAsync();

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      ✅ Setup Complete!                      ║
╚══════════════════════════════════════════════════════════════╝

  Bot:     @${botUsername}
  Group:   ${groupId}
  Users:   ${userIds || 'Any'}
  YOLO:    ${yoloMode ? 'Enabled 🔥' : 'Disabled'}
  Machine: ${config.machine.name} (${config.machine.id.slice(0, 8)})
  GitHub:  ${githubConfig.enabled ? `✅ ${githubConfig.username}/${githubConfig.repoName}` : 'Disabled'}
`);

  // Show recent Copilot CLI sessions
  if (isChronicleAvailable()) {
    const recentSessions = getRecentSessions(5);
    if (recentSessions.length > 0) {
      console.log('📚 Recent Copilot CLI sessions on this machine:\n');
      for (let i = 0; i < recentSessions.length; i++) {
        const s = recentSessions[i];
        const name = s.summary?.slice(0, 50) || 'Unnamed';
        const dir = s.cwd ? require('path').basename(s.cwd) : '';
        const timeAgo = formatTimeAgo(s.updated_at);
        console.log(`  ${i + 1}. ${name}${dir ? ` (${dir})` : ''} - ${timeAgo}`);
      }
      console.log('');
    }
  }

  // Start / Restart daemon
  const lockFile = path.join(getConfigDir(), 'daemon.lock');
  const daemonRunning = fs.existsSync(lockFile);
  let existingPid: number | null = null;

  if (daemonRunning) {
    const pidStr = fs.readFileSync(lockFile, 'utf-8').trim();
    existingPid = parseInt(pidStr);
    // Verify the process is actually running
    if (existingPid && !isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0); // signal 0 = just check if alive
      } catch {
        existingPid = null; // stale lock file
        fs.unlinkSync(lockFile);
      }
    }
  }

  if (existingPid) {
    const { restartNow } = await inquirer.prompt([{
      type: 'confirm',
      name: 'restartNow',
      message: `🔄 Daemon is running (PID ${existingPid}). Restart with new config?`,
      default: true,
    }]);

    if (restartNow) {
      // Stop existing daemon
      console.log(`\n🛑 Stopping daemon (PID ${existingPid})...`);
      try {
        process.kill(existingPid, 'SIGTERM');
        // Wait for it to exit
        let attempts = 0;
        while (attempts < 10) {
          await new Promise(r => setTimeout(r, 500));
          try {
            process.kill(existingPid, 0);
            attempts++;
          } catch {
            break; // Process gone
          }
        }
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        console.log('   ✅ Stopped');
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
          console.log('   ✅ Already stopped');
        } else {
          console.log(`   ⚠️  Could not stop: ${err}`);
        }
      }

      // Start new daemon
      const { spawn } = await import('child_process');
      const logFile = path.join(configDir, 'daemon.log');
      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');

      const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground'], {
        detached: true,
        stdio: ['ignore', out, err],
      });

      child.unref();
      console.log(`\n🚀 Daemon restarted (PID ${child.pid})`);
      console.log(`   Logs: ghclaw logs -f`);
      console.log(`   Stop: ghclaw stop\n`);
      process.exit(0);
    } else {
      console.log('\n⚠️  Daemon still running with old config. Restart later: ghclaw stop && ghclaw start\n');
    }
  } else {
    const { startNow } = await inquirer.prompt([{
      type: 'confirm',
      name: 'startNow',
      message: '🚀 Start the bot now?',
      default: true,
    }]);

    if (startNow) {
      const { spawn } = await import('child_process');
      const logFile = path.join(configDir, 'daemon.log');
      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');

      const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground'], {
        detached: true,
        stdio: ['ignore', out, err],
      });

      child.unref();
      console.log(`\n🚀 Daemon started (PID ${child.pid})`);
      console.log(`   Logs: ghclaw logs -f`);
      console.log(`   Stop: ghclaw stop\n`);
      process.exit(0);
    } else {
      console.log('\nRun later: ghclaw start\n');
    }
  }
}

async function validateToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string } };
    return data.ok ? (data.result?.username || 'unknown') : null;
  } catch {
    return null;
  }
}

async function detectGroup(token: string): Promise<{
  chatId: number;
  chatTitle?: string;
  userId?: number;
} | null> {
  const baseUrl = `https://api.telegram.org/bot${token}`;

  // Delete webhook AND drop pending updates for a clean slate
  await fetch(`${baseUrl}/deleteWebhook?drop_pending_updates=true`);

  const deadline = Date.now() + 60000; // 60 seconds
  let pollCount = 0;
  let offset = 0;

  while (Date.now() < deadline) {
    try {
      pollCount++;
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      process.stdout.write(`\r   ⏳ Listening... ${remaining}s remaining (poll #${pollCount})  `);

      // Poll with message + my_chat_member (fires when bot is added/promoted)
      const params = new URLSearchParams({
        timeout: '5',
        offset: offset.toString(),
        allowed_updates: JSON.stringify(['message', 'my_chat_member']),
      });

      const response = await fetch(`${baseUrl}/getUpdates?${params}`);
      const data = await response.json() as { ok: boolean; result: any[] };

      if (!data.ok || !data.result) continue;

      // Update offset
      if (data.result.length > 0) {
        offset = Math.max(...data.result.map((u: any) => u.update_id)) + 1;
        process.stdout.write(`\n   📥 Got ${data.result.length} update(s)\n`);
      }

      for (const update of data.result) {
        // Check regular messages (works for /commands, or all messages if admin)
        if (update.message) {
          const { chat, from } = update.message;
          if (chat.type === 'group' || chat.type === 'supergroup') {
            process.stdout.write(`\n`);
            console.log(`   📩 Message in ${chat.type}: ${chat.title || chat.id}`);
            return { chatId: chat.id, chatTitle: chat.title, userId: from?.id };
          }
        }

        // Check my_chat_member — fires when bot is added or promoted
        if (update.my_chat_member) {
          const { chat, from } = update.my_chat_member;
          if (chat.type === 'group' || chat.type === 'supergroup') {
            process.stdout.write(`\n`);
            console.log(`   📩 Bot added/updated in ${chat.type}: ${chat.title || chat.id}`);
            return { chatId: chat.id, chatTitle: chat.title, userId: from?.id };
          }
        }
      }
    } catch (err) {
      process.stdout.write(`\n   ⚠️ Poll error: ${err}\n`);
    }
  }

  process.stdout.write(`\n`);
  console.log(`   (Polled ${pollCount} times, no group activity detected)`);
  return null;
}

async function detectUser(client: TelegramClient, scopeToGroupId?: number): Promise<{
  userId: number;
  username?: string;
} | null> {
  // Delete any existing webhook (required for polling to work)
  await client.deleteWebhook();
  // Flush any old pending updates
  await client.flushUpdates();

  const timeout = Date.now() + 30000; // 30 seconds
  let pollCount = 0;

  while (Date.now() < timeout) {
    try {
      pollCount++;
      const updates = await client.getUpdates(5);

      if (updates.length > 0) {
        console.log(`   📥 Got ${updates.length} update(s)`);
      }

      for (const update of updates) {
        if (update.message?.from) {
          // If scoped to a group, only accept messages from that group
          if (scopeToGroupId && update.message.chat.id !== scopeToGroupId) {
            continue;
          }
          const { from } = update.message;
          console.log(`   👤 Detected user: @${from.username || from.id}`);
          return { userId: from.id, username: from.username };
        }
      }
    } catch (err) {
      console.log(`   ⚠️ Poll error: ${err}`);
    }
  }

  console.log(`   (Polled ${pollCount} times, no message found)`);
  return null;
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

if (import.meta.main) {
  runSetup().catch(console.error);
}
