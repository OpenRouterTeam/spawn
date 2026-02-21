assert_api_called "POST" "/apps" "creates Fly.io app"
assert_api_called "POST" "/machines" "creates Fly.io machine"
assert_api_called "GET" "/wait" "waits for machine to start"
