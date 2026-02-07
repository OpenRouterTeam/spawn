# Interactive Execution via curl

## The Problem with Piping

When you run `curl URL | bash`:
- curl outputs the script to stdout
- stdout is piped to bash's stdin
- bash reads the script from stdin
- **stdin is no longer available for the script to read user input**

This is why `/dev/tty` tricks and other workarounds are needed.

## The Solution: Process Substitution

Use bash process substitution instead of piping:

```bash
bash <(curl -fsSL URL)
```

### How It Works

1. `<(curl -fsSL URL)` - Process substitution creates a temporary file descriptor
2. curl downloads the script and writes to this descriptor
3. bash reads the script from the file descriptor
4. **stdin remains connected to your terminal** for interactive input!

## Comparison

### ❌ Piping (Not Interactive)
```bash
curl URL | bash
# - Script goes to bash's stdin
# - No stdin available for user input
# - Need /dev/tty workarounds
```

### ✅ Process Substitution (Fully Interactive)
```bash
bash <(curl -fsSL URL)
# - Script goes to file descriptor
# - stdin available for user input
# - Works like a normal bash script
```

## Updated Usage Examples

### Claude Code Setup (Interactive)

```bash
# Recommended - Fully interactive
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/claude.sh)

# Alternative - Non-interactive with env vars
SPRITE_NAME=dev-mk1 bash <(curl -fsSL https://raw.githubusercontent.com/.../claude.sh)
```

### OpenClaw Setup (Interactive)

```bash
# Recommended - Fully interactive
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/openclaw.sh)

# Alternative - Non-interactive
SPRITE_NAME=dev-mk1 bash <(curl -fsSL https://raw.githubusercontent.com/.../openclaw.sh)
```

## Why This Is Better

### Process Substitution Advantages

✅ **Fully interactive** - stdin available for prompts
✅ **No special code needed** - Regular `read` commands work
✅ **Cleaner implementation** - No `/dev/tty` fallbacks required
✅ **Works everywhere** - bash/zsh on Linux/macOS
✅ **Better UX** - Users can see prompts and type naturally

### Piping Disadvantages

❌ **Not interactive by default** - stdin consumed by bash
❌ **Requires workarounds** - Need `/dev/tty`, `safe_read()`, etc.
❌ **Fragile** - TTY may not be available (Docker, CI/CD)
❌ **Poor UX** - Needs env vars or fails with cryptic errors

## Implementation Notes

### Current Implementation (Supports Both)

Our scripts now support BOTH approaches:

1. **Process substitution** (recommended):
   ```bash
   bash <(curl -fsSL URL)
   # Uses regular read commands, fully interactive
   ```

2. **Piping** (fallback):
   ```bash
   curl URL | bash
   # Fails gracefully, shows helpful error:
   # "Set SPRITE_NAME environment variable for non-interactive usage"
   ```

3. **Non-interactive** (CI/CD):
   ```bash
   SPRITE_NAME=dev-mk1 curl URL | bash
   # Works without prompts
   ```

### Simplification Opportunity

If we only recommend process substitution, we could:
- Remove `safe_read()` complexity
- Remove environment variable checks
- Use simple `read -p "prompt: " var` everywhere
- Simpler codebase

**But we keep both because:**
- Some tutorials/docs use piping pattern
- CI/CD needs non-interactive mode
- Environment variables are useful anyway
- Graceful degradation is better UX

## Platform Support

### ✅ Supported Platforms

- **bash** (v3.0+) - Linux, macOS, WSL, Git Bash
- **zsh** - macOS, Linux
- Anywhere with `/dev/fd` support

### ❌ Unsupported

- Very old shells without process substitution
- `sh` (POSIX shell) - doesn't support `<(...)`
- Some embedded/minimal environments

**Fallback:** Download the script first:
```bash
curl -fsSL URL -o script.sh
bash script.sh
rm script.sh
```

## Examples

### Test Interactive Mode

```bash
# This will prompt you for sprite name and guide through OAuth
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/claude.sh)
```

Expected output:
```
Claude Code on Sprite

Installing sprite CLI...
Enter sprite name: █
```

### Test with Pre-Set Name

```bash
# Skips sprite name prompt, but OAuth is interactive
SPRITE_NAME=dev-mk1 bash <(curl -fsSL https://raw.githubusercontent.com/.../claude.sh)
```

### Fully Automated

```bash
# No prompts at all
SPRITE_NAME=ci-test \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://raw.githubusercontent.com/.../claude.sh)
```

## Recommended Documentation Update

We should update README.md to show process substitution first:

### Before (Current)
```bash
curl https://openrouter.ai/lab/spawn/sprite/claude.sh | bash
```

### After (Recommended)
```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/claude.sh)
```

This gives users the best experience by default while still supporting non-interactive usage.

## Technical Details

### What is Process Substitution?

In bash, `<(command)` is replaced with a file descriptor path like `/dev/fd/63`:

```bash
# This:
bash <(curl -fsSL URL)

# Becomes:
bash /dev/fd/63
# where /dev/fd/63 contains the curl output
```

### stdin Flow

**With piping:**
```
Terminal stdin → curl (unused)
curl stdout → bash stdin (script)
bash needs input → NO STDIN AVAILABLE ❌
```

**With process substitution:**
```
Terminal stdin → bash stdin (available!) ✅
curl stdout → /dev/fd/63 (script)
bash reads script from /dev/fd/63
bash needs input → reads from stdin ✅
```

## Security Considerations

Both methods have similar security profiles:

```bash
# Review before executing
curl -fsSL URL -o script.sh
cat script.sh  # Review
bash script.sh

# Or review inline
curl -fsSL URL | less  # Review
bash <(curl -fsSL URL)  # Execute
```

**Best practice:** Always review scripts from the internet before executing them.
