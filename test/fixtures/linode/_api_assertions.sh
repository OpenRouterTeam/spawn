assert_api_called "GET" "/profile/sshkeys" "fetches SSH keys"
assert_api_called "POST" "/linode/instances" "creates instance"
