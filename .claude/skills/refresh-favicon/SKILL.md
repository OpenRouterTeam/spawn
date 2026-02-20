# Refresh Agent Favicons

Re-download all agent icon/favicon files into `assets/agents/` and keep the manifest `icon` fields in sync.

## When to use

Run this when:
- An agent's logo changes (new branding, new org avatar)
- An icon URL breaks (404 or stale redirect)
- A new agent is added to the manifest without a local icon
- You suspect an icon file is corrupt or outdated

## Arguments

- `--agent <id>` — Refresh only the specified agent (e.g. `--agent openclaw`). Omit to refresh all.
- `--dry-run`    — Print what would be downloaded without writing files.

## Procedure

### Step 1: Read the manifest

```bash
python3 -c "import json; d=json.load(open('manifest.json')); [print(k, v.get('icon','')) for k,v in d['agents'].items()]"
```

### Step 2: Determine source URLs

For each agent, the canonical icon source URL is tracked in `assets/agents/.sources.json`.
If it doesn't exist, fall back to the current `icon` field in `manifest.json`.

### Step 3: Download each icon

For each agent (or the specified `--agent`):

1. Fetch the source URL with `curl -fsSL -o assets/agents/{agent}.{ext}`
2. Detect the file extension from the `Content-Type` header:
   - `image/svg+xml` → `.svg`
   - `image/png`     → `.png`
   - `image/jpeg`    → `.jpg`
   - `image/x-icon` or `image/vnd.microsoft.icon` → `.ico`
3. If the HTTP response is not 200, print a warning and skip that agent
4. If `--dry-run`, print what would be downloaded without writing

### Step 4: Update assets/.sources.json

Write (or update) `assets/agents/.sources.json` with the mapping of each agent to its source URL and detected extension:

```json
{
  "claude":    { "url": "https://...", "ext": "png" },
  "openclaw":  { "url": "https://...", "ext": "png" },
  ...
}
```

### Step 5: Update manifest.json icon fields

For each refreshed agent, set `icon` in `manifest.json` to the raw GitHub URL:

```
https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/assets/agents/{agent}.{ext}
```

### Step 6: Verify

```bash
ls -lh assets/agents/
python3 -c "import json; d=json.load(open('manifest.json')); [print(k, d['agents'][k].get('icon','MISSING')) for k in d['agents']]"
```

### Step 7: Summary

Print a summary:
- Agents refreshed (with old → new byte sizes)
- Agents skipped (errors or dry-run)
- Any icon URL changes detected
