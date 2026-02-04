#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Claude Code on Sprite${NC}"
echo ""

# Check if sprite is installed, install if not
if ! command -v sprite &> /dev/null; then
    echo -e "${YELLOW}Installing sprite CLI...${NC}"
    curl -fsSL https://sprites.dev/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
fi

# Check if already authenticated
if ! sprite org list &> /dev/null; then
    echo -e "${YELLOW}Logging in to sprite...${NC}"
    sprite login || true
fi

# Ensure user provides a sprite name
read -p "Enter sprite name: " SPRITE_NAME < /dev/tty

# Check if sprite exists, create if not
if sprite list 2>/dev/null | grep -q "^${SPRITE_NAME}$\|^${SPRITE_NAME} "; then
    echo -e "${GREEN}Sprite '$SPRITE_NAME' already exists${NC}"
else
    echo -e "${YELLOW}Creating sprite '$SPRITE_NAME'...${NC}"
    sprite create -skip-console "$SPRITE_NAME" || true
    echo -e "${YELLOW}Waiting for sprite to be ready...${NC}"
    sleep 5
fi

# Verify sprite is accessible
echo -e "${YELLOW}Verifying sprite connectivity...${NC}"
if ! sprite exec -s "$SPRITE_NAME" -- echo "ok" >/dev/null 2>&1; then
    echo -e "${YELLOW}Sprite not ready, waiting longer...${NC}"
    sleep 5
fi

echo -e "${YELLOW}Setting up sprite environment...${NC}"

# Helper function to run commands on sprite
run_sprite() {
    sprite exec -s "$SPRITE_NAME" -- bash -c "$1"
}

# 1. Add bun to PATH in .zshrc and .zprofile
echo -e "${YELLOW}Configuring shell environment...${NC}"

# Create temp file with path config
PATH_TEMP=$(mktemp)
cat > "$PATH_TEMP" << 'EOF'

# [spawn:path]
export PATH="$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH"
EOF

# Upload and append to shell configs
sprite exec -s "$SPRITE_NAME" -file "$PATH_TEMP:/tmp/path_config" -- bash -c "cat /tmp/path_config >> ~/.zprofile && cat /tmp/path_config >> ~/.zshrc && rm /tmp/path_config"
rm "$PATH_TEMP"

# Switch bash to zsh
BASH_TEMP=$(mktemp)
cat > "$BASH_TEMP" << 'EOF'
# [spawn:bash]
exec /usr/bin/zsh -l
EOF

sprite exec -s "$SPRITE_NAME" -file "$BASH_TEMP:/tmp/bash_config" -- bash -c "cat /tmp/bash_config > ~/.bash_profile && cat /tmp/bash_config > ~/.bashrc && rm /tmp/bash_config"
rm "$BASH_TEMP"

# 2. Install Claude Code using claude install (reinitializes properly)
echo -e "${YELLOW}Installing Claude Code...${NC}"
run_sprite "claude install > /dev/null 2>&1"

# 3. Get OpenRouter API key via OAuth
echo ""
echo -e "${YELLOW}Authenticating with OpenRouter via OAuth...${NC}"

CALLBACK_PORT=5180
CALLBACK_URL="http://localhost:${CALLBACK_PORT}/callback"
AUTH_URL="https://openrouter.ai/auth?callback_url=${CALLBACK_URL}"

# Create a temporary directory for the OAuth flow
OAUTH_DIR=$(mktemp -d)
CODE_FILE="$OAUTH_DIR/code"

# Create an inline script that handles the OAuth callback
OAUTH_SCRIPT="$OAUTH_DIR/server.sh"
cat > "$OAUTH_SCRIPT" << 'SERVEREOF'
#!/bin/bash
PORT=$1
CODE_FILE=$2

SUCCESS_HTML='HTTP/1.1 200 OK
Content-Type: text/html
Connection: close

<html><body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e;"><div style="text-align: center; color: #fff;"><h1 style="color: #00d4aa;">Authentication Successful!</h1><p>You can close this window and return to your terminal.</p></div></body></html>'

# Listen for the callback and respond
while true; do
    # Create a temp file for this request
    REQ_FILE=$(mktemp)

    # Use bash's /dev/tcp to handle the connection (works on macOS and Linux)
    exec 3<>/dev/tcp/localhost/$PORT 2>/dev/null || {
        # /dev/tcp not available, fall back to nc with response
        { echo "$SUCCESS_HTML"; cat; } | nc -l $PORT > "$REQ_FILE" 2>/dev/null
        REQUEST=$(head -1 "$REQ_FILE")
        rm -f "$REQ_FILE"

        if [[ "$REQUEST" == *"/callback?code="* ]]; then
            CODE=$(echo "$REQUEST" | sed -n 's/.*code=\([^ &]*\).*/\1/p')
            echo "$CODE" > "$CODE_FILE"
            exit 0
        fi
        continue
    }
