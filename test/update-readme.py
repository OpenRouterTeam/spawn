#!/usr/bin/env python3
"""Update README.md matrix cells based on test results.

Usage:
    python3 test/update-readme.py results.txt

Results file format (one per line):
    cloud/agent:pass
    cloud/agent:fail

Only touches cells that have test results; untested combinations stay unchanged.
"""
import json
import re
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 test/update-readme.py RESULTS_FILE", file=sys.stderr)
        sys.exit(1)

    results_file = sys.argv[1]
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    readme_path = os.path.join(repo_root, "README.md")
    manifest_path = os.path.join(repo_root, "manifest.json")

    # Parse results
    results = {}
    with open(results_file) as f:
        for line in f:
            line = line.strip()
            if not line or ":" not in line:
                continue
            combo, status = line.rsplit(":", 1)
            results[combo] = status  # cloud/agent -> pass|fail

    if not results:
        print("No results to apply.")
        return

    # Load manifest to map agent keys to display names
    with open(manifest_path) as f:
        manifest = json.load(f)

    # Build agent key -> name mapping for row matching
    agent_names = {}
    for key, info in manifest["agents"].items():
        agent_names[info["name"]] = key  # "Claude Code" -> "claude"

    # Read README
    with open(readme_path) as f:
        lines = f.readlines()

    # Find the matrix table: header row starts with "| |"
    header_idx = None
    for i, line in enumerate(lines):
        if line.startswith("| |") or line.startswith("| | "):
            header_idx = i
            break

    if header_idx is None:
        print("Could not find matrix table header in README.md", file=sys.stderr)
        sys.exit(1)

    # Parse cloud columns from header
    # Header: | | [Sprite](sprite/) | [Hetzner Cloud](hetzner/) | ...
    header = lines[header_idx]
    header_cells = [c.strip() for c in header.split("|")]
    # header_cells[0] = "", header_cells[1] = "" (row label), header_cells[2:] = cloud cells

    cloud_columns = {}  # cloud_dir -> column index (0-based within cells)
    for col_idx, cell in enumerate(header_cells):
        # Extract dir from [Name](dir/)
        m = re.search(r'\[.*?\]\(([^/)]+)/?[^)]*\)', cell)
        if m:
            cloud_columns[m.group(1)] = col_idx

    # Process data rows (skip header and separator)
    changed = False
    for i in range(header_idx + 2, len(lines)):
        line = lines[i]
        if not line.startswith("|"):
            break

        cells = line.split("|")
        if len(cells) < 3:
            continue

        # Extract agent key from first data cell
        # e.g. " [**Claude Code**](https://claude.ai) " -> "Claude Code"
        row_label = cells[1].strip()
        name_match = re.search(r'\[\*\*(.*?)\*\*\]', row_label)
        if not name_match:
            continue
        display_name = name_match.group(1)
        agent_key = agent_names.get(display_name)
        if not agent_key:
            continue

        row_changed = False
        for cloud_dir, col_idx in cloud_columns.items():
            combo = f"{cloud_dir}/{agent_key}"
            if combo not in results:
                continue
            if col_idx >= len(cells):
                continue

            status = results[combo]
            old_cell = cells[col_idx]
            # Preserve whitespace padding
            stripped = old_cell.strip()
            if status == "pass" and stripped != "\u2713":
                cells[col_idx] = old_cell.replace(stripped, "\u2713") if stripped else " \u2713 "
                row_changed = True
            elif status == "fail" and stripped != "\u2717":
                cells[col_idx] = old_cell.replace(stripped, "\u2717") if stripped else " \u2717 "
                row_changed = True

        if row_changed:
            lines[i] = "|".join(cells)
            if not lines[i].endswith("\n"):
                lines[i] += "\n"
            changed = True

    if changed:
        with open(readme_path, "w") as f:
            f.writelines(lines)
        print(f"README.md updated with {len(results)} test results.")
    else:
        print("No changes needed in README.md.")


if __name__ == "__main__":
    main()
