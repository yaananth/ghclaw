/**
 * Secrets Management
 * Uses OS keychain for secure credential storage
 *
 * Security: Uses secure input methods, avoids shell history exposure
 */

import * as readline from 'readline';

const SERVICE_NAME = 'ghclaw';
const KEYCHAIN_TIMEOUT_MS = 60000; // 60 second timeout for keychain operations (dialog may appear)

/**
 * Helper to run a process with timeout
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMsg)), ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

export interface SecretKey {
  name: string;
  description: string;
  required: boolean;
}

export const SECRETS: SecretKey[] = [
  { name: 'telegram-bot-token', description: 'Telegram Bot Token', required: true },
  { name: 'telegram-allowed-group', description: 'Allowed Group ID', required: false },
  { name: 'telegram-allowed-users', description: 'Allowed User IDs', required: false },
  { name: 'telegram-secret-prefix', description: 'Secret Prefix', required: false },
];

/**
 * Detect the current platform
 */
export function getPlatform(): 'macos' | 'linux' | 'windows' | 'unknown' {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

/**
 * Validate key names to prevent injection.
 * Only allows alphanumeric, hyphens, and underscores.
 */
function validateKeyName(key: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(`Invalid key name: ${key}`);
  }
}

/**
 * Store a secret in the OS keychain
 * Security: Uses direct args (no shell) and stdin where possible to avoid ps exposure
 */
