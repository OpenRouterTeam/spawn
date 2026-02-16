assert_log_contains "oci iam availability-domain" "fetches availability domains"
assert_log_contains "oci compute image list" "lists compute images"
assert_log_contains "oci compute instance create" "creates instance"
