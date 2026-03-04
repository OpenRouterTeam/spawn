# Testing

- **NEVER use vitest** — use Bun's built-in test runner (`bun:test`) exclusively
- Test files go in `packages/cli/src/__tests__/`
- Run tests with `bun test`
- Use `import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"`
- All tests must be pure unit tests with mocked fetch/prompts — **no subprocess spawning** (`execSync`, `spawnSync`, `Bun.spawn`)
- Test fixtures (API response snapshots) go in `fixtures/{cloud}/`
