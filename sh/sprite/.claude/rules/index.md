---
globs: sprite/**
---

# Sprite CLI Rules

When building bash scripts that use the Sprite CLI, always follow these guidelines.

## Documentation Reference

Always consult the latest [Sprite CLI documentation](https://docs.sprites.dev/cli/commands/) before writing commands.

## Key Commands

| Command | Purpose |
|---------|---------|
| `sprite login` | Authenticate with Sprites |
| `sprite create <name>` | Create a new sprite |
| `sprite list` / `sprite ls` | List available sprites |
| `sprite exec -s <name> -- <cmd>` | Execute command on sprite (non-interactive) |
| `sprite console -s <name>` | Connect to sprite interactively |
| `sprite destroy <name>` | Delete a sprite |
| `sprite checkpoint create` | Create a checkpoint |
| `sprite restore <version>` | Restore from checkpoint |
| `sprite proxy <port>` | Forward ports from sprite |

## Rules

1. **Use `sprite exec` for non-interactive commands**
   - Run installation/setup commands with `sprite exec -s <sprite> -- bash -c "<command>"`
   - Do NOT use `sprite console` for running automated commands

2. **Use `sprite console` only for interactive sessions**
   - Reserve `sprite console` for when user interaction is needed
   - Place `sprite console` at the very end of setup scripts

3. **Always specify sprite with `-s` flag**
   - Use `-s <sprite-name>` to target a specific sprite explicitly
   - Example: `sprite exec -s my-sprite -- ls -la`

4. **Check sprite existence before creating**
   - Use `sprite list | grep -q "<name>"` to check if a sprite exists
   - Only create if it doesn't exist

5. **Handle login state properly**
   - Check `sprite list &> /dev/null` to verify authentication
   - Use `sprite login || true` to prevent script exit on login issues

6. **Global flags**
   - `--debug[=<file>]` - Enable debug logging
   - `-o, --org <name>` - Specify organization
   - `-s, --sprite <name>` - Specify sprite
   - `-h, --help` - Show help

## Script Pattern

```bash
# 1. Check if sprite CLI is installed
if ! command -v sprite &> /dev/null; then
    curl -fsSL https://sprites.dev/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
fi

# 2. Ensure logged in
if ! sprite list &> /dev/null; then
    sprite login || true
fi

# 3. Create sprite if needed
if ! sprite list | grep -q "$SPRITE_NAME"; then
    sprite create "$SPRITE_NAME"
fi

# 4. Run setup commands via exec
sprite exec -s "$SPRITE_NAME" -- bash -c "echo 'Setting up...'"

# 5. Connect interactively at the very end
sprite console "$SPRITE_NAME"
```
