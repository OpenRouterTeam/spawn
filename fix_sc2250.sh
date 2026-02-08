#!/bin/bash
# Script to fix SC2250 warnings by adding braces to variable references
set -euo pipefail

# Find all shell scripts and fix unbraced variables
# This script converts $VAR to ${VAR} but preserves special variables like $@ $* $$ $? $! $- $0-$9

find /home/sprite/spawn -type f -name "*.sh" | while read -r file; do
    echo "Processing: ${file}"

    # Create a backup
    cp "${file}" "${file}.bak"

    # Use sed to add braces to variables
    # Pattern: Match $WORD where WORD is alphanumeric/underscore, not already in braces
    # Exclude special variables: $@, $*, $!, $?, $$, $-, $#, $0-$9
    sed -i -E '
        # Skip lines that are comments
        /^[[:space:]]*#/b

        # Convert $VAR to ${VAR} in various contexts
        # In double quotes: "$VAR" -> "${VAR}"
        s/"\$([A-Za-z_][A-Za-z0-9_]*)([^A-Za-z0-9_{]|$)/"\${\1}\2/g

        # In conditions and assignments: $VAR -> ${VAR}
        s/([^$]|^)\$([A-Za-z_][A-Za-z0-9_]*)([^A-Za-z0-9_{]|$)/\1\${\2}\3/g

        # At start of line: $VAR -> ${VAR}
        s/^\$([A-Za-z_][A-Za-z0-9_]*)([^A-Za-z0-9_{]|$)/\${\1}\2/g
    ' "${file}"

    # Verify the file still has valid syntax
    if bash -n "${file}" 2>/dev/null; then
        rm "${file}.bak"
        echo "  ✓ Fixed: ${file}"
    else
        # Restore backup if syntax check failed
        mv "${file}.bak" "${file}"
        echo "  ✗ Syntax error, restored: ${file}"
    fi
done

echo ""
echo "Done! Checking remaining SC2250 warnings..."
remaining=$(find /home/sprite/spawn -type f -name "*.sh" -exec shellcheck -f gcc {} \; 2>&1 | grep -c SC2250 || true)
echo "Remaining SC2250 warnings: ${remaining}"
