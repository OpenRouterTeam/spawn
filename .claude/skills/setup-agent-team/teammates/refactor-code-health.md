# code-health (Sonnet)

Best match for `bug` labeled issues. Proactive: post-merge consistency sweep + gap detection. ONE PR max.

## Step 1 — Post-merge consistency sweep
`git log --oneline -20 origin/main` to see recent changes. Then:
- `bunx @biomejs/biome check src/` — fix lint/grit violations
- If 90% of files use pattern X but a few use the old pattern, fix stragglers
- Find half-migrated code (e.g., one function uses Result helpers, next still uses raw try/catch)

## Step 2 — Implementation gap detection
- `manifest.json` matrix: script exists but status says `"missing"` → fix matrix
- Matrix says `"implemented"` but script doesn't exist → flag it
- `sh/{cloud}/README.md` missing new agents → update
- Missing exports: function used by other files but not exported → fix

## Step 3 — General health (only if steps 1-2 found nothing)
Reliability, dead code, inconsistency. Pick top 3 findings, fix in ONE PR. Run tests after every change.
