#!/bin/bash
# collaborator-gate.sh — Filter GitHub issues/PRs to collaborator-authored only.
#
# OSS readiness: when the repo goes public, anyone can open issues/PRs.
# The agent team must only engage with collaborators/members — external
# submissions are invisible to the bots.
#
# Usage:
#   source .claude/scripts/collaborator-gate.sh
#   is_collaborator "username"  # returns 0 (true) or 1 (false)
#   list_collaborator_issues    # gh issue list filtered to collaborators only
#
# Caches collaborator list for 10 minutes to avoid API rate limits.

set -eo pipefail

_COLLAB_CACHE_FILE="/tmp/spawn-collaborators-cache"
_COLLAB_CACHE_TTL=600  # 10 minutes
_COLLAB_REPO="OpenRouterTeam/spawn"

# Refresh the collaborator cache if stale or missing
_refresh_collaborator_cache() {
    local now
    now=$(date +%s)

    if [ -f "$_COLLAB_CACHE_FILE" ]; then
        local mtime
        mtime=$(stat -c %Y "$_COLLAB_CACHE_FILE" 2>/dev/null || stat -f %m "$_COLLAB_CACHE_FILE" 2>/dev/null || echo 0)
        local age=$(( now - mtime ))
        if [ "$age" -lt "$_COLLAB_CACHE_TTL" ]; then
            return 0
        fi
    fi

    gh api "repos/${_COLLAB_REPO}/collaborators" --paginate --jq '.[].login' 2>/dev/null | sort -u > "$_COLLAB_CACHE_FILE" || true
}

# Check if a username is a collaborator
is_collaborator() {
    local username="${1:-}"
    if [ -z "$username" ]; then
        return 1
    fi
    _refresh_collaborator_cache
    grep -qx "$username" "$_COLLAB_CACHE_FILE" 2>/dev/null
}

# List open issues filtered to collaborator authors only.
# Passes through all arguments to gh issue list, then filters.
list_collaborator_issues() {
    local issues
    issues=$(gh issue list --repo "$_COLLAB_REPO" --json number,title,labels,author "$@" 2>/dev/null) || return 1

    _refresh_collaborator_cache

    echo "$issues" | jq -c --slurpfile collabs <(jq -R . "$_COLLAB_CACHE_FILE" | jq -s .) \
        '[.[] | select(.author.login as $a | $collabs[0] | index($a))]'
}

# List open PRs filtered to collaborator authors only.
# Passes through all arguments to gh pr list, then filters.
list_collaborator_prs() {
    local prs
    prs=$(gh pr list --repo "$_COLLAB_REPO" --json number,title,labels,author "$@" 2>/dev/null) || return 1

    _refresh_collaborator_cache

    echo "$prs" | jq -c --slurpfile collabs <(jq -R . "$_COLLAB_CACHE_FILE" | jq -s .) \
        '[.[] | select(.author.login as $a | $collabs[0] | index($a))]'
}

# Check if a specific issue was authored by a collaborator
is_issue_from_collaborator() {
    local issue_num="${1:-}"
    if [ -z "$issue_num" ]; then
        return 1
    fi
    local author
    author=$(gh issue view "$issue_num" --repo "$_COLLAB_REPO" --json author --jq '.author.login' 2>/dev/null) || return 1
    is_collaborator "$author"
}
