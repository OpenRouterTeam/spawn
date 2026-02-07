# Refactoring Summary

## Overview
Refactored the spawn scripts to share common bash functions via a shared library (`sprite/lib/common.sh`).

## Changes Made

### Created: `sprite/lib/common.sh`
A shared library containing reusable functions:

#### Logging Functions
- `log_info()` - Print green success messages
- `log_warn()` - Print yellow warning messages
- `log_error()` - Print red error messages

#### Sprite Setup Functions
- `ensure_sprite_installed()` - Install sprite CLI if not present
- `ensure_sprite_authenticated()` - Check authentication and prompt login
- `get_sprite_name()` - Prompt user for sprite name
- `ensure_sprite_exists()` - Create sprite if it doesn't exist
- `verify_sprite_connectivity()` - Verify sprite is accessible
- `run_sprite()` - Helper to execute commands on a sprite

#### Environment Setup
- `setup_shell_environment()` - Configure PATH and switch bash to zsh

#### OAuth Functions
- `get_openrouter_api_key_oauth()` - Try OAuth, fallback to manual entry
- `try_oauth_flow()` - Attempt OAuth flow (returns key or fails)
- `get_openrouter_api_key_manual()` - Prompt user for API key manually
- `open_browser()` - Cross-platform browser launcher

**OAuth Fallback Mechanism:**
The OAuth function now gracefully handles failures:
1. Attempts OAuth flow via local server
2. If OAuth fails (no `nc`, port in use, timeout, etc.), prompts for manual entry
3. Validates API key format before accepting
4. User can decline manual entry to abort

## Benefits

### Code Reduction
- **openclaw.sh**: Reduced from 258 lines to 94 lines (-64%)
- **claude.sh**: Reduced from 272 lines to 102 lines (-63%)
- **Total**: Eliminated ~330 lines of duplicate code

### Maintainability
- Bug fixes in common logic only need to be made once
- Consistent behavior across all scripts
- Easier to add new spawn scripts in the future

### Readability
- Scripts now focus on their specific setup logic
- Common operations have descriptive function names
- Clear separation between infrastructure and application setup

## Future Extensibility

Adding new spawn scripts is now straightforward:

```bash
#!/bin/bash
set -e

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

log_info "New Tool on Sprite"

# All the common setup in 4 lines:
ensure_sprite_installed
ensure_sprite_authenticated
SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "$SPRITE_NAME"
setup_shell_environment "$SPRITE_NAME"

# Tool-specific setup here
OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth)
# ... rest of tool-specific configuration
```

## curl | bash Support

The scripts support both local execution and `curl | bash` patterns:

### Local Execution
When run locally, scripts source the library from the local filesystem:
```bash
bash sprite/openclaw.sh
```

### curl | bash Execution
When piped from curl, scripts download the library from GitHub:
```bash
curl https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/openclaw.sh | bash
```

### How It Works
Each script detects its execution context:
- If `${BASH_SOURCE[0]}` is a valid file path → use local `lib/common.sh`
- If running via pipe (`${BASH_SOURCE[0]}` is `-` or `bash`) → download from GitHub

**Key Limitation**: When using `curl | bash`, the script requires internet access to download the shared library. This adds a small dependency but maintains code reusability.

## Testing

Before running in production, test both modes:

```bash
# Test local execution
bash sprite/openclaw.sh
bash sprite/claude.sh

# Test curl | bash (requires pushing to GitHub first)
curl https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/openclaw.sh | bash
```

Both scripts should work identically to the original versions.
