//! The ACP client, driven against a real subprocess.
//!
//! `tests/fixtures/fake-agent.py` is a separate process speaking the wire
//! format over actual pipes — not a mock of this crate's types. That
//! distinction is the point: a mock would exercise the request/response
//! plumbing and hide everything that actually breaks, namely the framing, the
//! reader task's routing, notifications arriving *interleaved with* the reply
//! they precede, and what a vanished harness does to a waiting caller.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use opencompany_desktop_lib::acp::client::{
    AcpClient, AcpError, AutoApprovingFiles, ClientHandler, ConfinedFiles,
};
use opencompany_desktop_lib::acp::confine::Confinement;
use serde_json::Value;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-agent.py")
}

/// Collects `session/update` payloads as they arrive.
#[derive(Clone, Default)]
struct Updates(Arc<Mutex<Vec<Value>>>);

impl Updates {
    fn sink(&self) -> Arc<dyn Fn(Value) + Send + Sync> {
        let inner = Arc::clone(&self.0);
        Arc::new(move |value| inner.lock().unwrap().push(value))
    }
    /// The text of every `agent_message_chunk`, joined.
    fn said(&self) -> String {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|u| u["update"]["sessionUpdate"] == "agent_message_chunk")
            .filter_map(|u| u["update"]["content"]["text"].as_str())
            .collect::<Vec<_>>()
            .join("")
    }
    fn kinds(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|u| u["update"]["sessionUpdate"].as_str().map(str::to_string))
            .collect()
    }
}

async fn connect(root: &Path, handler: Arc<dyn ClientHandler>) -> (AcpClient, Updates) {
    let updates = Updates::default();
    let client = AcpClient::spawn(
        "python3",
        &[fixture().to_str().unwrap()],
        root,
        &[],
        handler,
        updates.sink(),
    )
    .await
    .expect("the fake agent starts");
    client.initialize().await.expect("initialize");
    (client, updates)
}

fn confined(root: &Path, auto: Option<&str>) -> Arc<dyn ClientHandler> {
    Arc::new(ConfinedFiles::new(
        Confinement::new(root).unwrap(),
        auto.map(str::to_string),
    ))
}

#[tokio::test]
async fn a_session_runs_a_turn_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, _updates) = connect(&root, confined(&root, None)).await;

    let session = client.new_session(&root).await.expect("session/new");
    assert_eq!(session, "sess-1");
    assert_eq!(client.prompt(&session, "hello").await.unwrap(), "end_turn");
}

#[tokio::test]
async fn updates_that_arrive_before_the_reply_are_not_lost() {
    // The reason there is one reader task rather than a read-until-my-reply
    // loop. For ACP that is not an edge case: `session/prompt`'s answer comes
    // *last*, after everything the turn streamed, so a naive client loses the
    // entire turn and keeps only its stop reason.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();

    client.prompt(&session, "stream").await.unwrap();

    assert_eq!(
        updates.kinds(),
        vec!["agent_thought_chunk", "tool_call", "agent_message_chunk"],
        "every update must arrive, in order"
    );
    assert_eq!(updates.said(), "done");
}

#[tokio::test]
async fn the_agent_can_read_a_file_inside_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("note.md"), "hello from disk").unwrap();
    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();

    client
        .prompt(
            &session,
            &format!("read:{}", root.join("note.md").display()),
        )
        .await
        .unwrap();
    assert_eq!(updates.said(), "hello from disk");
}

#[tokio::test]
async fn a_read_outside_the_session_is_refused_rather_than_answered_empty() {
    // The security boundary, exercised through the full protocol rather than
    // as a unit. A refusal must reach the agent AS an error: told it read an
    // empty file, a model acts on that; told it was refused, it does not.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("session");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "not for you").unwrap();

    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();
    client
        .prompt(&session, &format!("read:{}", secret.display()))
        .await
        .unwrap();

    let said = updates.said();
    assert!(
        !said.contains("not for you"),
        "the file's contents must not reach the agent: {said}"
    );
    assert!(
        said.contains("outside"),
        "the agent should be told why: {said}"
    );
}

