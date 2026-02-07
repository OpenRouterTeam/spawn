# OAuth Fallback Examples

## Scenario 1: OAuth Success (Happy Path)

```bash
$ bash sprite/claude.sh

Claude Code on Sprite

Installing sprite CLI...
Logging in to sprite...
Enter sprite name: my-claude-sprite
Creating sprite 'my-claude-sprite'...
Waiting for sprite to be ready...
Verifying sprite connectivity...
Setting up sprite environment...
Configuring shell environment...
Installing Claude Code...

Authenticating with OpenRouter via OAuth...
Attempting OAuth authentication...
Starting local OAuth server on port 5180...
Opening browser to authenticate with OpenRouter...
Exchanging OAuth code for API key...
✅ Successfully obtained OpenRouter API key via OAuth!

Setting up environment variables...
Configuring Claude Code...

✅ Sprite setup completed successfully!

Starting Claude Code...
```

## Scenario 2: Missing netcat → Manual Entry

```bash
$ bash sprite/openclaw.sh

🚀 Spawn an OpenClaw agent on Sprite

Enter sprite name: my-openclaw-sprite
Setting up sprite environment...
Configuring shell environment...
Installing openclaw...

Authenticating with OpenRouter via OAuth...
Attempting OAuth authentication...
⚠️ netcat (nc) not found - OAuth server unavailable

⚠️ OAuth authentication failed or unavailable
⚠️ You can enter your API key manually instead

Would you like to enter your API key manually? (Y/n): y

Manual API Key Entry
Get your API key from: https://openrouter.ai/settings/keys

Enter your OpenRouter API key: sk-or-v1-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
✅ API key accepted!

Browse models at: https://openrouter.ai/models
Which model would you like to use?
Enter model ID [openrouter/auto]: anthropic/claude-sonnet-4

Setting up environment variables...
Configuring openclaw...

✅ Sprite setup completed successfully!

Starting openclaw...
```

## Scenario 3: Port in Use → Manual Entry

```bash
$ bash sprite/claude.sh

Claude Code on Sprite

Enter sprite name: test-sprite
Setting up sprite environment...

Authenticating with OpenRouter via OAuth...
Attempting OAuth authentication...
Starting local OAuth server on port 5180...
⚠️ Failed to start OAuth server (port may be in use)

⚠️ OAuth authentication failed or unavailable
⚠️ You can enter your API key manually instead

Would you like to enter your API key manually? (Y/n): y

Manual API Key Entry
Get your API key from: https://openrouter.ai/settings/keys

Enter your OpenRouter API key: sk-or-v1-abcd...
✅ API key accepted!

[Setup continues...]
```

## Scenario 4: Invalid API Key Format

```bash
Manual API Key Entry
Get your API key from: https://openrouter.ai/settings/keys

Enter your OpenRouter API key: invalid-key-format
⚠️ Warning: API key format doesn't match expected pattern (sk-or-v1-...)
Use this key anyway? (y/N): n

Enter your OpenRouter API key: sk-or-v1-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
✅ API key accepted!
```

## Scenario 5: User Declines Manual Entry

```bash
⚠️ OAuth authentication failed or unavailable
⚠️ You can enter your API key manually instead

Would you like to enter your API key manually? (Y/n): n
❌ Authentication cancelled by user

[Script exits with error code 1]
```

## Scenario 6: OAuth Timeout

```bash
Authenticating with OpenRouter via OAuth...
Attempting OAuth authentication...
Starting local OAuth server on port 5180...
Opening browser to authenticate with OpenRouter...
[Waiting 2 minutes...]
⚠️ OAuth timeout - no response received

⚠️ OAuth authentication failed or unavailable
⚠️ You can enter your API key manually instead

Would you like to enter your API key manually? (Y/n):
```

## Testing the Fallback Locally

### Test 1: Simulate Missing nc

```bash
# Hide nc from PATH
PATH=/tmp:$PATH bash sprite/claude.sh
```

### Test 2: Use Occupied Port

```bash
# Start a dummy server on port 5180
nc -l 5180 &

# Run the script (will detect port conflict)
bash sprite/openclaw.sh
```

### Test 3: Force Immediate Manual Entry

Modify the OAuth function temporarily:
```bash
# In sprite/lib/common.sh, at start of try_oauth_flow():
return 1  # Force immediate failure

# Then run:
bash sprite/claude.sh
```

## curl | bash Execution

### Remote Execution (After Pushing to GitHub)

```bash
$ curl https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/claude.sh | bash

Claude Code on Sprite

Installing sprite CLI...
[Downloads lib/common.sh from GitHub]
[Continues with normal flow...]
```

The script automatically:
1. Detects it's running via pipe
2. Downloads `lib/common.sh` from GitHub
3. Sources it into memory
4. Proceeds with setup

## API Key Format Reference

**Valid OpenRouter API keys:**
- Format: `sk-or-v1-[64 hexadecimal characters]`
- Example: `sk-or-v1-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`
- Length: 75 characters total

**What happens with other formats:**
- Script warns but allows override
- User must explicitly confirm
- This handles potential future format changes

## Getting an API Key Manually

1. Visit https://openrouter.ai/settings/keys
2. Click "Create API Key"
3. Copy the generated key (starts with `sk-or-v1-`)
4. Paste when prompted

The key can be used immediately without OAuth.
