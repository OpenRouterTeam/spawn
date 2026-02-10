# Spawn CLI

The spawn CLI is a command-line tool for launching AI coding agents on cloud providers, pre-configured with OpenRouter.

## Overview

The spawn CLI provides a unified interface to:
- Launch any supported AI agent (Claude Code, Aider, etc.) on any supported cloud provider
- Interactively browse available agents and clouds
- View the agent × cloud compatibility matrix
- Self-update to the latest version

## Architecture

### Installation Strategy

The installer uses bun to build the TypeScript CLI into a standalone JavaScript file. If bun is not already installed, the installer auto-installs it first (~5 seconds).

**Why bun?**
- **Fast**: Native TypeScript runtime, instant builds
- **Universal**: Auto-installed if missing, works on any system with bash and curl
- **Zero friction**: No prerequisite installation required
- **Single implementation**: One codebase, always feature-complete

### Directory Structure

```
cli/
├── src/
│   ├── index.ts        # Entry point (routes commands to handlers)
│   ├── commands.ts     # All command implementations
│   ├── manifest.ts     # Manifest fetching and caching logic
│   ├── update-check.ts # Auto-update check (once per day)
│   ├── version.ts      # Version constant
│   └── __tests__/      # Test suite (Bun test runner)
├── install.sh          # Installer (auto-installs bun if needed)
├── package.json        # Package metadata and dependencies
└── tsconfig.json       # TypeScript configuration
```

### TypeScript Implementation

The TypeScript CLI (`src/*.ts`) provides:

- **Interactive mode**: Terminal UI with prompts for selecting agents and clouds
- **Manifest caching**: Local cache with TTL to minimize network requests
- **Auto-update check**: Non-intrusive daily version check with notifications
- **Progress indicators**: Spinners and colored output for better UX
- **Error handling**: Structured error messages and exit codes

**Key dependencies:**
- `@clack/prompts` — Interactive terminal prompts
- `picocolors` — Terminal color support

## Installation

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
```

The installer will:
1. Install `bun` if not already present
2. Clone the CLI source
3. Build and install the `spawn` binary to `~/.local/bin`

### Environment Variables

- `SPAWN_INSTALL_DIR` — Override install directory (default: `$HOME/.local/bin`)

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

Displays update instructions (re-run installer).

**Auto-update check**: The CLI automatically checks for updates once per day and displays a notification if a newer version is available. To disable this, set `SPAWN_NO_UPDATE_CHECK=1`.

### Version

```bash
spawn version
```

Display the current CLI version.

## Development

### Prerequisites

- Bun 1.0+

### Running Locally

```bash
bun run dev             # Run TypeScript CLI directly
bun run build           # Build to cli.js
bun run compile         # Compile to standalone binary
```

### Testing

```bash
bun run dev list
bun run dev agents
bun run dev claude sprite
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

## Design Rationale

### Why TypeScript?

- **Type safety**: Manifest structure is type-checked at compile time
- **Modern async/await**: Clean, readable asynchronous code
- **Rich ecosystem**: Access to high-quality CLI libraries (`@clack/prompts`, etc.)
- **Single codebase**: Same code runs on bun, node, or as a compiled binary

### Why Auto-install Bun?

- **Single implementation**: No need to maintain a separate bash CLI
- **Feature parity**: Every user gets the full TypeScript CLI with all features
- **Fast install**: Bun installs in ~5 seconds via `curl -fsSL https://bun.sh/install | bash`
- **Simple maintenance**: One codebase, one source of truth

## Manifest Caching

The CLI caches the manifest locally to reduce network requests:

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

1. Test the CLI:
   ```bash
   bun run dev --help
   ```

2. Ensure version numbers are synchronized:
   - `src/version.ts` → `VERSION`
   - `package.json` → `version`

3. Update this README if you add new commands or change behavior

4. Run the installer locally to verify it works:
   ```bash
   bash install.sh
   ```

### Release Checklist

1. Bump version in both locations (see above)
2. Update CHANGELOG (if exists)
3. Test installer on clean system
4. Tag release: `git tag -a cli-vX.Y.Z -m "Release vX.Y.Z"`
5. Push tag: `git push --tags`

## License

See repository root for license information.
