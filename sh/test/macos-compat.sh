#!/bin/bash
set -eo pipefail

# macOS Compatibility Linter
# Catches bash 3.2 incompatibilities in shell scripts.
# This script itself is bash 3.2 compatible.
#
# Usage:
#   bash sh/test/macos-compat.sh                    # Scan all .sh files
#   bash sh/test/macos-compat.sh --warn-only        # Always exit 0
#   bash sh/test/macos-compat.sh path/to/file.sh    # Scan specific file(s)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WARN_ONLY=false
FILES_CHECKED=0

# Parse arguments
TARGETS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --warn-only)
            WARN_ONLY=true
            shift
            ;;
        *)
            TARGETS="$TARGETS $1"
            shift
            ;;
    esac
done
TARGETS="$(printf '%s' "$TARGETS" | sed 's/^ //')"

# Check if a path should be excluded
is_excluded() {
    case "$1" in
        */.claude/skills/*) return 0 ;;
        */.git/*) return 0 ;;
        */node_modules/*) return 0 ;;
        */packages/cli/*) return 0 ;;
        */test/macos-compat.sh) return 0 ;;  # Don't lint ourselves
        *) return 1 ;;
    esac
}

# Collect .sh files to check
collect_files() {
    if [ -n "$TARGETS" ]; then
        for _cf_target in $TARGETS; do
            if [ -d "$_cf_target" ]; then
                find "$_cf_target" -name '*.sh' -type f
            elif [ -f "$_cf_target" ]; then
                printf '%s\n' "$_cf_target"
            fi
        done
    else
        find "$REPO_ROOT" -name '*.sh' -type f
    fi
}

# Temp file for all findings
_findings="$(mktemp)"
trap 'rm -f "$_findings"' EXIT

# grep_rule: fast grep-based rule check, appends findings to $_findings
# Filters out comment lines (leading whitespace + #)
# Args: severity rule_id message file relpath pattern
grep_rule() {
    local sev="$1" rule="$2" msg="$3" file="$4" rel="$5" pattern="$6"
    grep -nE "$pattern" "$file" 2>/dev/null | while IFS=: read -r lnum content; do
        # Skip comment lines
        case "$(printf '%s' "$content" | sed 's/^[[:space:]]*//')" in
            '#'*) continue ;;
        esac
        printf '%s %s:%s %s %s\n' "$sev" "$rel" "$lnum" "$rule" "$msg"
    done >> "$_findings" || true
}

# Collect all files
_all_files="$(collect_files | sort)"

