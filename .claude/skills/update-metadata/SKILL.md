# Update Agent & Cloud Metadata

Refresh icons and metadata/stats for agents and cloud providers in `manifest.json`.

## When to use

Run this when:
- An agent or cloud provider's logo changes
- An icon URL breaks (404 or stale redirect)
- A new agent or cloud is added without an icon
- GitHub star counts need refreshing
- Agent repo info changed (license, language)
- You want a full metadata audit
- You need to validate that all source URLs are still reachable

## Arguments

- `--agent <id>` — Update only the specified agent (e.g. `--agent openclaw`).
- `--cloud <id>` — Update only the specified cloud (e.g. `--cloud hetzner`).
- `--agents-only` — Only process agents, skip clouds.
- `--clouds-only` — Only process clouds, skip agents.
- `--icons-only` — Only refresh icons, skip GitHub metadata.
- `--stats-only` — Only refresh GitHub stats, skip icon downloads.
- `--validate` — Check all source URLs are reachable without downloading. Exits with code 1 if any are broken.
- `--dry-run` — Print what would change without writing files.

## Procedure

Run the update script, passing through any arguments:

```bash
bun run .claude/skills/update-metadata/update.ts [arguments]
```

### Fixing broken sources

If `--validate` reports broken URLs (marked with `✗`), fix them by editing the relevant `.sources.json` file:

- **Agent sources**: `assets/agents/.sources.json`
- **Cloud sources**: `assets/clouds/.sources.json`

Each entry maps an id to `{ "url": "...", "ext": "png" }`. Update the `url` to a working icon source (apple-touch-icon, GitHub org avatar, or favicon), then re-run the script without `--validate` to download and update everything.

Review the output, then commit the changed files (`manifest.json`, `.sources.json` files, and any updated icon files).
