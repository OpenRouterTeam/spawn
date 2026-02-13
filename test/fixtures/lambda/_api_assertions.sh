assert_api_called "GET" "/ssh-keys" "fetches SSH keys"
assert_api_called "POST" "/instance-operations/launch" "launches instance"
