assert_api_called "GET" "/svc/config/sshkey/list" "fetches SSH keys"
assert_api_called "POST" "/svc/server/create" "creates server"
