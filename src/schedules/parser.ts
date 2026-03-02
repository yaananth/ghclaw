/**
 * Schedule Parser
 * Parses natural-language schedule requests into cron expressions.
 * Uses Copilot CLI for NLP parsing with basic keyword fallback.
 */

import { executeSimple } from '../copilot/session';

export interface ParsedSchedule {
  type: 'reminder' | 'recurring';
  message: string;
  cronExpression: string;
  humanReadable: string;  // e.g. "Every Friday at 3pm"
}

/**
 * Parse a schedule request from natural language
 */
export async function parseScheduleRequest(userMessage: string): Promise<ParsedSchedule | null> {
  try {
    return await parseWithCopilot(userMessage);
  } catch {
    return parseWithKeywords(userMessage);
  }
}

/**
 * Parse using Copilot CLI for NLP understanding
 */
async function parseWithCopilot(userMessage: string): Promise<ParsedSchedule | null> {
  const prompt = `Parse this schedule/reminder request and return ONLY a JSON object (no markdown, no explanation):

"${userMessage}"

Return JSON with these fields:
- type: "reminder" (one-time) or "recurring" (repeating)
- message: the reminder/schedule message text (what to be reminded about)
- cronExpression: a valid GitHub Actions cron expression (UTC time, 5 fields: minute hour day month weekday)
- humanReadable: human-friendly description like "Tomorrow at 9am" or "Every Monday at 9am"

Important: GitHub Actions cron uses UTC. Assume the user is in US Eastern time (UTC-5).
If you can't parse it, return: {"error": "Could not parse"}`;

  const result = await executeSimple(prompt, { timeout: 15000 });

  // Extract JSON from response
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.error) return null;

    if (!parsed.cronExpression || !parsed.message) return null;

    return {
      type: parsed.type === 'recurring' ? 'recurring' : 'reminder',
      message: parsed.message,
      cronExpression: parsed.cronExpression,
      humanReadable: parsed.humanReadable || parsed.cronExpression,
    };
  } catch {
    return null;
  }
}

/**
 * Basic keyword-based fallback parser
 */
function parseWithKeywords(userMessage: string): ParsedSchedule | null {
  const lower = userMessage.toLowerCase();

  // Detect type
  const isRecurring = /\b(every|daily|weekly|monthly|each)\b/.test(lower);
  const type = isRecurring ? 'recurring' : 'reminder';

  // Try to extract time
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  let hour = 9; // default
  let minute = 0;

  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = parseInt(timeMatch[2] || '0');
    if (timeMatch[3] === 'pm' && hour < 12) hour += 12;
    if (timeMatch[3] === 'am' && hour === 12) hour = 0;
    // Convert EST to UTC (rough)
    hour = (hour + 5) % 24;
  }

  // Extract message (remove time/scheduling keywords)
  const message = userMessage
    .replace(/\b(remind\s+me|every|daily|weekly|monthly|at\s+\d{1,2}(:\d{2})?\s*(am|pm)?|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || userMessage;

  // Day of week
  const days: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  let cronDay = '*';
  let cronDow = '*';
  let humanReadable = '';

  for (const [dayName, dayNum] of Object.entries(days)) {
    if (lower.includes(dayName)) {
      cronDow = dayNum.toString();
      humanReadable = isRecurring
        ? `Every ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} at ${formatTime(hour - 5, minute)}`
        : `Next ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} at ${formatTime(hour - 5, minute)}`;
      break;
    }
  }

  if (lower.includes('tomorrow')) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    cronDay = tomorrow.getDate().toString();
    const monthNum = tomorrow.getMonth() + 1;
    humanReadable = `Tomorrow at ${formatTime(hour - 5, minute)}`;
    return {
      type,
      message,
      cronExpression: `${minute} ${hour} ${cronDay} ${monthNum} *`,
      humanReadable,
    };
  }

  if (lower.includes('daily')) {
    humanReadable = `Daily at ${formatTime(hour - 5, minute)}`;
  }

  if (!humanReadable) {
    humanReadable = `At ${formatTime(hour - 5, minute)} ${isRecurring ? '(recurring)' : '(one-time)'}`;
  }

  return {
    type,
    message,
    cronExpression: `${minute} ${hour} ${cronDay} * ${cronDow}`,
    humanReadable,
  };
}

function formatTime(hour: number, minute: number): string {
  const h = ((hour % 24) + 24) % 24;
  const ampm = h >= 12 ? 'pm' : 'am';
  const displayHour = h % 12 || 12;
  const displayMinute = minute.toString().padStart(2, '0');
  return `${displayHour}:${displayMinute}${ampm}`;
}
