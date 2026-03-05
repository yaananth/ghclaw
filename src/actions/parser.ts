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
 * This parser extracts all action blocks, validates them against a strict
 * schema, and returns the remaining text.
 *
 * SECURITY: LLM output is treated as untrusted input. All action blocks
 * are validated against an allowlist of action types with per-type field
 * schemas. Unknown keys, oversized fields, and invalid types are rejected.
 */

import type { GhclawAction, ActionType } from './types';

const ACTION_BLOCK_REGEX = /```json:ghclaw-action\s*\n([\s\S]*?)```/g;

/** Maximum JSON block size (prevents memory abuse) */
const MAX_BLOCK_SIZE = 4096;

/** Maximum string field length */
const MAX_FIELD_LENGTH = 500;

/**
 * Schema for each action type: which fields are allowed and which are required.
 * Any field not in this schema is rejected.
 */
const ACTION_SCHEMAS: Record<ActionType, { required: string[]; optional: string[] }> = {
  create_reminder: { required: ['message', 'schedule'], optional: [] },
  list_reminders: { required: [], optional: [] },
  cancel_reminder: { required: ['id'], optional: [] },
  create_schedule: { required: ['message', 'schedule'], optional: [] },
  list_schedules: { required: [], optional: [] },
  cancel_schedule: { required: ['id'], optional: [] },
  create_coding_task: { required: ['description'], optional: ['repo'] },
  create_agentic_schedule: { required: ['name', 'description', 'schedule'], optional: [] },
  test_agentic_workflow: { required: ['name'], optional: [] },
  list_sessions: { required: [], optional: ['query', 'hours'] },
  search_sessions: { required: ['query'], optional: [] },
  resume_session: { required: ['session_id'], optional: [] },
  new_session: { required: [], optional: [] },
  show_status: { required: [], optional: [] },
  show_github_status: { required: [], optional: [] },
  set_model: { required: ['model'], optional: [] },
  show_model: { required: [], optional: [] },
  route_to_machine: { required: ['machine_name'], optional: [] },
  list_machines: { required: [], optional: [] },
};

/** All valid action type strings */
const VALID_ACTION_TYPES = new Set<string>(Object.keys(ACTION_SCHEMAS));

export interface ParsedResponse {
  /** Text to display to user (action blocks stripped) */
  text: string;
  /** Parsed and validated actions to execute */
  actions: GhclawAction[];
}

/**
 * Sanitize a string field: strip control characters, enforce length limit.
 */
function sanitizeStringField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Strip control characters except space
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_FIELD_LENGTH);
}

/**
 * Validate a parsed JSON object against the action schema.
 * Returns a validated GhclawAction or null if invalid.
 */
function validateAction(parsed: Record<string, unknown>): GhclawAction | null {
  // Must have an 'action' field that's a known type
  const actionType = parsed.action;
  if (typeof actionType !== 'string' || !VALID_ACTION_TYPES.has(actionType)) {
    return null;
  }

  const schema = ACTION_SCHEMAS[actionType as ActionType];
  if (!schema) return null;

  const allowedKeys = new Set(['action', ...schema.required, ...schema.optional]);

  // Reject unknown keys
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      return null;
    }
  }

  // Build validated action with only allowed fields
  const validated: Record<string, unknown> = { action: actionType };

  // Check required fields
  for (const field of schema.required) {
    const value = parsed[field];
    if (field === 'hours') {
      // Numeric field
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8760) {
        return null;
      }
      validated[field] = value;
    } else {
      // String field
      const sanitized = sanitizeStringField(value);
      if (sanitized === null) return null;
      validated[field] = sanitized;
    }
  }

  // Check optional fields (only include if present)
  for (const field of schema.optional) {
    if (field in parsed && parsed[field] !== undefined && parsed[field] !== null) {
      const value = parsed[field];
      if (field === 'hours') {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8760) {
          validated[field] = value;
        }
        // else skip (don't reject, it's optional)
      } else {
        const sanitized = sanitizeStringField(value);
        if (sanitized !== null) {
          validated[field] = sanitized;
        }
      }
    }
  }

  return validated as unknown as GhclawAction;
}

/**
 * Parse Copilot CLI output, extracting action blocks and returning clean text.
 * Actions are validated against a strict schema. Invalid blocks are silently dropped.
 */
export function parseActionBlocks(output: string): ParsedResponse {
  const actions: GhclawAction[] = [];

  // Extract all action blocks
  const text = output.replace(ACTION_BLOCK_REGEX, (_match, jsonStr: string) => {
    // Size limit
    if (jsonStr.length > MAX_BLOCK_SIZE) {
      return ''; // Drop oversized blocks
    }

    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const validated = validateAction(parsed as Record<string, unknown>);
        if (validated) {
          actions.push(validated);
        }
      }
    } catch {
      // Malformed JSON — silently drop
    }
    return ''; // Always remove action blocks from display text
  });

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    actions,
  };
}
