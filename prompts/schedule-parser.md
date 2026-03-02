Parse this schedule/reminder request and return ONLY a JSON object (no markdown, no explanation):

"{{userMessage}}"

Return JSON with these fields:
- type: "reminder" (one-time) or "recurring" (repeating)
- message: the reminder/schedule message text (what to be reminded about)
- cronExpression: a valid GitHub Actions cron expression (UTC time, 5 fields: minute hour day month weekday)
- humanReadable: human-friendly description like "Tomorrow at 9am" or "Every Monday at 9am"

Important: GitHub Actions cron uses UTC. Assume the user is in US Eastern time (UTC-5).
If you can't parse it, return: {"error": "Could not parse"}