#[tokio::test]
async fn a_write_inside_the_session_lands_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();

    let target = root.join("written.txt");
    client
        .prompt(
            &session,
            &format!("write:{}|content here", target.display()),
        )
        .await
        .unwrap();

    assert_eq!(updates.said(), "written");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "content here");
}

#[tokio::test]
async fn a_write_outside_the_session_never_touches_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("session");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let outside = dir.path().join("planted.txt");

    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();
    client
        .prompt(&session, &format!("write:{}|payload", outside.display()))
        .await
        .unwrap();

    assert!(
        !outside.exists(),
        "nothing may be written outside the session"
    );
    assert!(updates.said().contains("outside"));
}

#[tokio::test]
async fn a_permission_request_is_answered_with_an_option_the_agent_offered() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, updates) = connect(&root, confined(&root, Some("yes"))).await;
    let session = client.new_session(&root).await.unwrap();

    client.prompt(&session, "ask").await.unwrap();
    assert_eq!(updates.said(), "chose:yes");
}

#[tokio::test]
async fn permission_defaults_to_refusing_rather_than_allowing() {
    // A client that silently approves is a client whose permission prompt is
    // decoration. With no configured answer, the refusal option is chosen.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();

    client.prompt(&session, "ask").await.unwrap();
    assert_eq!(updates.said(), "chose:no");
}

#[tokio::test]
async fn an_option_the_agent_never_offered_is_not_echoed_back() {
    // Answering with an id the agent did not list is answering a question it
    // did not ask; the safe fallback is its own refusal option.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, updates) = connect(&root, confined(&root, Some("invented"))).await;
    let session = client.new_session(&root).await.unwrap();

    client.prompt(&session, "ask").await.unwrap();
    assert_eq!(updates.said(), "chose:no");
}

#[tokio::test]
async fn auto_approving_files_picks_the_allow_once_option_unprompted() {
    // `LocalAcpAgent`'s production handler (issue #1245) — the opposite of
    // `permission_defaults_to_refusing_rather_than_allowing` above by design:
    // no configured id at all, yet it still answers "yes", because it looks
    // at `kind` rather than needing one told to it.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let handler: Arc<dyn ClientHandler> = Arc::new(AutoApprovingFiles::new(ConfinedFiles::new(
        Confinement::new(&root).unwrap(),
        None,
    )));
    let (client, updates) = connect(&root, handler).await;
    let session = client.new_session(&root).await.unwrap();

    client.prompt(&session, "ask").await.unwrap();
    assert_eq!(updates.said(), "chose:yes");
}

#[tokio::test]
async fn a_harness_that_dies_mid_turn_fails_the_caller_instead_of_hanging() {
    // An ordinary event — a crash, an OOM kill — and the caller has to hear
    // about it in time to say so. A pending map that outlived its reader would
    // leave this awaiting a reply that can never come.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, _updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();

    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.prompt(&session, "die"),
    )
    .await
    .expect("must not hang");

    assert!(matches!(outcome, Err(AcpError::Gone)), "got {outcome:?}");
}

#[tokio::test]
async fn cancel_is_a_notification_and_does_not_wait_for_a_reply() {
    // Sent with an `id`, a conforming agent would try to answer — and a cancel
    // that blocks is the one operation that must never block.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, updates) = connect(&root, confined(&root, None)).await;
    let session = client.new_session(&root).await.unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(5), client.cancel(&session))
        .await
        .expect("cancel must return promptly")
        .expect("cancel is written");

    // The fixture acknowledges by streaming, which also proves the notification
    // was framed in a way it recognised.
    for _ in 0..50 {
        if updates.said().contains("cancelled") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the agent never saw the cancel: {:?}", updates.kinds());
}

#[tokio::test]
async fn an_unsupported_client_method_is_refused_rather_than_faked() {
    // `terminal/*` is not served. Answering `{}` would tell the agent it holds
    // a terminal it can then write to.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (client, _updates) = connect(&root, confined(&root, None)).await;

    let refused = client.call("no/such/method", serde_json::json!({})).await;
    assert!(
        matches!(refused, Err(AcpError::Refused(_))),
        "got {refused:?}"
    );
}
