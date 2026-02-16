assert_api_called "POST" "/lightsail" "creates instance"
assert_log_contains "aws lightsail" "uses AWS CLI"
