# Spawn CLI

The spawn CLI is a command-line tool for launching AI coding agents on cloud providers, pre-configured with OpenRouter.

## Overview

The spawn CLI provides a unified interface to:
- Launch any supported AI agent (Claude Code, Aider, etc.) on any supported cloud provider
- Interactively browse available agents and clouds
- View the agent × cloud compatibility matrix
- Self-update to the latest version

## Architecture

### Three-Tier Installation Strategy

The CLI uses a progressive fallback installation strategy to maximize compatibility:

```
┌─────────────────────────────────────────────────────────┐
│ Method 1: Bun (Preferred)                               │
│ - Fastest execution (native TypeScript runtime)         │
│ - Full TypeScript support with minimal overhead         │
│ - Falls back to compiled binary if global install fails │
└─────────────────────────────────────────────────────────┘
                         ↓ (if bun not found)
┌─────────────────────────────────────────────────────────┐
│ Method 2: npm                                           │
│ - Standard Node.js package manager                      │
│ - Transpiles TypeScript to JavaScript at install time   │
│ - Requires Node.js runtime                              │
└─────────────────────────────────────────────────────────┘
                         ↓ (if npm not found)
┌─────────────────────────────────────────────────────────┐
│ Method 3: Bash Fallback                                 │
│ - Pure bash implementation (spawn.sh)                   │
│ - Zero runtime dependencies except curl + jq/python3    │
│ - Functional subset of TypeScript CLI                   │
└─────────────────────────────────────────────────────────┘
```

**Why this pattern?**
- **Universal compatibility**: Works on any system with bash and curl
- **Optimal performance**: Uses the fastest available runtime (bun > node > bash)
- **Zero friction**: No prerequisite installation required for basic usage
- **Graceful degradation**: Each tier provides full functionality with varying performance characteristics

### Directory Structure

```
cli/
├── src/
│   ├── index.ts        # Entry point (routes commands to handlers)
│   ├── commands.ts     # All command implementations
│   ├── manifest.ts     # Manifest fetching and caching logic
│   └── version.ts      # Version constant
├── install.sh          # Multi-tier installer script
├── spawn.sh            # Bash fallback CLI (full implementation)
├── package.json        # npm package metadata
└── tsconfig.json       # TypeScript configuration
```

### TypeScript Implementation

The TypeScript CLI (`src/*.ts`) provides:

- **Interactive mode**: Terminal UI with prompts for selecting agents and clouds
- **Manifest caching**: Local cache with TTL to minimize network requests
- **Progress indicators**: Spinners and colored output for better UX
- **Error handling**: Structured error messages and exit codes

**Key dependencies:**
- `@clack/prompts` — Interactive terminal prompts
- `picocolors` — Terminal color support

### Bash Fallback Implementation

The bash CLI (`spawn.sh`) is a standalone script that:

- Implements the same commands as the TypeScript version
- Uses `jq` or `python3` for JSON parsing (auto-detects which is available)
- Provides a numbered menu picker for interactive mode
- Maintains local manifest cache with TTL
- Supports all core commands: `list`, `agents`, `clouds`, `run`, `improve`, `update`

**Why maintain both implementations?**
- **Portability**: Bash version works on minimal systems (CI containers, embedded Linux, etc.)
- **Bootstrap**: Used by installer when bun/npm aren't available
- **Reference**: Demonstrates that the protocol is runtime-agnostic

## Installation

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
```

The installer will:
1. Check for `bun` → install via `bun install -g` if found
2. Check for `npm` → install via `npm install -g` if found
3. Fallback → download `spawn.sh` to `$HOME/.local/bin` if neither found

### Environment Variables

- `SPAWN_INSTALL_DIR` — Override install directory (default: `$HOME/.local/bin` for fallback method)

### Manual Installation (Development)

```bash
cd cli
bun install
bun link
```

Or build a standalone binary:

```bash
bun run compile  # Creates ./spawn executable
```

## Usage

### Interactive Mode

```bash
spawn
```

Launches an interactive picker to select an agent and cloud provider.

### Direct Launch

```bash
spawn <agent> <cloud>
```

Examples:
```bash
spawn claude sprite    # Launch Claude Code on Sprite
spawn aider hetzner    # Launch Aider on Hetzner Cloud
```

### Agent Information

```bash
spawn <agent>
```

Show which cloud providers support the specified agent.

Example:
```bash
spawn claude
# Output:
# Claude Code — AI coding agent from Anthropic
#
# Available clouds:
#   Sprite          spawn claude sprite
#   Hetzner Cloud   spawn claude hetzner
```

### List All Combinations

```bash
spawn list
```

Display the full agent × cloud compatibility matrix.

### List Agents

```bash
spawn agents
```

Show all available agents with descriptions.

### List Cloud Providers

```bash
spawn clouds
```

Show all available cloud providers with descriptions.

### Improve Command

```bash
spawn improve [--loop]
```

Clone (or update) the spawn repository and run the `improve.sh` script, which uses Claude to autonomously add missing matrix entries or new agents/clouds.

### Update CLI

```bash
spawn update
```

- **TypeScript version**: Displays update instructions (re-run installer)
- **Bash version**: Self-updates by downloading the latest `spawn.sh`

### Version

```bash
spawn version
```

Display the current CLI version.

## Development

### Prerequisites

- Bun 1.0+ (or Node.js 18+ with npm)
- TypeScript 5.0+

### Running Locally

```bash
bun run dev             # Run TypeScript CLI directly
bun run build           # Build to cli.js
bun run compile         # Compile to standalone binary
```

### Testing

```bash
# Test TypeScript version
bun run dev list
bun run dev agents
bun run dev claude sprite

