You are creating a gh-aw (GitHub Agentic Workflows) workflow.

## Step 1: Fetch the latest gh-aw documentation

BEFORE writing anything, fetch these official references to get the current spec:

1. **Workflow spec**: Fetch `https://raw.githubusercontent.com/github/gh-aw/main/.github/aw/github-agentic-workflows.md`
   This is the canonical reference for ALL gh-aw frontmatter fields: triggers, schedule syntax, engines, permissions, safe-outputs, tools, MCP servers, network/firewall, sandbox, etc.

2. **Auth requirements**: Fetch `https://github.github.com/gh-aw/reference/auth/`
   This is the canonical reference for ALL authentication: which secrets each engine needs, token scopes, setup commands, GitHub App alternatives, and supplemental auth for advanced features.

The spec evolves — always use what the docs say, not prior knowledge. The auth page is the single source of truth for engine-to-secret mappings and token creation.

## Step 2: Check existing workflows and recent failures

Before creating anything, check what already exists:

```bash
# List existing agentic workflows
ls {{repoPath}}/.github/workflows/*.md 2>/dev/null

# Check recent failed workflow runs
gh run list -R {{repoOwner}}/{{repoName}} --status failure --limit 5 2>/dev/null
```

**If a similar workflow already exists** (same purpose, overlapping schedule):
- Do NOT create a duplicate
- Instead, update the existing workflow markdown to match the user's new intent
- If the existing one has a compiled `.lock.yml`, recompile after updating

**If there are recent failed runs:**
- Inspect the failure: `gh run view <run-id> -R {{repoOwner}}/{{repoName}} --log-failed 2>/dev/null`
- Diagnose the root cause (missing secret, bad engine, permission issue, bad config, etc.)
- Fix the underlying issue (update the workflow markdown, report missing secrets, etc.)
- If the fix is a missing secret, use the auth docs you fetched to provide the correct setup command
- Recompile after fixing: `cd {{repoPath}} && gh aw compile <workflow-name>`

If the failures are unrelated to the current task, note them but continue.

## Step 3: Validate engine auth (CRITICAL — DO NOT SKIP)

The engine for this workflow is: **{{engine}}**

Using the auth docs you fetched in Step 1, determine which secret is required for the **{{engine}}** engine.

Check if the required secret exists:
```bash
gh secret list -R {{repoOwner}}/{{repoName}} 2>/dev/null
```

**If the required secret for engine "{{engine}}" is MISSING:**
1. **STOP — do NOT write the workflow**
2. Report exactly which secret is missing
3. Provide the exact setup command from the auth docs (including token creation links if available)
4. Do NOT proceed to Step 4

**If the secret exists, continue.**

## Step 4: Write the workflow

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
- **Engine**: {{engine}}

Based on the docs you fetched, write a complete workflow markdown file. Key things to get right:
- `on: schedule:` supports fuzzy strings ("daily", "weekly on monday", "every weekday at 9am")
- Use minimal `permissions:` (read-only for the agent job; writes go through safe-outputs)
- Configure `safe-outputs:` appropriate for the task (create-issue, add-comment, create-pull-request, etc.)
- **Use engine: {{engine}}** — do NOT change the engine unless the user specifically requested a different one
- Set `tools:` — at minimum `github:` with appropriate toolsets for the task
- Set `network:` if the task needs external API access beyond GitHub
- The markdown body contains natural language instructions for the AI agent

Write the file to {{workflowPath}}.

## Step 5: Compile and verify

```bash
cd {{repoPath}} && gh aw compile {{workflowName}}
```

Verify the compiled lock file exists at `.github/workflows/{{workflowName}}.lock.yml`

If compilation fails:
1. Read the error carefully
2. Re-check the docs you fetched in Step 1
3. Fix the markdown and retry

## Step 6: Report

After successful compilation, report:
- What the workflow does
- Which engine and tools it uses
- Whether any required secrets are missing (and how to set them, per the auth docs)
- The schedule in human-readable form
- Any existing failed runs you found and whether they were fixed
