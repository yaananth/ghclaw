/**
 * Copilot CLI Feature Discovery
 * Discovers version and asks Copilot to report its own capabilities
 */

import { getGhToken } from '../github/auth';

export interface CopilotFeature {
  name: string;
  description: string;
  usage: string;
  type: 'slash_command' | 'capability' | 'tool';
}

export interface CopilotDiscovery {
  version: string;
  features: CopilotFeature[];
  models: string[];
  tools: string[];
  capabilities: string; // Raw capabilities description from Copilot itself
  discoveredAt: Date;
}

/**
 * Discover Copilot CLI features
 * Gets version and asks Copilot to self-report capabilities
 */
export async function discoverCopilotFeatures(): Promise<CopilotDiscovery> {
  const features: CopilotFeature[] = [];
  const models: string[] = [];
  const tools: string[] = [];

  // Get copilot version
  const versionResult = await runCopilot(['--version']);
  const version = versionResult.stdout.trim().replace(/^GitHub Copilot CLI\s*/i, '').replace(/\.\s*Run.*$/, '').trim();

  // Ask Copilot to report its capabilities in a structured way
  let capabilities = '';
  try {
    const capResult = await runCopilot([
      '-p',
      'List your capabilities in this exact format. No intro, no explanation, just the lists:\n\n' +
      'TOOLS:\n- tool_name: one-line description\n\n' +
      'SLASH_COMMANDS:\n- /command: one-line description\n\n' +
      'MODELS:\n- model_name',
      '--silent',
    ], 45000);

    if (capResult.exitCode === 0 && capResult.stdout.trim()) {
      capabilities = capResult.stdout.trim();

      // Parse tools
      const toolsMatch = capabilities.match(/TOOLS:\n([\s\S]*?)(?=\n(?:SLASH_COMMANDS|MODELS):|$)/);
      if (toolsMatch) {
        for (const line of toolsMatch[1].split('\n')) {
          const m = line.match(/^[-*]\s*(\w+):\s*(.+)/);
          if (m) {
            tools.push(m[1]);
            features.push({ name: m[1], description: m[2].trim(), usage: m[1], type: 'tool' });
          }
        }
      }

      // Parse slash commands
      const slashMatch = capabilities.match(/SLASH_COMMANDS:\n([\s\S]*?)(?=\n(?:TOOLS|MODELS):|$)/);
      if (slashMatch) {
        for (const line of slashMatch[1].split('\n')) {
          const m = line.match(/^[-*]\s*(\/\w+):\s*(.+)/);
          if (m) {
            features.push({ name: m[1], description: m[2].trim(), usage: m[1], type: 'slash_command' });
          }
        }
      }

      // Parse models
      const modelsMatch = capabilities.match(/MODELS:\n([\s\S]*?)(?=\n(?:TOOLS|SLASH_COMMANDS):|$)/);
      if (modelsMatch) {
        for (const line of modelsMatch[1].split('\n')) {
          const m = line.match(/^[-*]\s*(.+)/);
          if (m) models.push(m[1].trim());
        }
      }
    }
  } catch {
    // Discovery is best-effort
  }

  // If self-report parsing found nothing, log it — don't hardcode guesses
  if (features.length === 0) {
    console.log('⚠️  Copilot CLI self-report returned no parseable features. Run: copilot help commands');
  }

  return {
    version,
    features,
    models,
    tools,
    capabilities,
    discoveredAt: new Date(),
  };
}

interface CopilotResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCopilot(args: string[], timeout = 30000): Promise<CopilotResult> {
  const proc = Bun.spawn(['copilot', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GITHUB_TOKEN: (await getGhToken()) || '',
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Copilot command timed out')), timeout);
  });

  try {
    const result = await Promise.race([proc.exited, timeoutPromise]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: result as number };
  } catch (error) {
    proc.kill();
    return { stdout: '', stderr: String(error), exitCode: 1 };
  }
}

/**
 * Format discovery results for display
 */
export function formatDiscovery(discovery: CopilotDiscovery): string {
  const lines = [
    `Copilot CLI v${discovery.version}`,
    '',
    '== Slash Commands ==',
    ...discovery.features
      .filter(f => f.type === 'slash_command')
      .map(f => `  ${f.name.padEnd(15)} ${f.description}`),
    '',
    '== Tools ==',
    ...discovery.features
      .filter(f => f.type === 'tool')
      .map(f => `  ${f.name.padEnd(15)} ${f.description}`),
    ...(discovery.features.filter(f => f.type === 'tool').length === 0
      ? discovery.tools.map(t => `  ${t}`)
      : []),
    '',
    '== Models ==',
    ...discovery.models.map(m => `  ${m}`),
  ];
  return lines.join('\n');
}

// Run discovery if called directly
if (import.meta.main) {
  console.log('Discovering Copilot CLI features...\n');
  const discovery = await discoverCopilotFeatures();
  console.log(formatDiscovery(discovery));
  if (discovery.capabilities) {
    console.log('\n== Raw Capabilities ==');
    console.log(discovery.capabilities);
  }
}
