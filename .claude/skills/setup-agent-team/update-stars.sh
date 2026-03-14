#!/bin/bash
set -eo pipefail

# Update GitHub star counts in manifest.json
# Called as a pre-step in the refactor cycle — quick, no-op if gh is unavailable

REPO_ROOT="${1:-.}"
MANIFEST="${REPO_ROOT}/manifest.json"

if [[ ! -f "${MANIFEST}" ]]; then
    echo "[update-stars] manifest.json not found, skipping"
    exit 0
fi

if ! command -v gh &>/dev/null; then
    echo "[update-stars] gh CLI not available, skipping"
    exit 0
fi

if ! command -v jq &>/dev/null; then
    echo "[update-stars] jq not available, skipping"
    exit 0
fi

TODAY=$(date -u +%Y-%m-%d)
CHANGED=false

for agent in $(jq -r '.agents | keys[]' "${MANIFEST}"); do
    repo=$(jq -r ".agents[\"${agent}\"].repo // empty" "${MANIFEST}")
    if [[ -z "${repo}" ]]; then
        continue
    fi

    stars=$(gh api "repos/${repo}" --jq '.stargazers_count' 2>/dev/null || echo "")
    if [[ -z "${stars}" ]] || [[ "${stars}" = "null" ]]; then
        continue
    fi

    old_stars=$(jq -r ".agents[\"${agent}\"].github_stars // 0" "${MANIFEST}")
    if [[ "${stars}" != "${old_stars}" ]]; then
        echo "[update-stars] ${agent}: ${old_stars} → ${stars}"
        CHANGED=true
    fi

    jq --arg agent "${agent}" \
       --argjson stars "${stars}" \
       --arg date "${TODAY}" \
       '.agents[$agent].github_stars = $stars | .agents[$agent].stars_updated = $date' \
       "${MANIFEST}" > "${MANIFEST}.tmp" && mv "${MANIFEST}.tmp" "${MANIFEST}"
done

if [[ "${CHANGED}" = "true" ]]; then
    echo "[update-stars] Star counts updated"
else
    echo "[update-stars] No changes"
fi
