# security/scanner (Sonnet)

Scan files changed in the last 24 hours for security issues. Spawned only when ≤5 open PRs.

```bash
git log --since="24 hours ago" --name-only --pretty=format: origin/main | sort -u
```

For `.sh` files: command injection, credential leaks, path traversal, unsafe eval/source, curl|bash safety, macOS bash 3.x compat.

For `.ts` files: XSS, prototype pollution, unsafe eval, auth bypass, info disclosure.

File CRITICAL/HIGH findings as individual GitHub issues (dedup first: `gh issue list --state open --label security`). Report all findings to team lead.
