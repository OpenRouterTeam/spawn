#!/usr/bin/env python3
"""
Fix SC2250 shellcheck warnings by adding braces to variable references.
Converts $VAR to ${VAR} while preserving special variables.
"""

import re
import sys
import subprocess
from pathlib import Path

def should_skip_variable(var_name):
    """Check if a variable should not be braced."""
    # Special shell variables that should remain unbraced
    special_vars = {'@', '*', '!', '?', '$', '-', '#', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'}
    return var_name in special_vars

def add_braces_to_line(line):
    """Add braces to unbraced variable references in a line."""
    # Skip comment lines
    if line.lstrip().startswith('#'):
        return line

    result = []
    i = 0
    while i < len(line):
        if line[i] == '$' and i + 1 < len(line):
            # Check if already braced
            if line[i + 1] == '{':
                # Already braced, skip to closing brace
                result.append(line[i:i+2])
                i += 2
                continue

            # Check for special variables (single character)
            if i + 1 < len(line) and line[i + 1] in '@*!?$-#0123456789':
                result.append(line[i:i+2])
                i += 2
                continue

            # Extract variable name (alphanumeric + underscore)
            var_match = re.match(r'([A-Za-z_][A-Za-z0-9_]*)', line[i+1:])
            if var_match:
                var_name = var_match.group(1)
                if not should_skip_variable(var_name):
                    # Add braces
                    result.append('${' + var_name + '}')
                    i += 1 + len(var_name)
                    continue
                else:
                    result.append(line[i:i+1+len(var_name)])
                    i += 1 + len(var_name)
                    continue

        result.append(line[i])
        i += 1

    return ''.join(result)

def fix_file(file_path):
    """Fix braces in a single file."""
    try:
        with open(file_path, 'r') as f:
            lines = f.readlines()

        fixed_lines = [add_braces_to_line(line) for line in lines]

        # Check if anything changed
        if lines == fixed_lines:
            return False

        # Write fixed content
        with open(file_path, 'w') as f:
            f.writelines(fixed_lines)

        # Verify syntax
        result = subprocess.run(['bash', '-n', str(file_path)],
                              capture_output=True, text=True)
        if result.returncode != 0:
            # Restore original if syntax check failed
            with open(file_path, 'w') as f:
                f.writelines(lines)
            print(f"  ✗ Syntax error in {file_path}, restored original")
            return False

        return True
    except Exception as e:
        print(f"  ✗ Error processing {file_path}: {e}")
        return False

def main():
    spawn_dir = Path('/home/sprite/spawn')
    shell_files = list(spawn_dir.rglob('*.sh'))

    print(f"Found {len(shell_files)} shell scripts")

    fixed_count = 0
    for file_path in shell_files:
        if fix_file(file_path):
            print(f"  ✓ Fixed: {file_path}")
            fixed_count += 1

    print(f"\nFixed {fixed_count} files")

    # Count remaining warnings
    print("\nChecking remaining SC2250 warnings...")
    result = subprocess.run(
        f"find {spawn_dir} -type f -name '*.sh' -exec shellcheck -f gcc {{}} \\; 2>&1 | grep -c SC2250 || true",
        shell=True, capture_output=True, text=True
    )
    print(f"Remaining SC2250 warnings: {result.stdout.strip()}")

if __name__ == '__main__':
    main()
