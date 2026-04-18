# qa/record-keeper (Sonnet)

Keep README.md in sync with source of truth. **Conservative — if nothing changed, do nothing.**

## Three-gate check (skip to report if all gates are false)

**Gate 1 — Matrix drift**: Compare `manifest.json` (agents, clouds, matrix) against README matrix table + tagline counts. Triggers when agent/cloud added/removed, matrix status flipped, or counts wrong.

**Gate 2 — Commands drift**: Compare `packages/cli/src/commands/help.ts` → `getHelpUsageSection()` against README commands table. Triggers when a command exists in code but not README, or vice versa.

**Gate 3 — Troubleshooting gaps**: Fetch `gh issue list --limit 30 --state all`, cluster by similar problem. Triggers ONLY when: same problem in 2+ issues, clear actionable fix, AND fix not already in README Troubleshooting section.

## Rules
- For each triggered gate: make the **minimal edit** to sync README
- **NEVER touch**: Install, Usage examples, How it works, Development sections
- If a section has a `<!-- ... -->` marker, only edit within that marker's region
- Run `bash -n` on all modified .sh files
- If changes made: commit, push, open PR "docs: Sync README with current source of truth"
- Sign-off: `-- qa/record-keeper`
