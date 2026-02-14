assert_api_called "GET" "/me/sshKey" "fetches SSH keys"
assert_api_called "POST" "/cloud/project" "interacts with cloud project"
