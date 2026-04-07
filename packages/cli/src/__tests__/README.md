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
- `pull-history.test.ts` — `cmdPullHistory`, `parseAndMergeChildHistory`: child spawn history import and deduplication
- `cmd-interactive.test.ts` — Interactive agent/cloud selection flow
- `cmd-listing-output.test.ts` — `cmdMatrix`, `cmdAgents`, `cmdClouds` output formatting
- `cmdlast.test.ts` — `cmdLast`: history display and resumption
- `cmdlist-integration.test.ts` — `cmdList` with real history records
- `commands-display.test.ts` — `cmdAgentInfo` (happy path), `cmdHelp`
- `commands-cloud-info.test.ts` — `cmdCloudInfo` display
- `cmd-update-cov.test.ts` — `cmdUpdate`, script download and execution
- `cmd-feedback.test.ts` — `spawn feedback` command: empty message rejection, URL construction
- `cmd-fix.test.ts` — `spawn fix` command: SSH connection repair via DI-injected runScript
- `cmd-link.test.ts` — `spawn link` command: TCP reachability check, SSH agent detection via DI

### Commands: coverage tests
- `cmd-connect-cov.test.ts` — `cmdConnect`, `cmdEnterAgent`, `cmdOpenDashboard` coverage
- `cmd-delete-cov.test.ts` — `cmdDelete` coverage
- `cmd-fix-cov.test.ts` — `cmdFix`, `fixSpawn` coverage
- `cmd-interactive-cov.test.ts` — `cmdInteractive`, `cmdAgentInteractive` coverage
- `cmd-link-cov.test.ts` — `cmdLink` coverage
- `cmd-list-cov.test.ts` — `cmdList` coverage
- `cmd-pick-cov.test.ts` — `cmdPick` coverage
- `cmd-run-cov.test.ts` — `cmdRun`, `cmdRunHeadless` coverage
- `cmd-status-cov.test.ts` — `cmdStatus` coverage
- `cmd-uninstall-cov.test.ts` — `cmdUninstall` coverage

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
- `delete-spinner.test.ts` — `confirmAndDelete`: spinner messages from stderr, final result display
- `steps-flag.test.ts` — `--steps` and `--config` flags: `findUnknownFlag`, `getAgentOptionalSteps`, `validateStepNames`

### Security
- `security.test.ts` — `validateIdentifier`, `validateScriptContent`, `validatePrompt` (core, boundary, encoding edge cases)
- `security-connection-validation.test.ts` — `validateConnectionIP`, `validateUsername`, `validateServerIdentifier`, `validateLaunchCmd`
- `prompt-file-security.test.ts` — `validatePromptFilePath`, `validatePromptFileStats`

### Infrastructure: coverage tests
- `agent-setup-cov.test.ts` — `setupAgent`, `wrapSshCall`, agent setup orchestration coverage
- `aws-cov.test.ts` — AWS module coverage
- `do-cov.test.ts` — DigitalOcean module coverage
- `gcp-cov.test.ts` — GCP module coverage
- `hetzner-cov.test.ts` — Hetzner module coverage
- `history-cov.test.ts` — History module coverage
- `oauth-cov.test.ts` — OAuth module coverage
- `orchestrate-cov.test.ts` — `runOrchestration` coverage
- `sprite-cov.test.ts` — Sprite module coverage
- `ssh-cov.test.ts` — SSH helpers coverage
- `ssh-keys-cov.test.ts` — SSH key management coverage
- `ui-cov.test.ts` — UI helpers coverage
- `update-check-cov.test.ts` — Update check coverage

### Infrastructure
- `history.test.ts` — History read/write
- `history-trimming.test.ts` — History trimming at size limits
- `history-corruption.test.ts` — History corruption recovery: malformed JSON, concurrent writes
- `clear-history.test.ts` — `clearHistory`, `cmdListClear`
- `paths.test.ts` — `getSpawnDir`, `getCacheDir`, `getHistoryPath`, `getSshDir`, path resolution
- `ssh-keys.test.ts` — SSH key discovery, generation, fingerprinting
- `update-check.test.ts` — Auto-update check logic
- `auto-update.test.ts` — `setupAutoUpdate`: systemd service unit generation and orchestration integration; `setupSecurityScan`: cron-based security heuristics and orchestration integration
- `kill-with-timeout.test.ts` — `killWithTimeout`: SIGKILL after grace period, already-exited process handling
- `with-retry-result.test.ts` — `withRetry`, `wrapSshCall`, Result constructors
- `orchestrate.test.ts` — `runOrchestration`
- `shell.test.ts` — `getLocalShell`, `isWindows`, `getInstallCmd`, `getWhichCommand`, `getInstallScriptUrl`: platform-aware shell detection
- `fs-sandbox.test.ts` — Guardrail: verifies test preload sandbox isolates filesystem writes

