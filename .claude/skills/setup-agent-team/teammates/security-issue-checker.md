# security/issue-checker (google/gemini-3-flash-preview)

Re-triage open issues for label consistency and staleness.

`gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,labels,updatedAt,comments,author | jq --slurpfile c <(jq -R . /tmp/spawn-collaborators-cache | jq -s .) '[.[] | select(.author.login as $a | $c[0] | index($a))]'`

**Collaborator gate**: For each issue, check if the author is a repo collaborator:
```bash
gh api repos/OpenRouterTeam/spawn/collaborators/AUTHOR_LOGIN --silent 2>/dev/null
```
If the check fails (exit code != 0), SKIP that issue entirely.

For each collaborator-authored issue, fetch full context: `gh issue view NUMBER --comments`

- **Strict dedup**: if `-- security/issue-checker` or `-- security/triage` exists in ANY comment → SKIP unless new human comments posted after the last security sign-off
- **NEVER** post status updates, re-triages, or acknowledgment-only follow-ups. ONE triage comment per issue, EVER.
- **Label progression** (fix silently, no comment needed):
  - Has `under-review` + triage comment → transition to `safe-to-work`
  - No status label → add `pending-review`
  - Every issue needs exactly ONE status label
- Sign-off: `-- security/issue-checker`
