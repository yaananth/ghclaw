You are testing a gh-aw (GitHub Agentic Workflows) workflow and monitoring it to completion.

## Workflow: {{workflowName}}
## Repo: {{repoOwner}}/{{repoName}}

## Step 0: Fetch auth reference

Fetch the auth docs so you can diagnose any auth failures accurately:

Fetch `https://github.github.com/gh-aw/reference/auth/`

This tells you exactly which secrets each engine needs, token scopes, setup commands, and token creation links. Use this as the source of truth when diagnosing failures.

## Step 1: Trigger the test run

First, commit and push the workflow files so GitHub Actions can see them:

```bash
cd {{repoPath}} && git add .github/workflows/ && git commit -m "Add/update {{workflowName}} workflow" && git push 2>&1
```

Then trigger the workflow:

```bash
gh workflow run {{workflowName}}.lock.yml -R {{repoOwner}}/{{repoName}} 2>/dev/null || gh workflow run {{workflowName}}.yml -R {{repoOwner}}/{{repoName}} 2>/dev/null || gh aw run {{workflowName}} 2>/dev/null
```

If the trigger command fails, check `gh workflow list -R {{repoOwner}}/{{repoName}}` to find the correct workflow filename.

## Step 2: Monitor until completion

Wait a few seconds, then poll for the run:

```bash
# Find the most recent run for this workflow
gh run list -R {{repoOwner}}/{{repoName}} --workflow {{workflowName}}.lock.yml --limit 1 --json databaseId,status,conclusion 2>/dev/null || gh run list -R {{repoOwner}}/{{repoName}} --workflow {{workflowName}}.yml --limit 1 --json databaseId,status,conclusion 2>/dev/null
```

Keep polling every 15 seconds until the run completes (status is "completed"). Maximum 20 polls (5 minutes).

Between polls, report the current status briefly.

## Step 3: Evaluate the result

Once the run completes, check the conclusion:

**If succeeded:** Report success with a brief summary.

**If failed:**
1. Get the failure details:
   ```bash
   gh run view <RUN_ID> -R {{repoOwner}}/{{repoName}} --log-failed 2>&1 | head -50
   ```

2. Diagnose the root cause using the auth docs you fetched. Common failures:
   - **Missing secret** — Use the auth docs to identify the exact secret name, required scopes, and token creation link. Provide the `gh aw secrets set` command.
   - **Bad engine config** — Fix the workflow markdown and recompile
   - **Permission issue** — Fix permissions in frontmatter
   - **Network/firewall** — Add required domains to `network:` allowlist
   - **Compilation error** — Fix syntax and recompile
   - **Tool not available** — Check tools configuration

3. If the fix is something you can do (edit workflow markdown, recompile):
   - Fetch latest workflow spec: `https://raw.githubusercontent.com/github/gh-aw/main/.github/aw/github-agentic-workflows.md`
   - Fix the workflow markdown at `{{repoPath}}/.github/workflows/{{workflowName}}.md`
   - Recompile: `cd {{repoPath}} && gh aw compile {{workflowName}}`
   - Commit and push the fix
   - Re-trigger and monitor again (go back to Step 1, max 2 retry cycles)

4. If the fix requires user action (setting a secret, granting permissions):
   - Report clearly what's needed
   - Provide exact commands from the auth docs, including token creation links

## Step 4: Final report

Summarize:
- Whether the workflow ran successfully
- If it failed, what the root cause was
- What was fixed (if anything)
- What the user still needs to do (if anything), with exact commands from the auth docs
- Link to the run: `https://github.com/{{repoOwner}}/{{repoName}}/actions`
