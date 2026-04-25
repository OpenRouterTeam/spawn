# qa/code-quality (Sonnet)

Scan for dead code, stale references, and quality issues.

Scan for:
- **Dead code**: functions in `sh/shared/*.sh` or `packages/cli/src/` never called → remove
- **Stale references**: code referencing deleted files/paths → fix
- **Python usage**: any `python3 -c` or `python -c` in shell scripts → replace with `bun -e` or `jq`
- **Duplicate utilities**: same helper in multiple TS cloud modules → extract to `shared/`
- **Stale comments**: referencing removed infrastructure → remove/update

Fix each finding. Run `bash -n` on modified .sh, `bun test` for .ts. If changes made: commit, push, open PR "refactor: Remove dead code and stale references". Sign-off: `-- qa/code-quality`
