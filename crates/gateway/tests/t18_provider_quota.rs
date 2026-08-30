use mahoquot_gateway::usage::{
    parse_cursor_usage_summary, parse_kiro_usage_summary, parse_zcode_usage_summary,
};

#[test]
fn cursor_kiro_and_zcode_quota_payloads_normalize_to_account_usage() {
    let cursor = parse_cursor_usage_summary(
        &serde_json::json!({
            "membershipType": "pro",
            "billingCycleEnd": "2030-01-01T00:00:00Z",
            "individualUsage": {
                "plan": { "enabled": true, "limit": 1000, "remaining": 250 },
                "onDemand": { "enabled": true, "limit": 100, "remaining": 80 }
            }
        }),
        1_800_000_000,
    );
    assert_eq!(cursor.plan_type.as_deref(), Some("pro"));
    assert_eq!(cursor.groups[0].buckets[0].used_percent, Some(75.0));
    assert_eq!(cursor.groups[0].buckets[1].used_percent, Some(20.0));

    let kiro = parse_kiro_usage_summary(
        &serde_json::json!({
            "usageBreakdownList": [
                { "displayName": "Agentic requests", "currentUsage": 30, "usageLimit": 100, "nextDateReset": 1900000000 }
            ]
        }),
        1_800_000_000,
    );
    assert_eq!(kiro.groups[0].buckets[0].used_percent, Some(30.0));
    assert_eq!(kiro.groups[0].buckets[0].reset_at_unix, Some(1_900_000_000));

    let zcode = parse_zcode_usage_summary(
        &serde_json::json!({
            "data": { "limits": [
                { "type": "TOKENS_LIMIT", "percentage": 41, "nextResetTime": 1900000000 },
                { "type": "TIME_LIMIT", "percentage": 12, "nextResetTime": 1900000100 }
            ]}
        }),
        1_800_000_000,
    );
    assert_eq!(zcode.groups[0].buckets[0].used_percent, Some(41.0));
    assert_eq!(zcode.groups[1].buckets[0].used_percent, Some(12.0));
}
