/**
 * GitHub Actions Workflow YAML Generation
 * Generates workflow files for reminders (self-deleting) and recurring schedules.
 * Channel-aware: generates channel-specific notification steps.
 */

import * as crypto from 'crypto';

export interface ScheduleAction {
  type: 'channel_message';
  channel: string;         // 'telegram' | 'discord' | 'slack' | ...
  message: string;
}

/**
 * Generate an 8-character random ID for workflow names
 */
export function generateId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Validate a cron expression to prevent YAML injection.
 * Only allows digits, spaces, commas, hyphens, slashes, asterisks.
 */
function validateCron(cron: string): string {
  if (!/^[0-9 ,\-\/*]+$/.test(cron)) {
    throw new Error('Invalid cron expression');
  }
  return cron;
}

/**
 * Sanitize a string for safe inclusion in YAML name field.
 * Removes anything that could break YAML structure.
 */
function sanitizeForYamlName(text: string): string {
  return text.replace(/['"\\`$\n\r{}[\]]/g, '').slice(0, 50);
}

/**
 * Validate a workflow ID is safe (hex only from generateId).
 * Prevents YAML injection and path traversal.
 */
function validateId(id: string): string {
  if (!/^[a-f0-9]+$/.test(id)) {
    throw new Error('Invalid workflow ID format');
  }
  return id;
}

/**
 * Base64-encode a message for safe embedding in workflow YAML.
 * This prevents GitHub Actions expression injection (${{ }}) and YAML breakout.
 */
function base64Encode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

/**
 * Generate the channel-specific send step for a workflow.
 * Returns the YAML run/env block for the given channel.
 */
function generateChannelSendStep(
  channel: string,
  encodedMessageVar: string,
  stepName: string
): string {
  switch (channel) {
    case 'telegram':
      return `      - name: ${stepName}
        run: |
          MSG_TEXT="$(echo "\$${encodedMessageVar}" | base64 -d)"
          curl -s -X POST "https://api.telegram.org/bot\$BOT_TOKEN/sendMessage" \\
            --data-urlencode "chat_id=\$CHAT_ID" \\
            --data-urlencode "text=\$MSG_TEXT" \\
            \${THREAD_ID:+--data-urlencode "message_thread_id=\$THREAD_ID"}
        env:
          BOT_TOKEN: \${{ secrets.TELEGRAM_BOT_TOKEN }}
          CHAT_ID: \${{ secrets.TELEGRAM_CHAT_ID }}
          THREAD_ID: \${{ secrets.TELEGRAM_THREAD_ID }}`;

    // Future channel implementations:
    // case 'discord':
    //   return `      - name: ${stepName}
    //     run: |
    //       MSG_TEXT="$(echo "\$${encodedMessageVar}" | base64 -d)"
    //       curl -s -X POST "\$WEBHOOK_URL" \\
    //         -H "Content-Type: application/json" \\
    //         -d "{\"content\": \"\$MSG_TEXT\"}"
    //     env:
    //       WEBHOOK_URL: \${{ secrets.DISCORD_WEBHOOK_URL }}`;

    // case 'slack':
    //   return `      - name: ${stepName}
    //     run: |
    //       MSG_TEXT="$(echo "\$${encodedMessageVar}" | base64 -d)"
    //       curl -s -X POST "\$WEBHOOK_URL" \\
    //         -H "Content-Type: application/json" \\
    //         -d "{\"text\": \"\$MSG_TEXT\"}"
    //     env:
    //       WEBHOOK_URL: \${{ secrets.SLACK_WEBHOOK_URL }}`;

    default:
      // Default to telegram for backward compatibility
      return generateChannelSendStep('telegram', encodedMessageVar, stepName);
  }
}

/**
 * Generate a one-shot reminder workflow YAML
 * Fires at cron time, sends message via configured channel, then deletes its own workflow file.
 *
 * Security: Message is base64-encoded to prevent GitHub Actions expression injection
 * and YAML structure breakout. Decoded at runtime in the shell step.
 */
export function generateReminderWorkflow(
  id: string,
  message: string,
  cronExpression: string,
  chatId: string,
  threadId?: string,
  channel: string = 'telegram'
): string {
  const safeId = validateId(id);
  const safeCron = validateCron(cronExpression);
  const safeName = sanitizeForYamlName(message);
  const encodedMessage = base64Encode(`🔔 Reminder: ${message}`);

  const sendStep = generateChannelSendStep(channel, 'REMINDER_TEXT_B64', 'Send reminder');

  return `name: "Reminder: ${safeName}"
on:
  schedule:
    - cron: '${safeCron}'

permissions:
  contents: write

jobs:
  remind:
    runs-on: ubuntu-latest
    steps:
${sendStep}
          REMINDER_TEXT_B64: "${encodedMessage}"

      - name: Self-cleanup
        run: |
          WORKFLOW_PATH=".github/workflows/remind-\$WORKFLOW_ID.yml"
          SHA=$(gh api "repos/\${{ github.repository }}/contents/\$WORKFLOW_PATH" --jq '.sha')
          gh api -X DELETE "repos/\${{ github.repository }}/contents/\$WORKFLOW_PATH" \\
            -f message="Auto-cleanup reminder \$WORKFLOW_ID" \\
            -f sha="\$SHA"
        env:
          GH_TOKEN: \${{ secrets.GH_PAT }}
          WORKFLOW_ID: "${safeId}"
`;
}

/**
 * Generate a persistent recurring schedule workflow YAML
 * Fires on cron schedule, sends message via configured channel. Does NOT self-delete.
 */
export function generateScheduleWorkflow(
  id: string,
  name: string,
  cronExpression: string,
  action: ScheduleAction
): string {
  const safeCron = validateCron(cronExpression);
  const safeName = sanitizeForYamlName(name);
  const encodedMessage = base64Encode(`📅 ${action.message}`);

  const sendStep = generateChannelSendStep(action.channel, 'SCHEDULE_TEXT_B64', 'Send scheduled message');

  return `name: "Schedule: ${safeName}"
on:
  schedule:
    - cron: '${safeCron}'

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
${sendStep}
          SCHEDULE_TEXT_B64: "${encodedMessage}"
`;
}
