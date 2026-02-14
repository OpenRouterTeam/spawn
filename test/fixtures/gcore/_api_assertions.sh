assert_api_called "GET" "/cloud/v1/ssh_keys/" "fetches SSH keys"
assert_api_called "POST" "/cloud/v2/instances/" "creates instance"
