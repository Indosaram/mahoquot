use mahoquot_providers::MIMO_SYSTEM_MARKER;

/// Prepend the anti-abuse marker unless a system message already carries it.
/// Without it the free endpoint answers 403 "Illegal access".
pub fn inject_system_marker(body: &mut serde_json::Value) {
    let Some(messages) = body.get("messages").and_then(serde_json::Value::as_array) else {
        return;
    };
    let present = messages.iter().any(|message| {
        message.get("role").and_then(serde_json::Value::as_str) == Some("system")
            && message
                .get("content")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|content| content.contains(MIMO_SYSTEM_MARKER))
    });
    if present {
        return;
    }
    let mut marked = vec![serde_json::json!({
        "role": "system",
        "content": MIMO_SYSTEM_MARKER,
    })];
    marked.extend(messages.iter().cloned());
    body["messages"] = serde_json::Value::Array(marked);
}

pub fn session_affinity_id() -> &'static str {
    use std::sync::OnceLock;
    static SESSION: OnceLock<String> = OnceLock::new();
    SESSION.get_or_init(|| {
        use rand::Rng;
        let suffix: String = rand::thread_rng()
            .sample_iter(rand::distributions::Alphanumeric)
            .take(24)
            .map(char::from)
            .collect();
        format!("ses_{}", suffix.to_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_is_prepended_once_and_never_duplicated() {
        let mut body = serde_json::json!({"messages": [{"role": "user", "content": "hi"}]});
        inject_system_marker(&mut body);
        inject_system_marker(&mut body);
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], MIMO_SYSTEM_MARKER);
        assert_eq!(messages[1]["content"], "hi");
    }

    #[test]
    fn an_existing_system_message_carrying_the_marker_is_left_alone() {
        let mut body = serde_json::json!({
            "messages": [{"role": "system", "content": format!("{MIMO_SYSTEM_MARKER} Extra rules.")}]
        });
        inject_system_marker(&mut body);
        assert_eq!(body["messages"].as_array().expect("messages").len(), 1);
    }

    #[test]
    fn a_body_without_messages_is_untouched() {
        let mut body = serde_json::json!({"input": "responses-shaped"});
        inject_system_marker(&mut body);
        assert_eq!(body, serde_json::json!({"input": "responses-shaped"}));
    }

    #[test]
    fn the_session_affinity_id_is_stable_for_the_process() {
        assert_eq!(session_affinity_id(), session_affinity_id());
        assert!(session_affinity_id().starts_with("ses_"));
    }
}
