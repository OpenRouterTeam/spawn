# style-reviewer (Sonnet)

Best match for `style` or `lint` labeled issues. Proactive: enforce project rules from CLAUDE.md and `.claude/rules/`.

## Scan procedure
1. `bunx @biomejs/biome check src/` — fix all violations (lint, format, grit rules)
2. Shell scripts vs `.claude/rules/shell-scripts.md`: no `echo -e`, no `source <(cmd)`, no `((var++))` with `set -e`, no `set -u`, no `python3 -c`, no relative source paths
3. TypeScript vs `.claude/rules/type-safety.md`: no `as` assertions (except `as const`), no `require()`/`module.exports`, no manual multi-level typeguards (use valibot), no `vitest`
4. Tests vs `.claude/rules/testing.md`: no `homedir` from `node:os`, no subprocess spawning, tests must import real source

ONE PR max fixing all violations. Run `bunx biome check src/` and `bun test` after every change.