# Process each file
while IFS= read -r _f; do
    [ -z "$_f" ] && continue
    is_excluded "$_f" && continue

    FILES_CHECKED=$((FILES_CHECKED + 1))
    _r="$(printf '%s' "$_f" | sed "s|^${REPO_ROOT}/||")"

    # MC001: base64 -w0 with file arg (not stdin redirect) — two-pass
    grep -nE 'base64.*-w0[[:space:]]+["$]' "$_f" 2>/dev/null | while IFS=: read -r lnum content; do
        case "$(printf '%s' "$content" | sed 's/^[[:space:]]*//')" in '#'*) continue ;; esac
        printf '%s' "$content" | grep -q '<[[:space:]]' && continue
        printf 'error %s:%s MC001 %s\n' "$_r" "$lnum" \
            "'base64 -w0 \$file' (GNU-only) — use 'base64 -w0 < \$file' instead"
    done >> "$_findings" || true

    # MC002: non-portable echo flags
    _mc002_msg="'echo"
    _mc002_msg="${_mc002_msg} -e' is not portable — use printf instead"
    grep_rule "error" "MC002" "$_mc002_msg" \
        "$_f" "$_r" 'echo[[:space:]]+-[en]*e[en]*[[:space:]]'

    # MC003: source <(...) or . <(...)
    grep_rule "error" "MC003" "'source <(...)' fails in bash <(curl...) — use eval instead" \
        "$_f" "$_r" '(source|\.)[[:space:]]+<\('

    # MC004: ((var++)) or ((var--)) — post-increment
    grep_rule "error" "MC004" "'((var++))' can fail with set -e — use var=\$((var + 1))" \
        "$_f" "$_r" '\(\([[:space:]]*[a-zA-Z_]+[[:space:]]*(\+\+|--)[[:space:]]*\)\)'

    # MC004: ((++var)) or ((--var)) — pre-increment
    grep_rule "error" "MC004" "'((++var))' can fail with set -e — use var=\$((var + 1))" \
        "$_f" "$_r" '\(\([[:space:]]*(\+\+|--)[[:space:]]*[a-zA-Z_]+[[:space:]]*\)\)'

    # MC005: read -d
    grep_rule "error" "MC005" "'read -d' requires bash 4+ — use alternative approach" \
        "$_f" "$_r" 'read[[:space:]].*-d'

    # MC006: nounset flag (set -u and variants)
    grep_rule "error" "MC006" "'set -u' (nounset) — use \${VAR:-} instead" \
        "$_f" "$_r" 'set[[:space:]]+-[a-zA-Z]*u'

    # MC007: sed -i without '' (warn only) — two-pass
    grep -nE "sed[[:space:]]+-i[[:space:]]" "$_f" 2>/dev/null | while IFS=: read -r lnum content; do
        case "$(printf '%s' "$content" | sed 's/^[[:space:]]*//')" in '#'*) continue ;; esac
        printf '%s' "$content" | grep -qE "sed[[:space:]]+-i[[:space:]]+''" && continue
        printf "warn  %s:%s MC007 'sed -i' without '' may fail on macOS\n" "$_r" "$lnum"
    done >> "$_findings" || true

    # MC008: date %N (nanoseconds)
    grep_rule "error" "MC008" "'date %N' (nanoseconds) not available on macOS" \
        "$_f" "$_r" 'date[[:space:]][^|;]*%N'

    # MC009: local -n / declare -n (namerefs)
    grep_rule "error" "MC009" "'local -n' (namerefs) requires bash 4.3+" \
        "$_f" "$_r" '(local|declare)[[:space:]]+-n[[:space:]]'

    # MC010: declare -A (associative arrays)
    grep_rule "error" "MC010" "'declare -A' (associative arrays) requires bash 4.0+" \
        "$_f" "$_r" 'declare[[:space:]]+-A[[:space:]]'

    # MC011: ${var,,} or ${var^^} (case modification)
    grep_rule "error" "MC011" "'\${var,,}'/'\${var^^}' (case modification) requires bash 4.0+" \
        "$_f" "$_r" '\$\{[a-zA-Z_][a-zA-Z0-9_]*(,,|\^\^)'

    # MC012: |& (pipe stderr)
    grep_rule "error" "MC012" "'|&' (pipe stderr) requires bash 4.0+ — use 2>&1 | instead" \
        "$_f" "$_r" '\|&[^&]'

    # MC013: printf -v (variable assignment via printf)
    grep_rule "error" "MC013" "'printf -v' requires bash 4.0+ — use eval or stdout capture" \
        "$_f" "$_r" 'printf[[:space:]]+-v[[:space:]]'

done <<FILELIST
$_all_files
FILELIST

# Output findings
if [ -s "$_findings" ]; then
    cat "$_findings"
fi

# Count errors and warnings from the findings file
ERRORS=$(grep -c '^error ' "$_findings" 2>/dev/null || true)
WARNINGS=$(grep -c '^warn ' "$_findings" 2>/dev/null || true)

# Summary
printf '\nmacOS compat: %d error(s), %d warning(s) in %d file(s)\n' "$ERRORS" "$WARNINGS" "$FILES_CHECKED"

# Exit code
if [ "$WARN_ONLY" = true ]; then
    exit 0
fi

if [ "$ERRORS" -gt 0 ]; then
    exit 1
fi

exit 0
