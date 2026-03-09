# CLI Tests

This directory contains unit tests for the Spawn CLI TypeScript implementation.

## Test Runner

Tests use **Bun's built-in test runner** (`bun:test`). Do NOT use vitest.

```bash
# Run all tests
bun test

# Run a specific file
bun test src/__tests__/manifest.test.ts
```

## Test Files

### Core manifest
- `manifest.test.ts` — `agentKeys`, `cloudKeys`, `matrixStatus`, `countImplemented`, `loadManifest` (cache/network), `stripDangerousKeys`
- `manifest-integrity.test.ts` — Structural validation: script files exist for implemented entries, no orphans
- `manifest-type-contracts.test.ts` — Field type precision for every agent/cloud in the real manifest
- `manifest-cache-lifecycle.test.ts` — Cache TTL, expiry, forced refresh

### Commands: happy paths
- `cmdrun-happy-path.test.ts` — Successful download, history recording, env var passing
- `cmd-interactive.test.ts` — Interactive agent/cloud selection flow
- `cmd-listing-output.test.ts` — `cmdMatrix`, `cmdAgents`, `cmdClouds` output formatting
- `cmdlast.test.ts` — `cmdLast`: history display and resumption
- `cmdlist-integration.test.ts` — `cmdList` with real history records
- `commands-display.test.ts` — `cmdAgentInfo` (happy path), `cmdHelp`
- `commands-cloud-info.test.ts` — `cmdCloudInfo` display
- `commands-update-download.test.ts` — `cmdUpdate`, script download and execution

### Commands: error paths
- `commands-error-paths.test.ts` — Validation failures, unknown agents/clouds, prompt rejection
- `commands-name-suggestions.test.ts` — Display name typo suggestions in errors
- `commands-swap-resolve.test.ts` — `detectAndFixSwappedArgs`, `resolveAndLog`
- `commands-resolve-run.test.ts` — Display name resolution in `cmdRun`
- `cmdrun-duplicate-detection.test.ts` — `--name` collision detection

### Commands: utilities
- `commands-exported-utils.test.ts` — `parseAuthEnvVars`, `getImplementedAgents`, `getMissingClouds`, `getErrorMessage`, etc.
- `script-failure-guidance.test.ts` — `getScriptFailureGuidance`, `getSignalGuidance`, `buildRetryCommand`
- `download-and-failure.test.ts` — Download fallback pipeline, failure reporting
- `run-path-credential-display.test.ts` — `prioritizeCloudsByCredentials`, run-path validation

### Security
- `security.test.ts` — `validateIdentifier`, `validateScriptContent`, `validatePrompt` (core, boundary, encoding edge cases)
- `security-connection-validation.test.ts` — `validateConnectionIP`, `validateUsername`, `validateServerIdentifier`, `validateLaunchCmd`
- `prompt-file-security.test.ts` — `validatePromptFilePath`, `validatePromptFileStats`

### Infrastructure
- `manifest-cache-lifecycle.test.ts` — Cache lifecycle: write, read, expiry, forced refresh
- `history.test.ts` — History read/write
- `history-trimming.test.ts` — History trimming at size limits
- `clear-history.test.ts` — `clearHistory`, `cmdListClear`
- `ssh-keys.test.ts` — SSH key discovery, generation, fingerprinting
- `update-check.test.ts` — Auto-update check logic
- `with-retry-result.test.ts` — `withRetry`, `wrapSshCall`, Result constructors
- `orchestrate.test.ts` — `runOrchestration`

### Parsing and type utilities
- `parse.test.ts` — `parseJsonWith`
- `fuzzy-key-matching.test.ts` — `findClosestKeyByNameOrKey`, `levenshtein`, `findClosestMatch`, `resolveAgentKey`, `resolveCloudKey`
- `unknown-flags.test.ts` — Unknown flag detection, `KNOWN_FLAGS`, `expandEqualsFlags`
- `custom-flag.test.ts` — `--custom` flag for AWS, GCP, Hetzner, DigitalOcean
- `credential-hints.test.ts` — `credentialHints`
- `cloud-credentials.test.ts` — `hasCloudCredentials`
- `preflight-credentials.test.ts` — `preflightCredentialCheck`

### Cloud-specific
- `aws.test.ts` — AWS credential cache, SigV4 signing helpers
- `billing-guidance.test.ts` — `isBillingError`, `handleBillingError`, `showNonBillingError`
- `cloud-init.test.ts` — `getPackagesForTier`, `needsNode`, `needsBun`, `NODE_INSTALL_CMD`
- `check-entity.test.ts` / `check-entity-messages.test.ts` — Entity validation
- `agent-tarball.test.ts` — `tryTarballInstall`: GitHub Release tarball install, fallback, URL validation
- `gateway-resilience.test.ts` — `startGateway` systemd unit with auto-restart and cron heartbeat
- `do-snapshot.test.ts` — `findSpawnSnapshot`: DigitalOcean snapshot lookup, filtering, error handling
- `ui-utils.test.ts` — `validateServerName`, `validateRegionName`, `toKebabCase`, `sanitizeTermValue`, `jsonEscape`

### Agent-specific
- `junie-agent.test.ts` — Junie CLI agent configuration validation

### Shared helpers
- `shared-helpers.test.ts` — `generateEnvConfig`, `hasStatus`, `toObjectArray`, `toRecord`

### OAuth and auth
- `oauth-code-validation.test.ts` — `OAUTH_CODE_REGEX` format validation

### History (extended)
- `history-spawn-id.test.ts` — Unique spawn IDs, `saveVmConnection`/`saveLaunchCmd` by spawnId, concurrent spawn isolation

### Manifest (extended)
- `icon-integrity.test.ts` — Icon file existence and format validation

### Support files (not test files)
- `test-helpers.ts` — Shared fixtures: `createMockManifest`, `mockClackPrompts`, `setupTestEnvironment`, etc.
- `preload.ts` — Global test setup (temp dir isolation, env sandboxing)
