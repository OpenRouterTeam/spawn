# Testing Non-Interactive Mode

## Quick Tests

### 1. Help Text
```bash
spawn help
# Should show --prompt and --prompt-file options
```

### 2. Basic Prompt Execution (when ready to test with real agent)
```bash
# Test with Claude Code
spawn claude sprite --prompt "echo 'Hello from non-interactive mode'"

# Test with Aider
spawn aider sprite -p "Show me the current directory structure"
```

### 3. Prompt from File
```bash
# Create a prompt file
cat > /tmp/my-prompt.txt << EOF
Please analyze the codebase and identify:
1. Any files with TODO comments
2. Functions longer than 50 lines
3. Missing type annotations
EOF

# Execute with prompt file
spawn claude sprite --prompt-file /tmp/my-prompt.txt
```

### 4. Special Characters
```bash
# Test with quotes
spawn claude sprite --prompt "Fix the bug in 'main.ts' file"

# Test with newlines (via file)
cat > /tmp/multiline.txt << EOF
Please do the following:
1. Run the tests
2. Fix any failures
3. Create a commit
EOF
spawn claude sprite --prompt-file /tmp/multiline.txt
```

### 5. Error Cases

#### Empty prompt
```bash
spawn claude sprite --prompt ""
# Should error: "Prompt cannot be empty"
```

#### Command injection attempt
```bash
spawn claude sprite --prompt "Fix this; rm -rf /"
# Should error: "Prompt blocked: contains potentially dangerous pattern"
```

#### Invalid agent/cloud
```bash
spawn invalid sprite --prompt "test"
# Should error: "Unknown agent: invalid"
```

## Manual Verification Checklist

When testing with a real sprite:

- [ ] Non-interactive mode executes prompt and exits
- [ ] Output is visible in terminal
- [ ] Exit code matches agent's exit code
- [ ] Interactive mode still works (no --prompt flag)
- [ ] Special characters in prompts are handled correctly
- [ ] Long prompts (>1000 chars) work
- [ ] Very long prompts (>10KB) are rejected
- [ ] Command injection patterns are blocked
- [ ] Both --prompt and -p work identically
- [ ] --prompt-file reads file correctly

## CI/CD Integration Example

```bash
#!/bin/bash
# Example CI script using spawn non-interactively

# Run code analysis
spawn claude sprite --prompt "Analyze code for security issues and output a report"

# Check exit code
if [ $? -eq 0 ]; then
    echo "Analysis completed successfully"
else
    echo "Analysis failed"
    exit 1
fi

# Run automated fixes
spawn aider sprite --prompt-file ./ci/fix-instructions.txt

# Commit changes if any
if [ -n "$(git status --porcelain)" ]; then
    git add .
    git commit -m "automated: Apply CI fixes"
fi
```

## Edge Cases

### 1. Prompt with Environment Variables
```bash
# Should NOT expand env vars (they're escaped)
export MY_VAR="dangerous"
spawn claude sprite --prompt 'Fix $MY_VAR'
# Should pass literal string 'Fix $MY_VAR', not 'Fix dangerous'
```

### 2. Very Long Prompts
```bash
# Generate a 5KB prompt
python3 -c "print('Fix ' + 'this line\n' * 100)" > /tmp/long-prompt.txt
spawn claude sprite --prompt-file /tmp/long-prompt.txt
# Should work fine

# Generate a 15KB prompt (exceeds 10KB limit)
python3 -c "print('Fix ' + 'this line\n' * 300)" > /tmp/too-long.txt
spawn claude sprite --prompt-file /tmp/too-long.txt
# Should error: "Prompt exceeds maximum length"
```

### 3. Binary Files
```bash
# Try to use binary file as prompt
spawn claude sprite --prompt-file /bin/bash
# Should either error or produce garbled output (undefined behavior)
```

## Performance Testing

```bash
# Time non-interactive execution
time spawn claude sprite --prompt "Show current directory"

# Compare to interactive mode startup time
# (Note: interactive mode includes agent startup + user interaction time)
```

## Debugging

### Enable verbose logging
```bash
# Set debug environment variables
export SPAWN_DEBUG=1
export SPAWN_POLL_INTERVAL=0.1  # Faster polling for testing

spawn claude sprite --prompt "test"
```

### Check environment variables passed to script
```bash
# Add debug output to sprite/claude.sh temporarily:
echo "SPAWN_PROMPT=${SPAWN_PROMPT:-not set}"
echo "SPAWN_MODE=${SPAWN_MODE:-not set}"
```

## Known Limitations

1. **No streaming output**: Non-interactive mode waits for agent to complete before showing output
2. **No user input**: Agents cannot prompt for user input in non-interactive mode
3. **Agent support**: Only claude and aider currently support non-interactive mode
4. **Cloud support**: Only sprite cloud currently implemented (hetzner, etc. need updates)
5. **Prompt length**: 10KB maximum (design decision to prevent abuse)
6. **Command injection**: Some legitimate prompts may be blocked if they contain patterns like `$()`

## Future Enhancements

1. Add `--timeout` flag to limit execution time
2. Add `--output` flag to save output to file
3. Add `--quiet` flag to suppress informational messages
4. Stream output in real-time instead of buffering
5. Support for multiple prompts via `--prompt-file` with one prompt per line
6. JSON output mode for structured results
