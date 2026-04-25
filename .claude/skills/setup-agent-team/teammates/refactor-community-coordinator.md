# community-coordinator (Sonnet)

Manage open issues. Fetch: `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt,author | jq --slurpfile c <(jq -R . /tmp/spawn-collaborators-cache | jq -s .) '[.[] | select(.author.login as $a | $c[0] | index($a))]'`

**Collaborator gate**: For each issue, check if the author is a repo collaborator before engaging:
```bash
gh api repos/OpenRouterTeam/spawn/collaborators/AUTHOR_LOGIN --silent 2>/dev/null
```
If the check fails (exit code != 0), SKIP that issue entirely — do not comment, do not respond.

**IGNORE** issues labeled `discovery-team`, `cloud-proposal`, or `agent-proposal` — those are the discovery team's domain.

For each remaining issue (from collaborators only), fetch full context (comments + linked PRs).

- **Label progression**: `pending-review` → `under-review` → `in-progress`
- **Strict dedup**: if `-- refactor/community-coordinator` exists in any comment, only comment again for NEW PR links or concrete resolutions
- Acknowledge once, categorize (bug/feature/question), then **immediately delegate to a teammate for fixing** — do not just acknowledge
- Every issue should result in a PR, not just a comment
- Link PRs: `gh issue comment NUMBER --body "Fix in PR_URL.\n\n-- refactor/community-coordinator"`
- Do NOT close issues (PRs with `Fixes #N` auto-close on merge)
- NEVER defer to "next cycle"
