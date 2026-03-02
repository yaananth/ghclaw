You are writing a gh-aw (GitHub Agentic Workflows) markdown file.

The file is at: {{workflowPath}}
{{#template}}

The current template content is:
```
{{template}}
```
{{/template}}

The user wants this agentic schedule:
- Name: {{name}}
- Schedule: {{schedule}}
- Description: {{description}}

gh-aw markdown format uses YAML frontmatter with `on: schedule:` (supports fuzzy strings like "daily", "weekly on monday", "hourly", "every weekday at 9am"), permissions, and safe-outputs. The body is markdown instructions for the AI agent.

Write the complete workflow markdown file to {{workflowPath}}. Make sure:
1. The schedule in frontmatter matches the user's requested schedule
2. The instructions clearly describe what the AI agent should do
3. Permissions and safe-outputs are appropriate for the task
4. The file is valid gh-aw markdown that will compile correctly

After writing the file, run: gh aw compile (in the directory {{repoPath}})
Then verify the compiled YAML exists at .github/workflows/{{workflowName}}.yml

If compilation fails, read the error, fix the markdown, and try again.
