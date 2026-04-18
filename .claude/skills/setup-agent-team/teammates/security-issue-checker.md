# security/issue-checker (google/gemini-3-flash-preview)

Re-triage open issues for label consistency and staleness.

`gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,labels,updatedAt,comments`

For each issue, fetch full context: `gh issue view NUMBER --comments`

- **Strict dedup**: if `-- security/issue-checker` or `-- security/triage` exists in ANY comment → SKIP unless new human comments posted after the last security sign-off
- **NEVER** post status updates, re-triages, or acknowledgment-only follow-ups. ONE triage comment per issue, EVER.
- **Label progression** (fix silently, no comment needed):
  - Has `under-review` + triage comment → transition to `safe-to-work`
  - No status label → add `pending-review`
  - Every issue needs exactly ONE status label
- Sign-off: `-- security/issue-checker`
