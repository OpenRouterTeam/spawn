#!/usr/bin/env python3
"""
Refactor Sprite scripts to use inject_env_vars_sprite helper function.
"""
import re
from pathlib import Path

def refactor_sprite_script(filepath: Path):
    """Refactor a sprite script to use inject_env_vars_sprite."""
    content = filepath.read_text()

    # Pattern to match sprite env injection block
    pattern = re.compile(
        r'# Inject environment variables\n'
        r'log_warn "Setting up environment variables\.\.\."\n'
        r'\n'
        r'(?:# Create temp file with env config\n)?'
        r'ENV_TEMP=\$\(mktemp\)\n'
        r'chmod 600 "\$ENV_TEMP"\n'
        r'cat > "\$ENV_TEMP" << EOF\n'
        r'(.*?)'  # Capture env vars
        r'^EOF\n'
        r'\n'
        r'(?:# Upload and append to zshrc\n)?'
        r'sprite exec -s "\$SPRITE_NAME" -file "\$ENV_TEMP:/tmp/env_config" -- bash -c "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"\n'
        r'rm "\$ENV_TEMP"\n',
        re.MULTILINE | re.DOTALL
    )

    match = pattern.search(content)
    if not match:
        print(f"❌ {filepath}: Pattern not found")
        return False

    # Extract env vars from the heredoc
    heredoc_content = match.group(1)
    env_vars = []
    for line in heredoc_content.split('\n'):
        line = line.strip()
        if line.startswith('export '):
            var_line = line.replace('export ', '')
            # Handle variable expansion
            var_line = var_line.replace('"${OPENROUTER_API_KEY}"', '$OPENROUTER_API_KEY')
            var_line = var_line.replace('${OPENROUTER_API_KEY}', '$OPENROUTER_API_KEY')
            var_line = var_line.replace('${MODEL_ID}', '$MODEL_ID')
            # Add quotes around the whole thing
            env_vars.append(f'"{var_line}"')

    if not env_vars:
        print(f"❌ {filepath}: No env vars extracted")
        return False

    # Build replacement
    env_args = ' \\\n    '.join(env_vars)
    replacement = f'''log_warn "Setting up environment variables..."
inject_env_vars_sprite "$SPRITE_NAME" \\
    {env_args}
'''

    # Replace in content
    new_content = pattern.sub(replacement, content)

    if new_content == content:
        print(f"❌ {filepath}: No changes made")
        return False

    filepath.write_text(new_content)
    print(f"✅ {filepath}: Refactored successfully")
    return True

def main():
    repo_root = Path(__file__).parent
    sprite_dir = repo_root / 'sprite'

    if not sprite_dir.exists():
        print("❌ sprite directory not found")
        return 1

    total = 0
    success = 0

    for script in sprite_dir.glob('*.sh'):
        if script.name.startswith('lib'):
            continue
        total += 1
        if refactor_sprite_script(script):
            success += 1

    print(f"\n📊 Refactored {success}/{total} sprite scripts")
    return 0 if success == total else 1

if __name__ == '__main__':
    import sys
    sys.exit(main())