# Test bash version
bash spawn.sh list
bash spawn.sh agents
bash spawn.sh claude sprite
```

### Code Organization

**`src/index.ts`**
- Command-line argument parsing
- Routes to appropriate command handler
- Minimal logic (just dispatching)

**`src/commands.ts`**
- All command implementations
- Interactive picker UI
- Script execution logic
- Help text

**`src/manifest.ts`**
- Manifest fetching from GitHub
- Local caching with TTL
- Offline fallback to stale cache
- Typed manifest structure

**`src/version.ts`**
- Single source of truth for version number
- Imported by both TypeScript and bash implementations

### Adding a New Command

1. Add command handler in `src/commands.ts`:
   ```typescript
   export async function cmdMyCommand() {
     const manifest = await loadManifest();
     // ... implementation
   }
   ```

2. Add routing in `src/index.ts`:
   ```typescript
   case "mycommand":
     await cmdMyCommand();
     break;
   ```

3. Update help text in `src/commands.ts` → `cmdHelp()`

4. (Optional) Add equivalent implementation to `spawn.sh` for bash fallback

## Design Rationale

### Why TypeScript?

- **Type safety**: Manifest structure is type-checked at compile time
- **Modern async/await**: Clean, readable asynchronous code
- **Rich ecosystem**: Access to high-quality CLI libraries (`@clack/prompts`, etc.)
- **Single codebase**: Same code runs on bun, node, or as a compiled binary

### Why Bash Fallback?

- **Universality**: Bash is available on virtually all Unix-like systems
- **Zero dependencies**: Only requires `curl` and `jq`/`python3` (one of which is usually installed)
- **CI/CD friendly**: Works in minimal Docker containers, GitHub Actions, etc.
- **Educational**: Demonstrates the protocol can be implemented in any language

### Why Bun → npm → Bash Tiering?

- **Performance gradient**: Bun is fastest, npm is widely available, bash always works
- **User experience**: Bun users get instant execution, others get working tool
- **Distribution**: Can be installed via package manager or curl | bash
- **Maintenance**: Single TypeScript codebase serves bun and npm, bash is separate but synchronized

## Manifest Caching

Both implementations cache the manifest locally to reduce network requests:

- **Cache location**: `$XDG_CACHE_HOME/spawn/manifest.json` (or `~/.cache/spawn/manifest.json`)
- **TTL**: 1 hour (3600 seconds)
- **Offline fallback**: If fetch fails, uses stale cache if available
- **Invalidation**: `spawn update` clears the cache

## Script Execution Flow

When you run `spawn <agent> <cloud>`:

1. **Load manifest**: Fetch from GitHub or use cached version
2. **Validate combination**: Check that `matrix["<cloud>/<agent>"]` is `"implemented"`
3. **Download script**: Fetch `https://openrouter.ai/lab/spawn/<cloud>/<agent>.sh`
   - Fallback to GitHub raw URL if OpenRouter CDN fails
4. **Execute**: Pipe script to `bash -c` with inherited stdio
5. **Interactive handoff**: User interacts directly with the spawned agent

## Contributing

### Before Submitting Changes

1. Test both TypeScript and bash versions:
   ```bash
   bun run dev --help
   bash spawn.sh --help
   ```

2. Ensure version numbers are synchronized:
   - `src/version.ts` → `VERSION`
   - `spawn.sh` → `SPAWN_VERSION`
   - `package.json` → `version`

3. Update this README if you add new commands or change behavior

4. Run the installer locally to verify the three-tier strategy works:
   ```bash
   # Test with bun
   bash install.sh

   # Test without bun (rename temporarily)
   mv $(which bun) $(which bun).bak
   bash install.sh
   mv $(which bun).bak $(which bun)
   ```

### Release Checklist

1. Bump version in all three locations (see above)
2. Update CHANGELOG (if exists)
3. Test installer on clean system
4. Tag release: `git tag -a cli-vX.Y.Z -m "Release vX.Y.Z"`
5. Push tag: `git push --tags`

## License

See repository root for license information.
