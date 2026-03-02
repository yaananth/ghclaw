You are creating a gh-aw (GitHub Agentic Workflows) workflow.

## Step 1: Fetch the latest gh-aw documentation

BEFORE writing anything, fetch the official reference to get the current spec:

Fetch `https://raw.githubusercontent.com/github/gh-aw/main/.github/aw/github-agentic-workflows.md`

This is the canonical reference for ALL gh-aw frontmatter fields: triggers, schedule syntax, engines, permissions, safe-outputs, tools, MCP servers, network/firewall, sandbox, etc. The spec evolves — always use what the doc says, not prior knowledge.

## Step 2: Check engine requirements

Based on the docs, determine which engine secrets are needed for this workflow:
- **Copilot** (default): requires `COPILOT_GITHUB_TOKEN` repo secret
- **Claude**: requires `ANTHROPIC_API_KEY` repo secret
- **Codex**: requires `OPENAI_API_KEY` repo secret
- **Gemini**: requires `GEMINI_API_KEY` repo secret

Check if the required secret exists: `gh secret list -R {{repoOwner}}/{{repoName}} 2>/dev/null`

If the secret is missing, note this — you'll report it to the user after compilation.

## Step 3: Write the workflow

The file is at: {{workflowPath}}
{{#template}}

The current template content is:
```
{{template}}
```
{{/template}}

The user wants this agentic workflow:
- **Name**: {{name}}
- **Schedule**: {{schedule}}
- **Description**: {{description}}

Based on the docs you fetched, write a complete workflow markdown file. Key things to get right:
- `on: schedule:` supports fuzzy strings ("daily", "weekly on monday", "every weekday at 9am")
- Use minimal `permissions:` (read-only for the agent job; writes go through safe-outputs)
- Configure `safe-outputs:` appropriate for the task (create-issue, add-comment, create-pull-request, etc.)
- Choose the right `engine:` (default copilot unless the task needs a specific one)
- Set `tools:` — at minimum `github:` with appropriate toolsets for the task
- Set `network:` if the task needs external API access beyond GitHub
- The markdown body contains natural language instructions for the AI agent

Write the file to {{workflowPath}}.

## Step 4: Compile and verify

```bash
cd {{repoPath}} && gh aw compile {{workflowName}}
```

Verify the compiled lock file exists at `.github/workflows/{{workflowName}}.lock.yml`

If compilation fails:
1. Read the error carefully
2. Re-check the docs you fetched in Step 1
3. Fix the markdown and retry

## Step 5: Report

After successful compilation, report:
- What the workflow does
- Which engine and tools it uses
- Whether any required secrets are missing (and how to set them)
- The schedule in human-readable form
