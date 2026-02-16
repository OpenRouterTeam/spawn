assert_api_called "POST" "/workspaces" "creates workspace"
assert_log_contains "daytona" "uses daytona CLI"
