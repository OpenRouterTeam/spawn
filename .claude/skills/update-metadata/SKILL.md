# Update Agent Metadata

Refresh agent icons (favicons) and all metadata/stats in `manifest.json` by fetching live data from GitHub and agent websites.

## When to use

Run this when:
- An agent's logo changes (new branding, new org avatar)
- An icon URL breaks (404 or stale redirect)
- A new agent is added to the manifest without metadata
- GitHub star counts need refreshing (run periodically)
- Agent repo info changed (license, language, description)
- You want a full metadata audit across all agents

## Arguments

- `--agent <id>` — Update only the specified agent (e.g. `--agent openclaw`). Omit to update all.
- `--dry-run`    — Print what would change without writing files.
- `--icons-only` — Only refresh icons, skip GitHub metadata.
- `--stats-only` — Only refresh GitHub stats, skip icon downloads.

## Procedure

Run the update script, passing through any arguments:

```bash
bun run .claude/skills/update-metadata/update.ts [arguments]
```

Review the output, then commit the changed files (`manifest.json`, `assets/agents/.sources.json`, and any updated icon files in `assets/agents/`).
