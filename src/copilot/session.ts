/**
 * Copilot CLI Session Manager
 *
 * Executes prompts via Copilot CLI, leveraging its built-in session management.
 * Uses --resume to continue existing sessions, letting Copilot CLI handle
 * all context, memory, and history (Chronicle feature).
 *
 * Uses -p/--prompt for non-interactive mode execution.
 */

import { getGhToken } from '../github/auth';
import { getConfigDir } from '../config';

export interface SessionOptions {
  model?: string;
  profile?: string;
  workingDir?: string;
  timeout?: number;
  yoloMode?: boolean;
  sessionId?: string;  // Copilot CLI session UUID for --resume
  cliPath?: string;    // Path to copilot CLI binary
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  content: string;
}

/**
 * Execute a prompt with Copilot CLI and stream the response
 *
 * If sessionId is provided, uses --resume to continue that session.
 * This lets Copilot CLI's Chronicle feature manage all history and context.
 */
export async function* executePrompt(
  prompt: string,
  options: SessionOptions = {}
): AsyncGenerator<StreamChunk> {
  // Build command arguments
  // Use -p/--prompt for non-interactive mode
  const args = ['-p', prompt];

  // Resume existing session if sessionId provided
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.profile) {
    args.push('--profile', options.profile);
  }

  // YOLO mode: allow all tools (user opted in)
  if (options.yoloMode) {
    args.push('--yolo');
  }

  // Silent mode for cleaner output in non-interactive use
  args.push('--silent');

  // Use configured CLI path or default to 'copilot'
  const cliPath = options.cliPath || 'copilot';

  const proc = Bun.spawn([cliPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: options.workingDir || process.env.HOME,
    env: {
      ...process.env,
      GITHUB_TOKEN: (await getGhToken()) || '',
      // Point Copilot CLI to ghclaw's AGENTS.md for custom instructions
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: getConfigDir(),
    },
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalLines = 0;

  // Log args but redact the actual prompt for security
  const redactedArgs = args.map((a, i) => i === 1 ? '[PROMPT]' : a);
  console.log(`   [copilot] Starting with args: ${redactedArgs.join(' ')}`);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Yield chunks as they come
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          totalLines++;
          yield { type: 'text', content: line };
        }
      }
    }

    // Yield remaining buffer
    if (buffer.trim()) {
      totalLines++;
      yield { type: 'text', content: buffer };
    }

    const exitCode = await proc.exited;
    console.log(`   [copilot] Exit code: ${exitCode}, total lines: ${totalLines}`);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      yield { type: 'error', content: sanitizeError(stderr) };
    }

    yield { type: 'done', content: '' };
  } catch (error) {
    console.log(`   [copilot] Error: ${error}`);
    yield { type: 'error', content: sanitizeError(String(error)) };
  }
}

/**
 * Sanitize error messages to prevent information leakage
 */
function sanitizeError(error: string): string {
  return error
    // Paths
    .replace(/\/Users\/[^\/\s]+/g, '/Users/***')
    .replace(/\/home\/[^\/\s]+/g, '/home/***')
    .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\***')
    // Tokens and secrets
    .replace(/token[=:]\s*\S+/gi, 'token=***')
    .replace(/password[=:]\s*\S+/gi, 'password=***')
    .replace(/secret[=:]\s*\S+/gi, 'secret=***')
    .replace(/key[=:]\s*\S+/gi, 'key=***')
    .replace(/bearer\s+\S+/gi, 'Bearer ***')
    .replace(/authorization[=:]\s*\S+/gi, 'Authorization=***')
    // API keys (common formats)
    .replace(/[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
    // Limit length
    .slice(0, 500);
}

/**
 * Execute a simple prompt and get the full response
 */
export async function executeSimple(
  prompt: string,
  options: SessionOptions = {}
): Promise<string> {
  let result = '';
  for await (const chunk of executePrompt(prompt, options)) {
    if (chunk.type === 'text') {
      result += chunk.content + '\n';
    } else if (chunk.type === 'error') {
      throw new Error(chunk.content);
    }
  }
  return result.trim();
}
