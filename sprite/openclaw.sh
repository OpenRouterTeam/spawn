#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Spawnor - OpenClaw Sprite Setup${NC}"
echo ""

# Check if sprite is installed
if ! command -v sprite &> /dev/null; then
    echo -e "${YELLOW}Installing sprite CLI...${NC}"
    curl -fsSL https://fly.io/install.sh | sh
    export PATH="$HOME/.fly/bin:$PATH"
fi

# Login to sprite if not already logged in
if ! sprite auth whoami &> /dev/null; then
    echo -e "${YELLOW}Please login to sprite:${NC}"
    sprite auth login
fi

# Get sprite name from user
read -p "Enter sprite name: " SPRITE_NAME

# Check if sprite exists, create if not
if sprite list | grep -q "$SPRITE_NAME"; then
    echo -e "${GREEN}Sprite '$SPRITE_NAME' already exists${NC}"
else
    echo -e "${YELLOW}Creating sprite '$SPRITE_NAME'...${NC}"
    sprite create "$SPRITE_NAME"
fi

echo -e "${YELLOW}Setting up sprite environment...${NC}"

# Helper function to run commands on sprite
run_sprite() {
    sprite exec "$SPRITE_NAME" -- bash -c "$1"
}

# 1. Add bun to PATH in .zshrc and .zprofile
echo -e "${YELLOW}Configuring shell environment...${NC}"

PATH_CONFIG='
# [spawnor:path]
export PATH="$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH"
'

# Add to .zprofile for login shells
run_sprite "grep -q '\[spawnor:path\]' ~/.zprofile 2>/dev/null || echo '$PATH_CONFIG' >> ~/.zprofile"

# Add to .zshrc for interactive shells
run_sprite "grep -q '\[spawnor:path\]' ~/.zshrc 2>/dev/null || echo '$PATH_CONFIG' >> ~/.zshrc"

# Switch bash to zsh
BASH_CONFIG='
# [spawnor:bash]
exec /usr/bin/zsh -l
'

run_sprite "grep -q '\[spawnor:bash\]' ~/.bash_profile 2>/dev/null || echo '$BASH_CONFIG' > ~/.bash_profile"
run_sprite "grep -q '\[spawnor:bash\]' ~/.bashrc 2>/dev/null || echo '$BASH_CONFIG' > ~/.bashrc"

# 2. Install openclaw using bun
echo -e "${YELLOW}Installing openclaw...${NC}"
run_sprite "/.sprite/languages/bun/bin/bun install -g openclaw"

# 3. Get OpenRouter API key
echo ""
echo -e "${YELLOW}Opening openrouter.ai/settings/keys to grab API key...${NC}"
echo -e "${YELLOW}Please copy your API key and paste it below${NC}"

# Try to open the browser
if command -v open &> /dev/null; then
    open "https://openrouter.ai/settings/keys"
elif command -v xdg-open &> /dev/null; then
    xdg-open "https://openrouter.ai/settings/keys"
else
    echo "Please open: https://openrouter.ai/settings/keys"
fi

read -sp "Enter your OpenRouter API Key: " OPENROUTER_API_KEY
echo ""

# 4. Inject environment variables
echo -e "${YELLOW}Setting up environment variables...${NC}"

ENV_CONFIG="
# [spawnor:env]
export OPENROUTER_API_KEY=\"$OPENROUTER_API_KEY\"
export ANTHROPIC_API_KEY=\"$OPENROUTER_API_KEY\"
export ANTHROPIC_BASE_URL=\"https://openrouter.ai/api\"
"

run_sprite "grep -q '\[spawnor:env\]' ~/.zshrc 2>/dev/null || echo '$ENV_CONFIG' >> ~/.zshrc"

# 5. Setup openclaw to bypass initial settings
echo -e "${YELLOW}Configuring openclaw...${NC}"

run_sprite "mkdir -p ~/.config/openclaw"

OPENCLAW_CONFIG='{
  "hasCompletedOnboarding": true,
  "defaultProvider": "openrouter",
  "apiKey": "'"$OPENROUTER_API_KEY"'",
  "baseUrl": "https://openrouter.ai/api"
}'

run_sprite "echo '$OPENCLAW_CONFIG' > ~/.config/openclaw/config.json"

echo ""
echo -e "${GREEN}✅ Sprite setup completed successfully!${NC}"
echo ""
echo -e "Connect to your sprite with: ${YELLOW}sprite console $SPRITE_NAME${NC}"
echo ""
