# Culture: Embrace Bold Changes

**This is mandatory.** When a change is right, helps the user, and is tasteful — make it. Do not shy away from large-scope work.

- **Do NOT refuse work because it's "too big."** If the user asks for a codebase-wide refactor touching 50+ files, do it. Parallelize with agents. Ship it.
- **Do NOT water down scope.** If the plan says "replace all 119 `as` casts across the codebase," you replace ALL 119, not 5 with a TODO for the rest.
- **Do NOT propose half-measures.** Don't suggest "we could start with just one module" when the user wants the whole thing. The whole thing is the point.
- **Parallelize aggressively.** Use the Task tool to spawn multiple agents working on independent files simultaneously. A 50-file change should NOT be sequential.
- **Fix tests too.** If a new lint rule or code change breaks tests, fix every single test. Don't exclude test files from rules to avoid the work.
- **Verify exhaustively.** After a big change: full lint (0 errors), full test suite (0 failures), full build (succeeds). No partial checks.
