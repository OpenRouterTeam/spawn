# security/pr-reviewer (Sonnet)

Full PR security review protocol. Spawned once per non-draft PR.

## 1. Fetch full context
```bash
gh pr view NUMBER --repo OpenRouterTeam/spawn --json updatedAt,mergeable,title,headRefName,headRefOid
gh pr diff NUMBER --repo OpenRouterTeam/spawn
gh pr view NUMBER --repo OpenRouterTeam/spawn --comments
gh api repos/OpenRouterTeam/spawn/pulls/NUMBER/reviews --jq '.[] | {state, submitted_at, commit_id, user: .user.login}'
```

## 2. Review dedup
If prior review from `louisgv` or `-- security/pr-reviewer` exists:
- CHANGES_REQUESTED → skip (already flagged)
- APPROVED and not merged → skip (already approved)
- Only proceed if NEW COMMITS after latest review (compare review `commit_id` vs PR `headRefOid`)

## 3. Comment triage
If comments indicate superseded/duplicate/abandoned → close with comment + `--delete-branch`. STOP.

## 4. Staleness check
If `updatedAt` > 48h AND `mergeable` CONFLICTING → file follow-up issue if valid work, close PR. If > 48h but no conflicts → proceed. If fresh → proceed.

## 5. Worktree setup
`git worktree add WORKTREE_BASE_PLACEHOLDER/pr-NUMBER -b review-pr-NUMBER origin/main` → `gh pr checkout NUMBER`

## 6. Security review
Every changed file: command injection, credential leaks, path traversal, XSS/injection, unsafe eval/source, curl|bash safety, macOS bash 3.x compat. Record each finding: `path`, `line`, `start_line` (if multi-line), `severity` (CRITICAL/HIGH/MEDIUM/LOW), `description`.

## 7. Test (in worktree)
`bash -n` on .sh files, `bun test` for .ts changes.

## 8. Decision — Post review with inline comments
```bash
HEAD_SHA=$(gh pr view NUMBER --repo OpenRouterTeam/spawn --json headRefOid --jq .headRefOid)
gh api repos/OpenRouterTeam/spawn/pulls/NUMBER/reviews --method POST --input <(cat <<REVIEW_JSON
{
  "commit_id": "${HEAD_SHA}",
  "event": "APPROVE_OR_REQUEST_CHANGES",
  "body": "## Security Review\n**Verdict**: ...\n**Commit**: ${HEAD_SHA}\n### Findings\n...\n### Tests\n...\n---\n*-- security/pr-reviewer*",
  "comments": [
    {"path": "file.ts", "line": 42, "body": "**[SEVERITY]** Description\n\n*-- security/pr-reviewer*"}
  ]
}
REVIEW_JSON
)
```
- `event`: `"APPROVE"` or `"REQUEST_CHANGES"` (pick one)
- CRITICAL/HIGH → REQUEST_CHANGES + label `security-review-required`
- MEDIUM/LOW or clean → APPROVE + label `security-approved` + merge: `gh pr merge NUMBER --squash --delete-branch`

## 9. Cleanup
`cd REPO_ROOT_PLACEHOLDER && git worktree remove WORKTREE_BASE_PLACEHOLDER/pr-NUMBER --force`

## 10. Report
PR number, verdict, finding count, merge status.
