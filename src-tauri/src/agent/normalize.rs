//! Provider response normalization.
//!
//! OpenAI-compatible gateways disagree on how text and reasoning travel:
//! `content` may be a string or an array of typed parts, while reasoning may
//! appear as `reasoning_content`, `reasoning`, `thinking_content`,
//! `thinking` or `reasoning_details`. Reading only `.as_str()` drops content
//! (and can leave a reply looking like reasoning-only), so the OpenAI-compatible
//! chat adapters funnel provider payloads through these helpers instead.

use serde_json::Value;

/// Plain text of a `content` field: string, typed part array or text object.
pub(crate) fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty(text.clone()),
        Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(part_text)
                .collect::<Vec<_>>()
                .join("");
            non_empty(joined)
        }
        Value::Object(_) => part_text(value),
        _ => None,
    }
}

/// One typed content part (`{ "type": "text", "text": "..." }`).
fn part_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return non_empty(text.to_string());
    }
    // Some gateways nest the typed parts under a `content` key.
    if let Some(field) = value.get("content") {
        if let Some(text) = content_text(field) {
            return Some(text);
        }
    }
    value
        .as_str()
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

/// Text delta from an OpenAI-compatible streaming `delta` object.
///
/// Only the `content` field is treated as visible text; reasoning aliases must
/// never leak into the answer bubble.
pub(crate) fn delta_text(delta: &Value) -> Option<String> {
    delta.get("content").and_then(content_text)
}

/// Reasoning text from a delta or a full message.
///
/// The keys are deliberately limited to known reasoning aliases so a vendor
/// that puts its whole answer in `content` can never be misread as "thinking".
pub(crate) fn reasoning_text(object: &Value) -> Option<String> {
    for key in [
        "reasoning_content",
        "reasoning",
        "thinking_content",
        "thinking",
        "reasoning_details",
    ] {
        let Some(field) = object.get(key) else {
            continue;
        };
        if let Some(text) = content_text(field) {
            return Some(text);
        }
    }
    None
}

/// Visible text of a non-streaming `message` object.
pub(crate) fn message_text(message: &Value) -> Option<String> {
    message.get("content").and_then(content_text)
}

fn non_empty(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_content_from_strings_arrays_and_objects() {
        assert_eq!(content_text(&json!("hello")).unwrap(), "hello");
        assert_eq!(
            content_text(&json!([
                { "type": "text", "text": "he" },
                { "type": "text", "text": "llo" }
            ]))
            .unwrap(),
            "hello"
        );
        assert_eq!(content_text(&json!({ "text": "hello" })).unwrap(), "hello");
    }

    #[test]
    fn reasoning_aliases_are_read_but_content_is_not() {
        assert_eq!(
            reasoning_text(&json!({ "reasoning_content": "think" })).unwrap(),
            "think"
        );
        assert_eq!(
            reasoning_text(&json!({ "reasoning": { "text": "think" } })).unwrap(),
            "think"
        );
        assert_eq!(
            reasoning_text(&json!({ "reasoning_details": [{ "text": "think" }] })).unwrap(),
            "think"
        );
        assert!(reasoning_text(&json!({ "content": "answer" })).is_none());
    }

    #[test]
    fn nested_content_objects_are_flattened() {
        let message = json!({
            "content": { "content": [{ "type": "text", "text": "answer" }] }
        });
        assert_eq!(message_text(&message).unwrap(), "answer");
    }

    #[test]
    fn delta_content_array_is_not_lost() {
        let delta = json!({
            "content": [{ "type": "text", "text": "answer" }],
            "reasoning_content": "think"
        });
        assert_eq!(delta_text(&delta).unwrap(), "answer");
        assert_eq!(reasoning_text(&delta).unwrap(), "think");
    }

    #[test]
    fn non_streaming_message_with_array_content_keeps_text() {
        let message = json!({
            "content": [
                { "type": "text", "text": "第一段" },
                { "type": "text", "text": "第二段" }
            ],
            "reasoning_content": "思考"
        });
        assert_eq!(message_text(&message).unwrap(), "第一段第二段");
    }
}
