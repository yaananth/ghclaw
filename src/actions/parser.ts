/**
 * Action Block Parser
 *
 * Extracts structured action blocks from Copilot CLI output.
 * The LLM outputs actions as fenced JSON blocks with a special tag:
 *
 *   ```json:ghclaw-action
 *   {"action": "create_reminder", "message": "deploy", "schedule": "tomorrow 9am"}
 *   ```
 *
 * This parser extracts all action blocks and returns the remaining text.
 */

import type { GhclawAction } from './types';

const ACTION_BLOCK_REGEX = /```json:ghclaw-action\s*\n([\s\S]*?)```/g;

export interface ParsedResponse {
  /** Text to display to user (action blocks stripped) */
  text: string;
  /** Parsed actions to execute */
  actions: GhclawAction[];
}

/**
 * Parse Copilot CLI output, extracting action blocks and returning clean text.
 */
export function parseActionBlocks(output: string): ParsedResponse {
  const actions: GhclawAction[] = [];

  // Extract all action blocks
  const text = output.replace(ACTION_BLOCK_REGEX, (_match, jsonStr: string) => {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (parsed && typeof parsed.action === 'string') {
        actions.push(parsed as GhclawAction);
      }
    } catch {
      // Malformed JSON — skip, leave in output
      return _match;
    }
    return ''; // Remove successfully parsed action blocks from text
  });

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    actions,
  };
}
