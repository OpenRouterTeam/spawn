# CLI Version Management

**Version bumps are handled automatically by release-please.** Do NOT manually edit the version in `packages/cli/package.json`.

- Use **conventional commit types** to control the bump level:
  - `fix:` → patch bump (0.15.17 → 0.15.18)
  - `feat:` → minor bump (0.15.17 → 0.16.0)
  - `feat!:` or `BREAKING CHANGE:` → major bump (0.15.17 → 1.0.0)
- release-please opens a PR that accumulates unreleased changes and bumps the version
- Merging that PR creates a GitHub release, which triggers the CLI build + publish workflow
- **NEVER commit `packages/cli/cli.js`** — it is a build artifact (already in `.gitignore`). It is produced during releases, not checked into the repo. Do NOT use `git add -f packages/cli/cli.js`.
