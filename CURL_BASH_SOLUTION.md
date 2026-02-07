# curl | bash Compatibility

## The Problem

When running scripts via `curl URL | bash`:
```bash
curl https://example.com/script.sh | bash
```

**What happens:**
- Script is piped directly to bash (no file on disk)
- `${BASH_SOURCE[0]}` = `-` or `bash` (not a file path)
- Cannot use `source ./lib/common.sh` (no local files exist)

**Result:** Original refactoring would fail ❌

## The Solution

Scripts now detect their execution context and adapt:

```bash
if [[ -n "${BASH_SOURCE[0]}" && "${BASH_SOURCE[0]}" != "-" && "${BASH_SOURCE[0]}" != "bash" ]]; then
    # Local: source from filesystem
    source "$SCRIPT_DIR/lib/common.sh"
else
    # Remote: download from GitHub
    source <(curl -fsSL https://raw.githubusercontent.com/.../lib/common.sh)
fi
```

## Trade-offs

### ✅ Pros
- Works with both `curl | bash` and local execution
- Maintains code reusability (no duplication)
- Single source of truth for shared functions
- Easy to update (fix once, affects all scripts)

### ⚠️ Cons
- **Network dependency**: curl | bash requires downloading library
- **Single point of failure**: If GitHub is down, scripts fail
- **Cache opportunity**: Library is downloaded every time (not cached)
- **Trust model**: Users must trust both the script AND library URLs

## Alternative Approaches

### Option A: Inline Everything (Original Scripts)
```bash
# Pros: No external dependencies, works offline
# Cons: Code duplication, hard to maintain
```

### Option B: Bootstrap Script
```bash
# Download and cache locally first, then run
curl -fsSL https://url/install.sh | bash

# install.sh does:
mkdir -p /tmp/spawn
cd /tmp/spawn
curl -O lib/common.sh
curl -O openclaw.sh
bash openclaw.sh
```

### Option C: Self-Extracting Archive
```bash
# Embed library as base64 inside script
# Decode and source in memory
```

## Recommendation

**Current solution (hybrid source) is best because:**
1. Maintains developer experience (DRY code)
2. Works with existing `curl | bash` pattern
3. Minimal complexity
4. Standard approach in OSS (see: homebrew, rustup, etc.)

## Security Note

When using `curl | bash` from multiple URLs:
```bash
# User sees this
curl https://site.com/openclaw.sh | bash

# Script internally does this
source <(curl https://raw.githubusercontent.com/.../common.sh)
```

**Recommendation for users:**
```bash
# More secure: Review before running
curl -O https://site.com/openclaw.sh
curl -O https://raw.githubusercontent.com/.../common.sh
cat openclaw.sh common.sh  # Review both files
bash openclaw.sh
```
