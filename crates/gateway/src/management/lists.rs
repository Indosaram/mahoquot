use serde_json::Value;

use super::scalar_table::Refusal;

/// Replace a list wholesale. Upstream accepts either a bare JSON array or the
/// same array wrapped as `{"items": [...]}`, and treats an empty `items` as a
/// bad body rather than a request to clear.
pub fn replace(target: &mut Vec<String>, body: &Value) -> Result<(), Refusal> {
    if let Ok(array) = serde_json::from_value::<Vec<String>>(body.clone()) {
        *target = array;
        return Ok(());
    }
    match body
        .get("items")
        .and_then(|i| serde_json::from_value::<Vec<String>>(i.clone()).ok())
    {
        Some(items) if !items.is_empty() => {
            *target = items;
            Ok(())
        }
        _ => Err(Refusal::InvalidBody),
    }
}

/// Edit one entry. `{"index","value"}` overwrites in place; `{"old","new"}`
/// replaces the first match and otherwise appends. Anything else is
/// "missing fields", which upstream distinguishes from "invalid body".
pub fn edit(target: &mut Vec<String>, body: &Value) -> Result<(), Refusal> {
    let index = body.get("index").and_then(Value::as_i64);
    let value = body.get("value").and_then(Value::as_str);
    if let (Some(index), Some(value)) = (index, value) {
        if index >= 0 && (index as usize) < target.len() {
            target[index as usize] = value.to_string();
            return Ok(());
        }
    }

    let old = body.get("old").and_then(Value::as_str);
    let new = body.get("new").and_then(Value::as_str);
    if let (Some(old), Some(new)) = (old, new) {
        if let Some(slot) = target.iter_mut().find(|entry| entry.as_str() == old) {
            *slot = new.to_string();
        } else {
            target.push(new.to_string());
        }
        return Ok(());
    }

    Err(Refusal::Message("missing fields"))
}

/// Remove by `?index=` or `?value=`; upstream refuses when neither is usable.
pub fn remove(
    target: &mut Vec<String>,
    index: Option<&str>,
    value: Option<&str>,
) -> Result<(), Refusal> {
    if let Some(index) = index.and_then(|raw| raw.parse::<usize>().ok()) {
        if index < target.len() {
            target.remove(index);
            return Ok(());
        }
    }
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(wanted) => {
            target.retain(|entry| entry.trim() != wanted);
            Ok(())
        }
        None => Err(Refusal::Message("missing index or value")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replace_accepts_a_bare_array_and_the_items_wrapper() {
        // given both accepted shapes
        let mut bare = vec!["old".to_string()];
        let mut wrapped = vec!["old".to_string()];
        assert!(replace(&mut bare, &json!(["a", "b"])).is_ok());
        assert!(replace(&mut wrapped, &json!({ "items": ["a", "b"] })).is_ok());
        // then both replace the list entirely
        assert_eq!(bare, vec!["a", "b"]);
        assert_eq!(wrapped, vec!["a", "b"]);
    }

    #[test]
    fn replace_refuses_an_empty_items_wrapper() {
        // given an items wrapper with nothing in it
        let mut target = vec!["keep".to_string()];
        // when replaced
        let result = replace(&mut target, &json!({ "items": [] }));
        // then it is refused and the list is untouched
        assert!(matches!(result, Err(Refusal::InvalidBody)));
        assert_eq!(target, vec!["keep"]);
    }

    #[test]
    fn edit_overwrites_by_index() {
        // given a list and an index edit
        let mut target = vec!["a".to_string(), "b".to_string()];
        assert!(edit(&mut target, &json!({ "index": 1, "value": "z" })).is_ok());
        // then that slot changed
        assert_eq!(target, vec!["a", "z"]);
    }

    #[test]
    fn edit_replaces_a_match_and_appends_when_absent() {
        // given an old/new edit that matches
        let mut target = vec!["a".to_string()];
        assert!(edit(&mut target, &json!({ "old": "a", "new": "b" })).is_ok());
        assert_eq!(target, vec!["b"]);
        // when the old value is absent, the new one is appended
        assert!(edit(&mut target, &json!({ "old": "zz", "new": "c" })).is_ok());
        assert_eq!(target, vec!["b", "c"]);
    }

    #[test]
    fn edit_without_usable_fields_reports_missing_fields() {
        // given a body with neither pair
        let mut target = vec!["a".to_string()];
        // when edited
        let result = edit(&mut target, &json!({ "nonsense": 1 }));
        // then upstream's distinct message is used
        assert!(matches!(result, Err(Refusal::Message("missing fields"))));
    }

    #[test]
    fn remove_by_index_and_by_value() {
        // given removal by index
        let mut by_index = vec!["a".to_string(), "b".to_string()];
        assert!(remove(&mut by_index, Some("0"), None).is_ok());
        assert_eq!(by_index, vec!["b"]);
        // and removal by value, which drops every match
        let mut by_value = vec!["a".to_string(), "b".to_string(), "a".to_string()];
        assert!(remove(&mut by_value, None, Some("a")).is_ok());
        assert_eq!(by_value, vec!["b"]);
    }

    #[test]
    fn remove_without_either_query_is_refused() {
        // given no index and no value
        let mut target = vec!["a".to_string()];
        // when removing
        let result = remove(&mut target, None, None);
        // then upstream's message is returned and nothing is dropped
        assert!(matches!(
            result,
            Err(Refusal::Message("missing index or value"))
        ));
        assert_eq!(target, vec!["a"]);
    }
}
