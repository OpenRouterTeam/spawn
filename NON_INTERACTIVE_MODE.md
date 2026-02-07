# Non-Interactive Mode

## The Problem

When running scripts via `curl URL | bash`, the script is piped directly to bash without access to a TTY (terminal). This causes failures when trying to read user input:

```bash
$ curl https://raw.githubusercontent.com/.../claude.sh | bash
/dev/fd/63: line 42: /dev/tty: No such device or address
```

**Why this happens:**
- `curl | bash` pipes the script content to bash's stdin
- `/dev/tty` doesn't exist in this context
- `read` commands fail with "No such device or address"

## The Solution

We implemented a `safe_read()` function that:

1. Checks if `/dev/tty` is available
2. Falls back to stdin if available
3. Returns a helpful error message if neither works
4. Suggests using environment variables for non-interactive usage

### Environment Variable Support

Scripts now support environment variables for non-interactive execution:

```bash
# Required
SPRITE_NAME=dev-mk1 \
  curl URL | bash

# Optional (skips OAuth)
SPRITE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  curl URL | bash
```

## Implementation Details

### safe_read() Function

```bash
safe_read() {
    local prompt="$1"
    local result=""

    # Try to read from TTY if available
    if [[ -c /dev/tty ]]; then
        read -p "$prompt" result < /dev/tty
    elif [[ -t 0 ]]; then
        # stdin is a terminal
        read -p "$prompt" result
    else
        # No interactive input available
        log_error "Cannot read input: no TTY available"
        return 1
    fi

    echo "$result"
}
```

### get_sprite_name() Function

```bash
get_sprite_name() {
    # Check if SPRITE_NAME is already set in environment
    if [[ -n "$SPRITE_NAME" ]]; then
        log_info "Using sprite name from environment: $SPRITE_NAME"
        echo "$SPRITE_NAME"
        return 0
    fi

    # Try to read interactively
    local sprite_name=$(safe_read "Enter sprite name: ")
    if [[ -z "$sprite_name" ]]; then
        log_error "Sprite name is required"
        log_warn "Set SPRITE_NAME environment variable for non-interactive usage:"
        log_warn "  SPRITE_NAME=dev-mk1 curl ... | bash"
        return 1
    fi

    echo "$sprite_name"
}
```

## Testing

### Test Interactive Mode

```bash
# Will prompt for sprite name
curl https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/claude.sh | bash
```

### Test Non-Interactive Mode

```bash
# Provides all inputs via environment
SPRITE_NAME=test-sprite \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  curl https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/claude.sh | bash
```

### Test Local Execution

```bash
# Interactive
bash sprite/claude.sh

# Non-interactive
SPRITE_NAME=test-sprite bash sprite/claude.sh
```

## Error Messages

### Without SPRITE_NAME in non-interactive mode:

```
❌ Cannot read input: no TTY available
❌ Sprite name is required
⚠️ Set SPRITE_NAME environment variable for non-interactive usage:
⚠️   SPRITE_NAME=dev-mk1 curl ... | bash
```

### Without OAuth capability in non-interactive mode:

```
⚠️ netcat (nc) not found - OAuth server unavailable
⚠️ OAuth authentication failed or unavailable
⚠️ You can enter your API key manually instead
❌ Cannot prompt for manual entry in non-interactive mode
⚠️ Set OPENROUTER_API_KEY environment variable for non-interactive usage
```

## Use Cases

### CI/CD Pipelines

```yaml
# GitHub Actions example
- name: Setup Sprite
  run: |
    SPRITE_NAME=ci-test-${{ github.run_id }} \
    OPENROUTER_API_KEY=${{ secrets.OPENROUTER_API_KEY }} \
      curl -fsSL https://raw.githubusercontent.com/.../claude.sh | bash
```

### Automation Scripts

```bash
#!/bin/bash
# setup-dev-env.sh

export SPRITE_NAME="dev-$(whoami)"
export OPENROUTER_API_KEY="sk-or-v1-xxxxx"

curl -fsSL https://raw.githubusercontent.com/.../claude.sh | bash
```

### Docker Containers

```dockerfile
FROM ubuntu:latest

ENV SPRITE_NAME=docker-dev
ENV OPENROUTER_API_KEY=sk-or-v1-xxxxx

RUN curl -fsSL https://raw.githubusercontent.com/.../claude.sh | bash
```

## Comparison: Before vs After

### Before (Broken in non-interactive mode)

```bash
get_sprite_name() {
    read -p "Enter sprite name: " SPRITE_NAME < /dev/tty
    echo "$SPRITE_NAME"
}
# ERROR: /dev/tty: No such device or address
```

### After (Works in both modes)

```bash
get_sprite_name() {
    # Check environment first
    if [[ -n "$SPRITE_NAME" ]]; then
        echo "$SPRITE_NAME"
        return 0
    fi

    # Try interactive input
    local sprite_name=$(safe_read "Enter sprite name: ")
    [[ -n "$sprite_name" ]] || return 1

    echo "$sprite_name"
}
# SUCCESS: Uses env var or prompts interactively
```

## Related Files

- `sprite/lib/common.sh` - Contains `safe_read()` and updated functions
- `sprite/openclaw.sh` - Updated to use `safe_read()` for model selection
- `sprite/claude.sh` - Already uses library functions (no changes needed)
- `README.md` - Documents non-interactive usage

## Future Improvements

Potential enhancements:
- [ ] Add `--non-interactive` flag for explicit mode control
- [ ] Support reading from config files (e.g., `.spawnrc`)
- [ ] Add `--help` flag to show all environment variables
- [ ] Validate environment variables before starting
- [ ] Add dry-run mode to show what would be executed
