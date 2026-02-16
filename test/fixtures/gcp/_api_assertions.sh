assert_api_called "POST" "/compute" "creates compute instance"
assert_log_contains "gcloud compute instances" "uses gcloud CLI"
