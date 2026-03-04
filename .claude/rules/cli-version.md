# CLI Version Management

**CRITICAL: Bump the version on every CLI change!**

- **ANY change to `packages/cli/` requires a version bump** in `packages/cli/package.json`
- Use semantic versioning:
  - **Patch** (0.2.X → 0.2.X+1): Bug fixes, minor improvements, documentation
  - **Minor** (0.X.0 → 0.X+1.0): New features, significant improvements
  - **Major** (X.0.0 → X+1.0.0): Breaking changes
- The CLI has auto-update enabled — users get new versions immediately on next run
- Version bumps ensure users always have the latest fixes and features
- **NEVER commit `packages/cli/cli.js`** — it is a build artifact (already in `.gitignore`). It is produced during releases, not checked into the repo. Do NOT use `git add -f packages/cli/cli.js`.
