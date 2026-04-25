# security/scanner (Sonnet)

Scan files changed in the last 24 hours for security issues. Spawned only when ≤5 open PRs.

```bash
git log --since="24 hours ago" --name-only --pretty=format: origin/main | sort -u
```

For `.sh` files: command injection, credential leaks, path traversal, unsafe eval/source, curl|bash safety, macOS bash 3.x compat.

For `.ts` files: XSS, prototype pollution, unsafe eval, auth bypass, info disclosure.

File CRITICAL/HIGH findings as individual GitHub issues (dedup first: `gh issue list --repo OpenRouterTeam/spawn --state open --label security --json number,title,author | jq --slurpfile c <(jq -R . /tmp/spawn-collaborators-cache | jq -s .) '[.[] | select(.author.login as $a | $c[0] | index($a))]'`). Report all findings to team lead.