export async function setSecret(key: string, value: string): Promise<boolean> {
  validateKeyName(key);
  const platform = getPlatform();

  try {
    switch (platform) {
      case 'macos':
        // Delete existing (ignore errors)
        const delProc = Bun.spawn(
          ['security', 'delete-generic-password', '-s', SERVICE_NAME, '-a', key],
          { stdout: 'ignore', stderr: 'ignore' }
        );
        await withTimeout(delProc.exited, 5000, 'Delete timed out');

        // Pass password as -w argument directly
        // Note: -w without a value triggers interactive prompt which breaks stdin piping
        const addProc = Bun.spawn(
          ['security', 'add-generic-password', '-s', SERVICE_NAME, '-a', key, '-w', value],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
        );

        const addExit = await withTimeout(
          addProc.exited,
          KEYCHAIN_TIMEOUT_MS,
          'Keychain operation timed out'
        );
        return addExit === 0;

      case 'linux':
        // Use secret-tool with stdin
        const linuxProc = Bun.spawn(
          ['secret-tool', 'store', '--label', `${SERVICE_NAME}: ${key}`, 'service', SERVICE_NAME, 'account', key],
          { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' }
        );
        linuxProc.stdin.write(value);
        linuxProc.stdin.end();
        const linuxExit = await linuxProc.exited;
        return linuxExit === 0;

      case 'windows': {
        // Use PowerShell to read secret from stdin, avoiding process arg exposure
        const winProc = Bun.spawn(
          ['powershell', '-NoProfile', '-Command',
           `$p = [Console]::In.ReadLine(); & cmdkey /generic:"${SERVICE_NAME}:${key}" /user:"${key}" /pass:"$p" | Out-Null`],
          { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' }
        );
        winProc.stdin.write(value + '\n');
        winProc.stdin.end();
        const winExit = await winProc.exited;
        return winExit === 0;
      }

      default:
        console.warn('⚠️ Keychain not supported on this platform.');
        return false;
    }
  } catch (error) {
    console.error(`Failed to store secret ${key}:`, error);
    return false;
  }
}

/**
 * Retrieve a secret from the OS keychain
 */
export async function getSecret(key: string): Promise<string | null> {
  validateKeyName(key);
  const platform = getPlatform();

  try {
    switch (platform) {
      case 'macos':
        const macProc = Bun.spawn(
          ['security', 'find-generic-password', '-s', SERVICE_NAME, '-a', key, '-w'],
          { stdout: 'pipe', stderr: 'ignore' }
        );
        const macExit = await macProc.exited;
        if (macExit !== 0) return null;
        return (await new Response(macProc.stdout).text()).trim() || null;

      case 'linux':
        const linuxProc = Bun.spawn(
          ['secret-tool', 'lookup', 'service', SERVICE_NAME, 'account', key],
          { stdout: 'pipe', stderr: 'ignore' }
        );
        const linuxExit = await linuxProc.exited;
        if (linuxExit !== 0) return null;
        return (await new Response(linuxProc.stdout).text()).trim() || null;

      case 'windows':
        // Windows credential retrieval is complex, simplified version
        const winProc = Bun.spawn(
          ['powershell', '-Command', `(cmdkey /list:${SERVICE_NAME}:${key} | Select-String 'User:').ToString().Split(':')[1].Trim()`],
          { stdout: 'pipe', stderr: 'ignore' }
        );
        const winExit = await winProc.exited;
        if (winExit !== 0) return null;
        return (await new Response(winProc.stdout).text()).trim() || null;

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Delete a secret from the OS keychain
 */
export async function deleteSecret(key: string): Promise<boolean> {
  validateKeyName(key);
  const platform = getPlatform();

  try {
    switch (platform) {
      case 'macos':
        const macProc = Bun.spawn(
          ['security', 'delete-generic-password', '-s', SERVICE_NAME, '-a', key],
          { stdout: 'ignore', stderr: 'ignore' }
        );
        return (await macProc.exited) === 0;

      case 'linux':
        const linuxProc = Bun.spawn(
          ['secret-tool', 'clear', 'service', SERVICE_NAME, 'account', key],
          { stdout: 'ignore', stderr: 'ignore' }
        );
        return (await linuxProc.exited) === 0;

      case 'windows':
        const winProc = Bun.spawn(
          ['cmdkey', `/delete:${SERVICE_NAME}:${key}`],
          { stdout: 'ignore', stderr: 'ignore' }
        );
        return (await winProc.exited) === 0;

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * List all stored secrets (keys only, not values)
 */
export async function listSecrets(): Promise<string[]> {
  const platform = getPlatform();
  const keys: string[] = [];

  try {
    switch (platform) {
      case 'macos':
        // Use security find-generic-password for each known key
        for (const secret of SECRETS) {
          const val = await getSecret(secret.name);
          if (val) keys.push(secret.name);
        }
        break;

      case 'linux':
        for (const secret of SECRETS) {
          const val = await getSecret(secret.name);
          if (val) keys.push(secret.name);
        }
        break;

      case 'windows':
        for (const secret of SECRETS) {
          const val = await getSecret(secret.name);
          if (val) keys.push(secret.name);
        }
        break;
    }
  } catch {
    // Ignore errors in listing
  }

  return keys;
}

/**
 * Check if keychain is available on this system
 * For Linux, also checks if a keyring daemon is running
 */
export async function isKeychainAvailable(): Promise<boolean> {
  const platform = getPlatform();

  try {
    switch (platform) {
      case 'macos':
        const macProc = Bun.spawn(['which', 'security'], { stdout: 'ignore' });
        return (await macProc.exited) === 0;

      case 'linux':
        // Check if secret-tool exists
        const whichProc = Bun.spawn(['which', 'secret-tool'], { stdout: 'ignore', stderr: 'ignore' });
        if ((await whichProc.exited) !== 0) return false;

        // Also check if a keyring daemon is running (needed for secret-tool to work)
        // In Codespaces/containers, there's typically no keyring daemon
        const testProc = Bun.spawn(
          ['secret-tool', 'lookup', 'service', 'ghclaw-test', 'account', 'test'],
          { stdout: 'ignore', stderr: 'pipe' }
        );

        // Use a short timeout - if it hangs, keyring isn't available
        const timeoutPromise = new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000));
        const exitCode = await Promise.race([testProc.exited, timeoutPromise]);

        // Exit code 1 is OK (just means key not found), -1 means timeout (no daemon)
        // Exit code 0 would also be OK (found the test key)
        return exitCode === 0 || exitCode === 1;

      case 'windows':
        const winProc = Bun.spawn(['where', 'cmdkey'], { stdout: 'ignore' });
        return (await winProc.exited) === 0;

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Securely prompt for a secret (hides input)
 */
export async function promptSecretSecurely(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo for password input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
    }

    process.stdout.write(prompt);

    let input = '';
    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === '\n' || c === '\r') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode?.(false);
        }
        process.stdout.write('\n');
        rl.close();
        resolve(input);
      } else if (c === '\u0003') {
        // Ctrl+C
        process.exit(0);
      } else if (c === '\u007F' || c === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else {
        input += c;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Get instructions for manual secret management
 */
export function getManualInstructions(): string {
  const platform = getPlatform();

  const instructions: Record<string, string> = {
    macos: `
# macOS Keychain

## Store a secret (use Keychain Access app or ghclaw setup for best security):
ghclaw secrets set telegram-bot-token YOUR_TOKEN

## Retrieve a secret:
security find-generic-password -s ghclaw -a telegram-bot-token -w

## Delete a secret:
security delete-generic-password -s ghclaw -a telegram-bot-token

## Or use Keychain Access app:
1. Open Keychain Access
2. Create a new "Password" item
3. Name: telegram-bot-token
4. Where: ghclaw
5. Password: your token
`,
    linux: `
# Linux (libsecret / GNOME Keyring)

## Install secret-tool if needed:
sudo apt install libsecret-tools  # Debian/Ubuntu

## Store a secret (secure - uses stdin):
secret-tool store --label="ghclaw: telegram-bot-token" service ghclaw account telegram-bot-token
# (you will be prompted to enter the value)

## Retrieve a secret:
secret-tool lookup service ghclaw account telegram-bot-token
`,
    windows: `
# Windows Credential Manager

## Use the setup wizard for secure storage:
ghclaw setup

## Or use Credential Manager UI:
1. Open Control Panel > Credential Manager
2. Windows Credentials > Add a generic credential
3. Internet address: ghclaw:telegram-bot-token
4. User name: telegram-bot-token
5. Password: your token
`,
    unknown: `
# Manual Configuration (Fallback)

Create a secure config file:
1. mkdir -p ~/.ghclaw && chmod 700 ~/.ghclaw
2. Create ~/.ghclaw/secrets.json with mode 600
3. Add: {"telegram-bot-token": "YOUR_TOKEN"}
`,
  };

  return instructions[platform] || instructions.unknown;
}

/**
 * Migrate from .env to keychain
 */
export async function migrateFromEnv(envPath: string): Promise<{ migrated: string[]; failed: string[] }> {
  const fs = require('fs');
  const migrated: string[] = [];
  const failed: string[] = [];

  if (!fs.existsSync(envPath)) {
    return { migrated, failed };
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const envVarMap: Record<string, string> = {
    'TELEGRAM_BOT_TOKEN': 'telegram-bot-token',
    'TELEGRAM_ALLOWED_GROUP_ID': 'telegram-allowed-group',
    'TELEGRAM_ALLOWED_USER_IDS': 'telegram-allowed-users',
    'TELEGRAM_SECRET_PREFIX': 'telegram-secret-prefix',
  };

  for (const line of envContent.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;

    const [key, ...valueParts] = line.split('=');
    const value = valueParts.join('=').trim();
    const secretKey = envVarMap[key.trim()];

    if (secretKey && value && value !== '' && !value.includes('your_')) {
      const success = await setSecret(secretKey, value);
      if (success) {
        migrated.push(secretKey);
      } else {
        failed.push(secretKey);
      }
    }
  }

  return { migrated, failed };
}