### Parsing and type utilities
- `parse.test.ts` — `parseJsonWith`
- `picker-cov.test.ts` — `parsePickerInput`: tab-separated picker input parsing, `pickFallback`, `pickToTTY`, `pickToTTYWithActions`
- `fuzzy-key-matching.test.ts` — `findClosestKeyByNameOrKey`, `levenshtein`, `findClosestMatch`, `resolveAgentKey`, `resolveCloudKey`
- `unknown-flags.test.ts` — Unknown flag detection, `KNOWN_FLAGS`, `expandEqualsFlags`
- `custom-flag.test.ts` — `--custom` flag for AWS, GCP, Hetzner, DigitalOcean
- `credential-hints.test.ts` — `credentialHints`
- `cloud-credentials.test.ts` — `hasCloudCredentials`
- `preflight-credentials.test.ts` — `preflightCredentialCheck`
- `result-helpers.test.ts` — `asyncTryCatch`, `asyncTryCatchIf`, `tryCatch`, `tryCatchIf`, `mapResult`, `unwrapOr`
- `config-priority.test.ts` — `loadSpawnConfig` default values, field merging, and override priority
- `spawn-config.test.ts` — `loadSpawnConfig` file parsing, validation, size limits, and null-byte rejection

### Cloud-specific
- `aws.test.ts` — AWS credential cache, SigV4 signing helpers
- `billing-guidance.test.ts` — `isBillingError`, `handleBillingError`, `showNonBillingError`
- `cloud-init.test.ts` — `getPackagesForTier`, `needsNode`, `needsBun`, `NODE_INSTALL_CMD`
- `check-entity.test.ts` / `check-entity-messages.test.ts` — Entity validation
- `agent-tarball.test.ts` — `tryTarballInstall`: GitHub Release tarball install, fallback, URL validation
- `gateway-resilience.test.ts` — `startGateway` systemd unit with auto-restart and cron heartbeat
- `digitalocean-token.test.ts` — DigitalOcean token storage, retrieval, and API client helpers
- `do-min-size.test.ts` — DigitalOcean minimum droplet size enforcement: `slugRamGb` RAM comparison, `AGENT_MIN_SIZE` map
- `do-payment-warning.test.ts` — `ensureDoToken` proactive payment method reminder for first-time DigitalOcean users
- `do-snapshot.test.ts` — `findSpawnSnapshot`: DigitalOcean snapshot lookup, filtering, error handling
- `hetzner-pagination.test.ts` — Hetzner API pagination: multi-page server listing and cursor handling
- `sprite-keep-alive.test.ts` — `installSpriteKeepAlive` download/install, graceful failure, session script wrapping
- `ui-utils.test.ts` — `validateServerName`, `validateRegionName`, `toKebabCase`, `sanitizeTermValue`, `jsonEscape`
- `gcp-shellquote.test.ts` — `shellQuote` GCP-specific quoting edge cases

### Agent-specific
- `junie-agent.test.ts` — Junie CLI agent configuration validation

### Shared helpers
- `shared-helpers.test.ts` — `generateEnvConfig`, `hasStatus`, `toObjectArray`, `toRecord`
- `spawn-skill.test.ts` — `getSpawnSkillPath`, `getSkillContent`, `injectSpawnSkill`, `isAppendMode`: skill injection per agent
- `star-prompt.test.ts` — `maybeShowStarPrompt`: returning-user detection, 30-day cooldown, preference persistence

### OAuth and auth
- `oauth-code-validation.test.ts` — `OAUTH_CODE_REGEX` format validation
- `oauth-pkce.test.ts` — `generateCodeVerifier`, `generateCodeChallenge` PKCE S256 flow

### History (extended)
- `history-spawn-id.test.ts` — Unique spawn IDs, `saveVmConnection`/`saveLaunchCmd` by spawnId, concurrent spawn isolation
- `recursive-spawn.test.ts` — `findDescendants`, `cmdTree`, `mergeChildHistory`, `exportHistory`: recursive child spawn tracking and tree output

### Manifest (extended)
- `icon-integrity.test.ts` — Icon file existence and format validation

### Support files (not test files)
- `test-helpers.ts` — Shared fixtures: `createMockManifest`, `mockClackPrompts`, `setupTestEnvironment`, etc.
- `preload.ts` — Global test setup (temp dir isolation, env sandboxing)