done
SERVEREOF
chmod +x "$OAUTH_SCRIPT"

echo -e "${YELLOW}Starting local OAuth server on port ${CALLBACK_PORT}...${NC}"

# Use a simpler nc approach - pipe response while capturing request
(
    SUCCESS_RESPONSE='HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e;"><div style="text-align: center; color: #fff;"><h1 style="color: #00d4aa;">Authentication Successful!</h1><p>You can close this window and return to your terminal.</p></div></body></html>'

    while true; do
        # Listen and capture just the first line of the request, then respond
        RESPONSE_FILE=$(mktemp)
        echo -e "$SUCCESS_RESPONSE" > "$RESPONSE_FILE"

        REQUEST=$(nc -l "$CALLBACK_PORT" < "$RESPONSE_FILE" 2>/dev/null | head -1)
        rm -f "$RESPONSE_FILE"

        if [[ "$REQUEST" == *"/callback?code="* ]]; then
            CODE=$(echo "$REQUEST" | sed -n 's/.*code=\([^ &]*\).*/\1/p')
            echo "$CODE" > "$CODE_FILE"
            break
        fi
    done
) </dev/null &
SERVER_PID=$!

# Give the server a moment to start
sleep 1

# Open browser
echo -e "${YELLOW}Opening browser to authenticate with OpenRouter...${NC}"
if command -v open &> /dev/null; then
    open "$AUTH_URL" </dev/null
elif command -v xdg-open &> /dev/null; then
    xdg-open "$AUTH_URL" </dev/null
else
    echo -e "${YELLOW}Please open: ${AUTH_URL}${NC}"
fi

# Wait for the code file to be created (timeout after 2 minutes)
TIMEOUT=120
ELAPSED=0
while [[ ! -f "$CODE_FILE" ]] && [[ $ELAPSED -lt $TIMEOUT ]]; do
    sleep 1
    ((ELAPSED++))
done

# Kill the background server process
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

if [[ ! -f "$CODE_FILE" ]]; then
    echo -e "${RED}Timed out waiting for OAuth callback${NC}"
    rm -rf "$OAUTH_DIR"
    exit 1
fi

OAUTH_CODE=$(cat "$CODE_FILE")
rm -rf "$OAUTH_DIR"

# Exchange the code for an API key
echo -e "${YELLOW}Exchanging OAuth code for API key...${NC}"
KEY_RESPONSE=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
    -H "Content-Type: application/json" \
    -d "{\"code\": \"$OAUTH_CODE\"}")

OPENROUTER_API_KEY=$(echo "$KEY_RESPONSE" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')

if [[ -z "$OPENROUTER_API_KEY" ]]; then
    echo -e "${RED}Failed to obtain API key: ${KEY_RESPONSE}${NC}"
    exit 1
fi

echo -e "${GREEN}Successfully obtained OpenRouter API key!${NC}"

# 4. Inject environment variables
echo -e "${YELLOW}Setting up environment variables...${NC}"

# Create temp file with env config
ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_SKIP_ONBOARDING="1"
export CLAUDE_CODE_ENABLE_TELEMETRY="0"
EOF

# Upload and append to zshrc
sprite exec -s "$SPRITE_NAME" -file "$ENV_TEMP:/tmp/env_config" -- bash -c "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

# 5. Setup Claude Code settings to bypass initial setup
echo -e "${YELLOW}Configuring Claude Code...${NC}"

run_sprite "mkdir -p ~/.claude"

# Create Claude settings.json via file upload
SETTINGS_TEMP=$(mktemp)
cat > "$SETTINGS_TEMP" << EOF
{
  "theme": "dark",
  "editor": "vim",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": "${OPENROUTER_API_KEY}"
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  }
}
EOF

sprite exec -s "$SPRITE_NAME" -file "$SETTINGS_TEMP:/tmp/claude_settings" -- bash -c "mv /tmp/claude_settings ~/.claude/settings.json"
rm "$SETTINGS_TEMP"

# Create ~/.claude.json global state to skip onboarding and trust dialogs
GLOBAL_STATE_TEMP=$(mktemp)
cat > "$GLOBAL_STATE_TEMP" << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF

sprite exec -s "$SPRITE_NAME" -file "$GLOBAL_STATE_TEMP:/tmp/claude_global" -- bash -c "mv /tmp/claude_global ~/.claude.json"
rm "$GLOBAL_STATE_TEMP"

# Create empty CLAUDE.md to prevent first-run prompts
run_sprite "touch ~/.claude/CLAUDE.md"

echo ""
echo -e "${GREEN}✅ Sprite setup completed successfully!${NC}"
echo ""

# Start Claude Code immediately
echo -e "${YELLOW}Starting Claude Code...${NC}"
sleep 1
clear
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && claude"
