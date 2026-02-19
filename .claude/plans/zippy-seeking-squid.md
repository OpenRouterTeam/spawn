# Fix: GitHub CLI auth never works on remote servers

## Problem
`gh auth login` (bare, no flags) tries to open a browser — always fails on headless remote servers. Also, local GitHub tokens are never passed through to the remote.

## Fix (2 files)

### 1. `shared/github-auth.sh` — Use device code flow
Change `gh auth login` → `gh auth login --web -p https -h github.com` (shows URL + code for user to enter in local browser)

### 2. `shared/common.sh` — Token passthrough
- In `prompt_github_auth`: capture local GITHUB_TOKEN or `gh auth token`
- In `offer_github_auth`: pass captured token as env var prefix to remote command

## Verification
- `bash -n` on modified files
- `bash test/run.sh`
