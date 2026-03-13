# How to Improve Spawn

When run via `./discovery.sh`, your job is to pick ONE of these tasks and execute it:

## 1. Fill a missing matrix entry

Look at `manifest.json` → `matrix` for any `"missing"` entry. To implement it:

- Find the **agent's** existing script on another cloud — it shows the install steps, config files, env vars, and launch command
- The agent scripts are thin bash wrappers that bootstrap bun and run the TypeScript CLI
- The script goes at `sh/{cloud}/{agent}.sh`

**OpenRouter injection is mandatory.** Every agent script MUST:
- Set `OPENROUTER_API_KEY` in the shell environment
- Set provider-specific env vars (e.g., `ANTHROPIC_BASE_URL=https://openrouter.ai/api`)
- These come from the agent's `env` field in `manifest.json`

## 2. Add a new cloud provider (HIGH BAR)

We are currently shipping with **6 curated clouds** (sorted by price):
1. **local** — free (no provisioning)
2. **hetzner** — ~€3.49/mo (cx23)
3. **aws** — $3.50/mo (nano)
4. **digitalocean** — $4/mo (Basic droplet)
5. **gcp** — $7.11/mo (e2-micro)
6. **sprite** — managed cloud VMs

**Do NOT add clouds speculatively.** Every cloud must be manually tested and verified end-to-end before shipping. Adding a cloud that can't be tested is worse than not having it.

**Requirements to add a new cloud:**
- **Prestige or unbeatable pricing** — must be a well-known brand OR beat our cheapest options
- **Must be manually testable** — you need an account and can verify scripts work
- **REST API or CLI with SSH/exec** — no proprietary-only access methods
- **Test coverage is mandatory** — add unit tests in `packages/cli/src/__tests__/`

Steps to add one:
1. Add cloud-specific TypeScript module in `packages/cli/src/{cloud}/`
2. Add an entry to `manifest.json` → `clouds`
3. Add `"missing"` entries to the matrix for every existing agent
4. Implement at least 2-3 agent scripts to prove the lib works
5. Update the cloud's `sh/{cloud}/README.md`
6. **Add test coverage** (mandatory) — add unit tests in `packages/cli/src/__tests__/`

**DO NOT add GPU clouds** (CoreWeave, RunPod, etc.). Spawn agents call remote LLM APIs for inference — they need cheap CPU instances with SSH, not expensive GPU VMs.

## 3. Add a new agent (only with community demand)

Do NOT add agents speculatively. Only add one if there's **real community buzz**:

**Required evidence (at least 2 of these):**
- 1000+ GitHub stars on the agent's repo
- Hacker News post with 50+ points (search: `https://hn.algolia.com/api/v1/search?query=AGENT_NAME`)
- Reddit post with 100+ upvotes in r/LocalLLaMA, r/MachineLearning, or r/ChatGPT
- Explicit user request in this repo's GitHub issues

**Technical requirements:**
- Installable via a single command (npm, pip, curl)
- Accepts API keys via env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`)
- Works with OpenRouter (natively or via `OPENAI_BASE_URL` override)

**ARM builds for native binary agents:**
Agents that ship compiled binaries (Rust, Go, etc.) need separate ARM (aarch64) tarball builds. npm-based agents are arch-independent and only need x86_64 builds. When adding a new agent:
- If it installs via `npm install -g` → x86_64 tarball only (Node handles arch)
- If it installs a pre-compiled binary (curl download, cargo install, go install) → add an ARM entry in `.github/workflows/agent-tarballs.yml` matrix `include` section
- Current native binary agents needing ARM: zeroclaw (Rust), opencode (Go), hermes, claude

To add: same steps as before (manifest.json entry, matrix entries, implement on 1+ cloud, README).

## 4. Respond to GitHub issues

Check `gh issue list --repo OpenRouterTeam/spawn --state open` for user requests:
- If someone requests an agent or cloud, implement it and comment with the PR link
- If something is already implemented, close the issue with a note
- If a bug is reported, fix it

## 5. Extend tests

Tests use Bun's built-in test runner (`bun:test`). When adding a new cloud or agent:
- Add unit tests in `packages/cli/src/__tests__/` with mocked fetch/prompts
- Run `bun test` to verify
