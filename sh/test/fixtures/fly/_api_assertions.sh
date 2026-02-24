# Fly.io uses TypeScript (bun) for API calls via native fetch() and fly CLI
# for exec/ssh. The mock curl log doesn't capture fetch() calls.
# Assert fly CLI usage instead of curl-based API calls.
assert_log_contains "fly " "uses fly CLI"
assert_log_contains "bun " "uses bun runtime"
