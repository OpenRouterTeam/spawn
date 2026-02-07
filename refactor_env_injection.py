#!/usr/bin/env python3
"""
Refactor all cloud scripts to use inject_env_vars_ssh helper function.
This eliminates ~525 lines of duplicate env injection code.
"""
import re
import sys
from pathlib import Path

def extract_env_vars(content: str) -> list[str]:
    """Extract environment variables from the old ENV_TEMP pattern."""
    env_vars = []
    in_heredoc = False

    for line in content.split('\n'):
        if 'cat > "$ENV_TEMP" << EOF' in line or 'cat > "$SETTINGS_TEMP" << EOF' in line:
            in_heredoc = True
            continue
        if in_heredoc and line.strip() == 'EOF':
            break
        if in_heredoc and line.strip().startswith('export '):
            # Extract the export line
            var_line = line.strip().replace('export ', '')
            # Handle variable expansion
            var_line = var_line.replace('"${OPENROUTER_API_KEY}"', '$OPENROUTER_API_KEY')
            var_line = var_line.replace('${OPENROUTER_API_KEY}', '$OPENROUTER_API_KEY')
            var_line = var_line.replace('${MODEL_ID}', '$MODEL_ID')
            env_vars.append(var_line)

    return env_vars

def refactor_ssh_cloud_script(filepath: Path, server_ip_var: str):
    """Refactor a cloud script to use inject_env_vars_ssh."""
    content = filepath.read_text()

    # Pattern 1: Multi-line with comment header (DigitalOcean, Hetzner)
    pattern1 = re.compile(
        r'# (?:\d+\.|\w+:) (?:Inject environment variables|Setting up environment variables).*?\n'
        r'log_warn "Setting up environment variables\.\.\."\n'
        r'\n'
        r'ENV_TEMP=\$\(mktemp\)\n'
        r'chmod 600 "\$ENV_TEMP"\n'
        r'cat > "\$ENV_TEMP" << EOF\n'
        r'(.*?)'  # Capture env vars
        r'^EOF\n'
        r'\n'
        r'upload_file "\$' + server_ip_var + r'" "\$ENV_TEMP" "/tmp/env_config"\n'
        r'run_server "\$' + server_ip_var + r'" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"\n'
        r'rm "\$ENV_TEMP"\n',
        re.MULTILINE | re.DOTALL
    )

    # Pattern 2: Compact without header (Linode, Vultr)
    pattern2 = re.compile(
        r'log_warn "Setting up environment variables\.\.\."\n'
        r'ENV_TEMP=\$\(mktemp\)\n'
        r'chmod 600 "\$ENV_TEMP"\n'
        r'cat > "\$ENV_TEMP" << EOF\n'
        r'(.*?)'  # Capture env vars
        r'^EOF\n'
        r'upload_file "\$' + server_ip_var + r'" "\$ENV_TEMP" "/tmp/env_config"\n'
        r'run_server "\$' + server_ip_var + r'" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"\n'
        r'rm "\$ENV_TEMP"\n',
        re.MULTILINE | re.DOTALL
    )

    # Try pattern1 first, then pattern2
    pattern = pattern1
    match = pattern.search(content)
    if not match:
        pattern = pattern2
        match = pattern.search(content)

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
inject_env_vars_ssh "${server_ip_var}" upload_file run_server \\
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

    # Map cloud providers to their server IP variables
    cloud_configs = {
        'digitalocean': 'DO_SERVER_IP',
        'hetzner': 'HETZNER_SERVER_IP',
        'linode': 'LINODE_SERVER_IP',
        'vultr': 'VULTR_SERVER_IP',
    }

    total = 0
    success = 0

    for cloud, ip_var in cloud_configs.items():
        cloud_dir = repo_root / cloud
        if not cloud_dir.exists():
            continue

        for script in cloud_dir.glob('*.sh'):
            if script.name.startswith('lib'):
                continue
            total += 1
            if refactor_ssh_cloud_script(script, ip_var):
                success += 1

    print(f"\n📊 Refactored {success}/{total} scripts")
    return 0 if success == total else 1

if __name__ == '__main__':
    sys.exit(main())
