# OAuth Fallback Mechanism

## Overview

The spawn scripts now include a robust fallback mechanism for obtaining OpenRouter API keys. If OAuth fails for any reason, users can enter their API key manually.

## How It Works

### Flow Diagram

```
get_openrouter_api_key_oauth()
    │
    ├─> try_oauth_flow()
    │   ├─> Check if nc is available ────> ❌ Fail gracefully
    │   ├─> Start local server ──────────> ❌ Port in use → Fail
    │   ├─> Open browser ────────────────> ✅ OAuth succeeds → Return key
    │   └─> Wait for callback (2 min) ───> ❌ Timeout → Fail
    │
    └─> OAuth failed?
        ├─> Prompt: "Enter API key manually?"
        │   ├─> Yes → get_openrouter_api_key_manual()
        │   │   ├─> User enters key
        │   │   ├─> Validate format
        │   │   └─> Return key
        │   └─> No → Exit with error
        └─> Return API key
```

## Failure Scenarios Handled

### 1. Missing netcat (nc)
```
❌ netcat (nc) not found - OAuth server unavailable
→ Fallback to manual entry
```

**Common on:** Minimal Docker images, some cloud VMs

### 2. Port Already in Use
```
❌ Failed to start OAuth server (port may be in use)
→ Fallback to manual entry
```

**Common when:** Port 5180 is occupied, running multiple instances

### 3. OAuth Timeout
```
❌ OAuth timeout - no response received
→ Fallback to manual entry
```

**Common when:** User closed browser, network issues, firewall blocking

### 4. Exchange Failure
```
❌ Failed to exchange OAuth code
→ Fallback to manual entry
```

**Common when:** Invalid code, OpenRouter API issues

### 5. No Browser Available
OAuth may succeed but is harder without GUI:
```
⚠️ Please open: https://openrouter.ai/auth?callback_url=...
→ User can still complete OAuth or use manual fallback
```

## Manual Entry Process

When fallback is triggered:

```bash
OAuth authentication failed or unavailable
You can enter your API key manually instead

Would you like to enter your API key manually? (Y/n):
```

### If user chooses Yes:

```bash
Manual API Key Entry
Get your API key from: https://openrouter.ai/settings/keys

Enter your OpenRouter API key: sk-or-v1-xxxxx...
✅ API key accepted!
```

### API Key Validation

The script validates the key format:
- Expected format: `sk-or-v1-[64 hex characters]`
- If format doesn't match, user gets a warning:

```bash
⚠️ Warning: API key format doesn't match expected pattern (sk-or-v1-...)
Use this key anyway? (y/N):
```

This catches typos while allowing flexibility for different key formats.

## Benefits

### ✅ Resilience
- Works in environments without `nc`
- Works when ports are occupied
- Works in headless environments

### ✅ User Choice
- Users with existing keys can skip OAuth
- OAuth failures don't abort the entire setup
- Clear prompts guide users through alternatives

### ✅ Security
- API keys are validated before acceptance
- No keys stored on disk during validation
- User must consciously choose to bypass validation

## Usage Examples

### Standard OAuth Success
```bash
$ bash sprite/claude.sh
Attempting OAuth authentication...
Starting local OAuth server on port 5180...
Opening browser to authenticate with OpenRouter...
✅ Successfully obtained OpenRouter API key via OAuth!
```

### Fallback to Manual Entry
```bash
$ bash sprite/claude.sh
Attempting OAuth authentication...
⚠️ netcat (nc) not found - OAuth server unavailable
⚠️ OAuth authentication failed or unavailable
⚠️ You can enter your API key manually instead

Would you like to enter your API key manually? (Y/n): y

Manual API Key Entry
Get your API key from: https://openrouter.ai/settings/keys

Enter your OpenRouter API key: sk-or-v1-abc123...
✅ API key accepted!
```

### User Declines Manual Entry
```bash
Would you like to enter your API key manually? (Y/n): n
❌ Authentication cancelled by user
[Script exits]
```

## Testing

### Test OAuth Fallback Locally
```bash
# Simulate missing nc command
PATH="/tmp/empty:$PATH" bash sprite/claude.sh

# When prompted, test manual entry
```

### Test Manual Entry with Invalid Format
```bash
# Enter a key with wrong format
Enter your OpenRouter API key: invalid-key-format
⚠️ Warning: API key format doesn't match expected pattern
Use this key anyway? (y/N): n
# Can re-enter correct key
```

## Environment Detection

The script automatically detects:
- ✓ Is `nc` available?
- ✓ Can the server start on the specified port?
- ✓ Is the server process still running?
- ✓ Did we receive a callback within timeout?

No user intervention needed - fallback happens automatically when appropriate.

## Future Enhancements

Potential improvements:
- [ ] Retry OAuth with different port if 5180 is in use
- [ ] Support alternative OAuth methods (device flow)
- [ ] Cache API keys securely for reuse
- [ ] Add `--manual` flag to skip OAuth entirely
- [ ] Test API key validity by making a test request

## Comparison with Original

**Before:**
```bash
if [[ ! -f "$code_file" ]]; then
    echo "Timed out waiting for OAuth callback"
    exit 1  # Script terminates ❌
fi
```

**After:**
```bash
if [[ ! -f "$code_file" ]]; then
    log_warn "OAuth timeout - no response received"
    return 1  # Graceful failure, triggers fallback ✅
fi
```
