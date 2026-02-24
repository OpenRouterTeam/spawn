# CLI Tests

This directory contains comprehensive tests for the Spawn CLI TypeScript implementation.

## Test Files

### `manifest.test.ts`
Tests for manifest loading, caching, and parsing:
- Network fetching and fallback behavior
- Disk cache TTL and invalidation
- Offline mode with stale cache
- Agent/cloud key extraction
- Matrix status checking
- Implemented combination counting

### `commands.test.ts`
Tests for CLI command handlers:
- `cmdHelp` - Help text display
- `cmdList` - Matrix table rendering
- `cmdAgents` - Agent listing
- `cmdClouds` - Cloud provider listing
- `cmdAgentInfo` - Agent details with available clouds
- `cmdRun` - Script execution with validation and fallback

### `integration.test.ts`
Integration tests for end-to-end workflows:
- Version command
- Manifest caching across loads
- Offline scenarios
- Agent/cloud key extraction
- Matrix validation
- Implementation counting

## Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage (requires coverage provider)
npm test -- --coverage
```

## Test Coverage

Current coverage targets critical paths:
- **manifest.ts**: ~80% coverage of caching, fetching, and parsing logic
- **commands.ts**: ~70% coverage of command handlers and validation
- **integration**: Basic end-to-end scenarios

## Notes

- Tests use vitest for fast execution with Bun/Node compatibility
- Mock manifest data is used to avoid network dependencies
- Cache directory is isolated per test to prevent interference
- Some tests account for local `manifest.json` fallback in project directory
