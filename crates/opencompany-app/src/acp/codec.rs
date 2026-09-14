//! The Agent Client Protocol's wire format: JSON-RPC 2.0, one message per line.
//!
//! ACP over stdio is newline-delimited JSON — not LSP's `Content-Length`
//! framing, and not a stream of concatenated objects. A message never contains
//! a raw newline, so a line is exactly one message.
//!
//! ## What is worth encoding carefully
//!
//! The distinction between a **request** and a **notification** is the presence
//! of `id`, and it is load-bearing in both directions. `session/cancel` is a
//! notification: sending it with an `id` makes a conforming agent try to reply,
//! and waiting for that reply hangs a cancel — the one operation that must not
//! block. Conversely `session/update` arrives *as* a notification, and replying
//! to it would be a protocol error.
//!
//! Both directions carry requests: the client calls `initialize`,
//! `session/new`, `session/prompt`; the agent calls back with
//! `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` and
//! the `terminal/*` family. So this is a peer codec, not a client one.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The id of an in-flight request. ACP permits a string or a number.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    Text(String),
}

/// One JSON-RPC message, in either direction.
///
/// Parsed by *shape* rather than by a tag, because JSON-RPC has no
/// discriminator field: a message with `method` and `id` is a request, with
/// `method` and no `id` a notification, and with `result` or `error` a
/// response. Getting that classification wrong is how a notification ends up
/// awaited forever.
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: RequestId,
        result: Value,
    },
    Error {
        id: Option<RequestId>,
        code: i64,
        message: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not a JSON-RPC message: {0}")]
    Shape(String),
}

/// Parses one line into a message.
pub fn decode(line: &str) -> Result<Message, CodecError> {
    let value: Value = serde_json::from_str(line)?;
    let object = value
        .as_object()
        .ok_or_else(|| CodecError::Shape("expected an object".into()))?;

    let id = object.get("id").and_then(|id| match id {
        Value::Number(n) => n.as_i64().map(RequestId::Number),
        Value::String(s) => Some(RequestId::Text(s.clone())),
        _ => None,
    });

    if let Some(error) = object.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unspecified error")
            .to_string();
        return Ok(Message::Error { id, code, message });
    }

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        // `null` params and absent params mean the same thing to every ACP
        // implementation; normalising here saves every caller an unwrap.
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        return Ok(match id {
            Some(id) => Message::Request {
                id,
                method: method.to_string(),
                params,
            },
            None => Message::Notification {
                method: method.to_string(),
                params,
            },
        });
    }

    match id {
        Some(id) => Ok(Message::Response {
            id,
            // A response with no `result` key is legal for a void method.
            result: object.get("result").cloned().unwrap_or(Value::Null),
        }),
        None => Err(CodecError::Shape(
            "neither a method nor an id: cannot be routed".into(),
        )),
    }
}

/// Renders a request. Always exactly one line.
pub fn encode_request(id: &RequestId, method: &str, params: Value) -> String {
    line(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    }))
}

/// Renders a notification — **no `id`**, which is what makes it one.
pub fn encode_notification(method: &str, params: Value) -> String {
    line(serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    }))
}

/// Renders a successful response to an agent-initiated request.
pub fn encode_response(id: &RequestId, result: Value) -> String {
    line(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Renders a failure response.
///
/// Used when the client refuses something the agent asked for — a path outside
/// the session directory, say. An error is the honest answer there; returning
/// an empty success would have the model believe it had read an empty file.
pub fn encode_error(id: &RequestId, code: i64, message: &str) -> String {
    line(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }))
}

/// Serialises and terminates. A message must not contain a raw newline, and
/// `serde_json` escapes any inside strings, so one line is one message.
fn line(value: Value) -> String {
    let mut out = value.to_string();
    out.push('\n');
    out
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn a_request_is_distinguished_from_a_notification_by_its_id() {
        // The whole classification, in one test. Getting it backwards means
        // either awaiting a reply that will never come, or replying to
        // something that must not be replied to.
        let request =
            decode(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#).unwrap();
        assert!(matches!(request, Message::Request { .. }));

        let notification =
            decode(r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}"#)
                .unwrap();
        assert!(matches!(notification, Message::Notification { .. }));
    }

    #[test]
    fn a_string_id_round_trips() {
        // JSON-RPC allows either; an implementation that assumed numbers would
        // fail to correlate replies from an agent that uses strings.
        let encoded = encode_request(&RequestId::Text("abc".into()), "session/new", Value::Null);
        match decode(encoded.trim()).unwrap() {
            Message::Request { id, method, .. } => {
                assert_eq!(id, RequestId::Text("abc".into()));
                assert_eq!(method, "session/new");
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn a_notification_carries_no_id_on_the_wire() {
        // Not cosmetic: an `id` here makes a conforming agent reply, and a
        // cancel that waits for a reply is a cancel that hangs.
        let encoded = encode_notification("session/cancel", serde_json::json!({"sessionId": "s"}));
        let parsed: Value = serde_json::from_str(encoded.trim()).unwrap();
        assert!(parsed.get("id").is_none());
        assert_eq!(parsed["jsonrpc"], "2.0");
    }

    #[test]
    fn a_response_is_recognised_and_correlated() {
        let decoded = decode(r#"{"jsonrpc":"2.0","id":7,"result":{"sessionId":"s1"}}"#).unwrap();
        match decoded {
            Message::Response { id, result } => {
                assert_eq!(id, RequestId::Number(7));
                assert_eq!(result["sessionId"], "s1");
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn an_error_response_keeps_its_code_and_message() {
        let decoded = decode(
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"no such method"}}"#,
        )
        .unwrap();
        match decoded {
            Message::Error { id, code, message } => {
                assert_eq!(id, Some(RequestId::Number(3)));
                assert_eq!(code, -32601);
                assert_eq!(message, "no such method");
            }
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[test]
    fn absent_and_null_params_are_the_same_thing() {
        let absent = decode(r#"{"jsonrpc":"2.0","method":"x"}"#).unwrap();
        let null = decode(r#"{"jsonrpc":"2.0","method":"x","params":null}"#).unwrap();
        assert_eq!(absent, null);
    }

    #[test]
    fn every_encoding_is_exactly_one_line() {
        // A message containing a newline would desynchronise the reader for the
        // rest of the session — every later message would be misframed.
        let with_newlines = serde_json::json!({ "text": "one\ntwo\nthree" });
        for encoded in [
            encode_request(
                &RequestId::Number(1),
                "session/prompt",
                with_newlines.clone(),
            ),
            encode_notification("session/update", with_newlines.clone()),
            encode_response(&RequestId::Number(1), with_newlines.clone()),
            encode_error(&RequestId::Number(1), -32000, "bad\nthing"),
        ] {
            assert_eq!(encoded.matches('\n').count(), 1, "{encoded:?}");
            assert!(encoded.ends_with('\n'));
            // And it still parses back, so the escaping is real rather than
            // stripped.
            assert!(decode(encoded.trim()).is_ok());
        }
    }

    #[test]
    fn an_unroutable_message_is_refused_rather_than_guessed() {
        // No method and no id: nothing can be done with it, and inventing a
        // classification would put a bogus entry in the pending-request table.
        assert!(decode(r#"{"jsonrpc":"2.0"}"#).is_err());
        assert!(decode("not json at all").is_err());
        assert!(decode("[]").is_err());
    }
}
