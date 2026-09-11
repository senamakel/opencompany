//! Unit tests for [`crate::harness::publish`].
//!
//! These pin the tool's *own* behaviour — validation, kind inference, capture,
//! queue semantics, scan bounds and the nudge's wording. Whether the tool is
//! reachable from a real model-driven turn is a different question, and it is
//! answered by `publish_turn_test.rs`.

use super::*;
use serde_json::json;

/// A workspace with the given `path → contents` files written into it.
fn workspace(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, body) in files {
        let full = dir.path().join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, body).unwrap();
    }
    dir
}

async fn run(tool: &PublishArtifactTool, args: serde_json::Value) -> ToolResult {
    tool.execute(args).await.expect("the tool never propagates")
}

/// A queue claimed for `destination`, with the live claim (issue #445).
///
/// Both halves must be bound by the caller: the claim releases on drop, so
/// `let (queue, _) = claimed(..)` would un-claim it immediately and every
/// publish would then be refused. That is the guard doing its job, but it makes
/// for a confusing test failure, hence the name `_claim` at each call site.
fn claimed(destination: PublishDestination) -> (PendingPublishQueue, PublishClaim) {
    let queue = PendingPublishQueue::default();
    let claim = queue.claim(destination);
    (queue, claim)
}

fn text_of(result: &ToolResult) -> String {
    result
        .content
        .iter()
        .map(|c| match c {
            oh::skills::types::ToolContent::Text { text } => text.clone(),
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── Path validation ───────────────────────────────────────────────────────

/// The headline: a file the agent wrote resolves, and its `source` is the
/// normalized workspace-relative path that becomes half the artifact's
/// identity.
#[test]
fn a_workspace_file_resolves_to_its_relative_source() {
    let dir = workspace(&[("specs/launch.md", b"# Spec")]);
    let (file, source) = resolve_in_workspace(dir.path(), "specs/launch.md").unwrap();
    assert!(file.is_file());
    assert_eq!(source, "specs/launch.md");
}

/// Identity must not depend on how the agent spelled the path, or a re-run that
/// wrote `./specs/launch.md` would open a second lineage for one file.
#[test]
fn an_equivalent_spelling_produces_the_same_identity() {
    let dir = workspace(&[("specs/launch.md", b"# Spec")]);
    let (_, direct) = resolve_in_workspace(dir.path(), "specs/launch.md").unwrap();
    let (_, roundabout) = resolve_in_workspace(dir.path(), "./specs/../specs/launch.md").unwrap();
    assert_eq!(direct, roundabout);
}

#[test]
fn traversal_and_absolute_paths_are_refused() {
    let dir = workspace(&[("specs/launch.md", b"# Spec")]);
    // Climbing out, in the obvious shape…
    assert_eq!(
        resolve_in_workspace(dir.path(), "../outside.md"),
        Err(PublishPathError::Missing),
        "nothing is there, and it would be outside if it were"
    );
    // …and where the target genuinely exists outside the workspace.
    let sibling = dir.path().parent().unwrap().join("outside.md");
    std::fs::write(&sibling, b"secret").unwrap();
    assert_eq!(
        resolve_in_workspace(dir.path(), "../outside.md"),
        Err(PublishPathError::Outside)
    );
    let _ = std::fs::remove_file(&sibling);

    assert_eq!(
        resolve_in_workspace(dir.path(), "/etc/hosts"),
        Err(PublishPathError::Outside)
    );
    assert_eq!(
        resolve_in_workspace(dir.path(), "  "),
        Err(PublishPathError::Empty)
    );
}

/// The reason containment is a canonicalize-then-prefix check and not a `..`
/// scan: a symlink inside the workspace has no `..` in it at all.
#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_workspace_is_refused() {
    let dir = workspace(&[("specs/launch.md", b"# Spec")]);
    let outside = dir.path().parent().unwrap().join("escape-target.md");
    std::fs::write(&outside, b"not yours").unwrap();
    std::os::unix::fs::symlink(&outside, dir.path().join("escape.md")).unwrap();

    assert_eq!(
        resolve_in_workspace(dir.path(), "escape.md"),
        Err(PublishPathError::Outside),
        "a symlink is a path that contains no `..` and still leaves the sandbox"
    );
    let _ = std::fs::remove_file(&outside);
}

#[test]
fn a_missing_file_and_a_directory_are_different_mistakes() {
    let dir = workspace(&[("specs/launch.md", b"# Spec")]);
    assert_eq!(
        resolve_in_workspace(dir.path(), "specs/nope.md"),
        Err(PublishPathError::Missing)
    );
    assert_eq!(
        resolve_in_workspace(dir.path(), "specs"),
        Err(PublishPathError::NotAFile)
    );
}

/// Every refusal has to tell the agent what to do next — a tool error that only
/// says "no" costs a whole turn to recover from.
#[test]
fn every_path_error_names_a_next_step() {
    for err in [
        PublishPathError::Empty,
        PublishPathError::Outside,
        PublishPathError::Missing,
        PublishPathError::NotAFile,
    ] {
        let message = err.message("specs/launch.md");
        assert!(message.len() > 40, "{err:?}: {message}");
        assert!(
            message.contains("publish") || message.contains("Publish") || message.contains("path"),
            "{err:?}: {message}"
        );
    }
}

// ── Kind + capture ────────────────────────────────────────────────────────

#[test]
fn kind_is_inferred_from_the_extension() {
    use std::path::Path;
    assert_eq!(
        kind_for_extension(Path::new("a/launch.md")),
        ArtifactKind::Markdown
    );
    assert_eq!(
        kind_for_extension(Path::new("a/notes.txt")),
        ArtifactKind::Text
    );
    assert_eq!(
        kind_for_extension(Path::new("a/chart.png")),
        ArtifactKind::Image
    );
    assert_eq!(
        kind_for_extension(Path::new("a/data.parquet")),
        ArtifactKind::File
    );
    // No extension at all is a file, not a guess at prose.
    assert_eq!(
        kind_for_extension(Path::new("a/Makefile")),
        ArtifactKind::File
    );
    // Case does not decide anything.
    assert_eq!(
        kind_for_extension(Path::new("a/READ.MD")),
        ArtifactKind::Markdown
    );
}

#[test]
fn text_at_or_under_the_cap_is_stored_whole() {
    let body = "x".repeat(MAX_ARTIFACT_BODY_BYTES);
    let dir = workspace(&[("big.txt", body.as_bytes())]);
    let captured =
        capture_body(&dir.path().join("big.txt"), "big.txt", ArtifactKind::Text).unwrap();
    assert_eq!(
        captured,
        PublishPayload::Text(body),
        "exactly at the cap must still be stored as prose"
    );
    assert_eq!(captured.forced_kind(ArtifactKind::Text), ArtifactKind::Text);
}

/// One byte over the cap is stored as **bytes**, not as a reference.
///
/// Issue #553 removed the reference branch entirely: the workspace tree can
/// hold bytes on every backend, so there is nothing for a fallback to fall back
/// to. The boundary is asserted from both sides because an off-by-one here
/// changes how a deliverable is stored.
#[test]
fn one_byte_over_the_cap_is_stored_as_bytes() {
    let body = "x".repeat(MAX_ARTIFACT_BODY_BYTES + 1);
    let dir = workspace(&[("big.txt", body.as_bytes())]);
    let captured =
        capture_body(&dir.path().join("big.txt"), "big.txt", ArtifactKind::Text).unwrap();
    match &captured {
        PublishPayload::Bytes { bytes, mime } => {
            assert_eq!(
                bytes.len(),
                MAX_ARTIFACT_BODY_BYTES + 1,
                "the whole file is carried, not a slice of it"
            );
            assert_eq!(mime, "text/plain");
        }
        other => panic!("expected bytes, got {other:?}"),
    }
    assert_eq!(
        captured.forced_kind(ArtifactKind::Text),
        ArtifactKind::File,
        "bytes must not be filed under a kind the console renders as prose"
    );
}

/// `capture_body` stats before it reads: a file over `MAX_CAPTURED_FILE_BYTES`
/// is refused before `std::fs::read` ever runs, so nothing this far past any
/// sane size for a single in-memory `Vec<u8>` allocation is ever buffered
/// whole just to be classified.
#[test]
fn capture_body_refuses_a_file_far_past_any_sane_single_read() {
    const UNREASONABLE_FOR_ONE_READ: usize = 64 * 1024 * 1024; // 64 MiB
    let body = vec![b'x'; UNREASONABLE_FOR_ONE_READ];
    let dir = workspace(&[("huge.bin", &body)]);
    let result = capture_body(&dir.path().join("huge.bin"), "huge.bin", ArtifactKind::File);
    assert!(
        result.is_err(),
        "a file this large must be refused before being read whole into memory"
    );
}

#[test]
fn a_non_utf8_file_is_stored_as_bytes_whatever_its_size() {
    let png = [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe];
    let dir = workspace(&[("logo.png", &png)]);
    let captured = capture_body(
        &dir.path().join("logo.png"),
        "logo.png",
        ArtifactKind::Image,
    )
    .unwrap();
    assert_eq!(
        captured,
        PublishPayload::Bytes {
            bytes: png.to_vec(),
            mime: "image/png".to_string(),
        }
    );
    assert_eq!(
        captured.forced_kind(ArtifactKind::Image),
        ArtifactKind::Image,
        "an image stays an image so the console picks the right renderer"
    );
}

/// The payoff of #553, stated as a test: **no publish can produce a reference
/// record any more.** The branch that emitted "the file lives in the agent's
/// own sandbox … the payload unreachable" is gone, so a paid image generation
/// cannot become a dangling digest pointing into a directory that gets wiped.
///
/// Asserted over every shape that used to take that branch — over-cap text,
/// non-UTF-8 bytes, and an empty file — because the guarantee is "none of
/// them", not "not the one I happened to check".
#[test]
fn no_publish_can_produce_a_reference_record() {
    let over_cap = "x".repeat(MAX_ARTIFACT_BODY_BYTES + 1);
    let dir = workspace(&[
        ("big.txt", over_cap.as_bytes()),
        ("logo.png", &[0x89, 0xff, 0xfe]),
        ("empty.bin", &[]),
        ("small.md", b"# fine"),
    ]);
    for name in ["big.txt", "logo.png", "empty.bin", "small.md"] {
        let captured = capture_body(
            &dir.path().join(name),
            name,
            kind_for_extension(Path::new(name)),
        )
        .unwrap();
        let recorded = captured.artifact_body();
        assert!(
            !recorded.contains("sandbox"),
            "{name} still points at the sandbox: {recorded}"
        );
        assert!(
            !recorded.contains("unreachable"),
            "{name} still claims its payload is unreachable: {recorded}"
        );
        assert!(
            !recorded.contains("sha256"),
            "{name} hashes on the publish path; the store computes the digest once: {recorded}"
        );
    }
}

/// A binary version records a pointer, not the bytes — issue #187's rule. The
/// artifact chain stays the version history and the workspace node holds the
/// content.
#[test]
fn a_binary_version_records_a_description_and_not_the_bytes() {
    let payload = PublishPayload::Bytes {
        bytes: vec![0u8; 4096],
        mime: "image/png".to_string(),
    };
    let body = payload.artifact_body();
    assert!(body.contains("image/png"), "{body}");
    assert!(body.contains("4096 bytes"), "{body}");
    assert!(body.contains("company workspace"), "{body}");
}

/// Issue #663. The body composed **before** the store is asked must not assert
/// that the file is there — that claim was unconditional, and it survived a
/// workspace refusal, leaving the record promising a file that does not exist.
#[test]
fn a_pending_binary_version_does_not_claim_the_file_is_stored() {
    let payload = PublishPayload::Bytes {
        bytes: vec![0u8; 16],
        mime: "image/png".to_string(),
    };
    let body = payload.artifact_body_for(PayloadStorage::Pending);
    assert!(
        !body.contains("stored as a file"),
        "nothing has been stored yet: {body}"
    );
    assert!(
        !body.contains("Open it there"),
        "and the operator must not be sent to look for it: {body}"
    );
}

/// Issue #668. A stored version carries the digest **the store** computed, which
/// is what lets a reader tell two versions apart and see whether a re-publish
/// changed anything.
#[test]
fn a_stored_binary_version_records_the_stores_digest() {
    let payload = PublishPayload::Bytes {
        bytes: vec![0u8; 16],
        mime: "image/png".to_string(),
    };
    let body = payload.artifact_body_for(PayloadStorage::Stored {
        sha256: Some("abc123"),
    });
    assert!(body.contains("sha256 abc123"), "{body}");
    assert!(body.contains("stored as a file"), "{body}");
}

/// The defect #668 describes in one assertion: two versions of one binary that
/// coincide in mime and length used to be **literally equal strings**, so the
/// history could not say which was which. The digest is what separates them.
#[test]
fn two_binary_versions_of_the_same_length_differ_by_their_digest() {
    let payload = PublishPayload::Bytes {
        bytes: vec![0u8; 120_000],
        mime: "image/png".to_string(),
    };
    let v1 = payload.artifact_body_for(PayloadStorage::Stored {
        sha256: Some("1111111111111111"),
    });
    let v2 = payload.artifact_body_for(PayloadStorage::Stored {
        sha256: Some("2222222222222222"),
    });
    assert_ne!(
        v1, v2,
        "two versions of one deliverable must not be the same sentence"
    );

    // The control: without a digest they collapse back into one string, which
    // is exactly the state this issue is about.
    let bare = payload.artifact_body_for(PayloadStorage::Stored { sha256: None });
    assert_eq!(
        bare,
        payload.artifact_body_for(PayloadStorage::Stored { sha256: None }),
        "the no-digest body is the indistinguishable case, and it says so"
    );
    assert!(
        bare.contains("no digest recorded"),
        "a backend that recorded none must say so rather than imply identity: {bare}"
    );
}

/// Issue #663's other half: when the workspace refuses the file, the record
/// withdraws the claim instead of leaving it standing.
///
/// It must also NOT carry the store's error text — a version body is permanent
/// and a backend error can name host paths.
#[test]
fn a_refused_binary_version_withdraws_the_storage_claim() {
    let payload = PublishPayload::Bytes {
        bytes: vec![0u8; 16],
        mime: "image/png".to_string(),
    };
    let body = payload.artifact_body_for(PayloadStorage::Refused);
    assert!(body.contains("NOT stored"), "{body}");
    assert!(
        !body.contains("Open it there"),
        "the operator must not be sent to a file that is not there: {body}"
    );
}

/// Prose is unaffected by any of this: for text the version IS the content, so
/// it is complete whatever the tree did.
#[test]
fn a_prose_version_is_its_content_whatever_the_store_did() {
    let payload = PublishPayload::Text("# Spec".to_string());
    for storage in [
        PayloadStorage::Pending,
        PayloadStorage::Stored { sha256: None },
        PayloadStorage::Refused,
    ] {
        assert_eq!(payload.artifact_body_for(storage), "# Spec");
    }
}

// ── The tool ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn publishing_stages_the_file_and_reports_what_was_captured() {
    let dir = workspace(&[("specs/launch.md", b"# Spec\nShip it.")]);
    let (queue, _claim) = claimed(PublishDestination::Task);
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    let result = run(&tool, json!({ "path": "specs/launch.md" })).await;
    assert!(!result.is_error, "{}", text_of(&result));

    let staged = queue.drain();
    assert_eq!(staged.len(), 1);
    assert_eq!(staged[0].source, "specs/launch.md");
    assert_eq!(staged[0].kind, ArtifactKind::Markdown);
    assert_eq!(
        staged[0].payload,
        PublishPayload::Text("# Spec\nShip it.".to_string())
    );
    // Title defaults to the file name, not the whole path.
    assert_eq!(staged[0].title, "launch.md");
    assert_eq!(staged[0].note, None);
}

/// Issue #463: the staged item names **who published it**.
///
/// The queue is shared by every turn a cycle runs, so the drain site cannot
/// answer this — an operator message answered by the orchestrator and handed to
/// a desk stages a file from whichever of them reached for the tool. Without the
/// stamp the card and the artifact were filed under the turn's responder, so a
/// deliverable the writer produced was recorded as the orchestrator's.
#[tokio::test]
async fn a_staged_publish_names_the_agent_that_called_the_tool() {
    let dir = workspace(&[("memo.md", b"# Memo")]);
    let (queue, _claim) = claimed(PublishDestination::Conversation);
    let tool = PublishArtifactTool::new(dir.path(), "writer", queue.clone());

    run(&tool, json!({ "path": "memo.md" })).await;

    let staged = queue.drain();
    assert_eq!(staged[0].agent, "writer");
}

#[tokio::test]
async fn an_explicit_title_kind_and_note_are_carried_through() {
    let dir = workspace(&[("out.dat", b"plain text really")]);
    let (queue, _claim) = claimed(PublishDestination::Task);
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    run(
        &tool,
        json!({
            "path": "out.dat",
            "title": "Q3 export",
            "kind": "text",
            "note": "rewrote the pricing section"
        }),
    )
    .await;

    let staged = queue.drain();
    assert_eq!(staged[0].title, "Q3 export");
    assert_eq!(
        staged[0].kind,
        ArtifactKind::Text,
        "an explicit kind beats the extension"
    );
    assert_eq!(
        staged[0].note.as_deref(),
        Some("rewrote the pricing section")
    );
}

/// The body is read at publish time, so a later shell step cannot retroactively
/// change what the operator is told was published.
#[tokio::test]
async fn the_body_is_captured_at_publish_time_not_at_drain_time() {
    let dir = workspace(&[("spec.md", b"# The version I published")]);
    let (queue, _claim) = claimed(PublishDestination::Task);
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    run(&tool, json!({ "path": "spec.md" })).await;
    // The agent's next step scribbles over the file.
    std::fs::write(dir.path().join("spec.md"), b"# clobbered afterwards").unwrap();

    let staged = queue.drain();
    assert_eq!(
        staged[0].payload,
        PublishPayload::Text("# The version I published".to_string())
    );
}

#[tokio::test]
async fn a_bad_path_is_a_truthful_tool_error_and_stages_nothing() {
    let dir = workspace(&[("spec.md", b"# Spec")]);
    let (queue, _claim) = claimed(PublishDestination::Task);
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    for path in ["../escape.md", "/etc/hosts", "nope.md", ""] {
        let result = run(&tool, json!({ "path": path })).await;
        assert!(result.is_error, "`{path}` was accepted");
    }
    // A missing `path` argument entirely.
    assert!(run(&tool, json!({})).await.is_error);
    assert_eq!(queue.queued(), 0, "a refused publish must stage nothing");
}

#[tokio::test]
async fn an_unknown_kind_is_refused_by_name() {
    let dir = workspace(&[("spec.md", b"# Spec")]);
    let (queue, _claim) = claimed(PublishDestination::Task);
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    let result = run(&tool, json!({ "path": "spec.md", "kind": "spreadsheet" })).await;
    assert!(result.is_error);
    let message = text_of(&result);
    assert!(message.contains("markdown"), "{message}");
    assert_eq!(queue.queued(), 0);
}

// ── Queue semantics ───────────────────────────────────────────────────────

#[test]
fn the_queue_drains_fifo_and_empties() {
    let queue = PendingPublishQueue::default();
    let publish = |source: &str| PendingPublish {
        agent: "maya".to_string(),
        source: source.to_string(),
        title: source.to_string(),
        kind: ArtifactKind::Text,
        note: None,
        payload: PublishPayload::Text("b".to_string()),
    };
    queue.push(publish("a.md"));
    queue.push(publish("b.md"));
    assert_eq!(queue.sources(), ["a.md", "b.md"]);
    assert_eq!(queue.queued(), 2);

    let drained = queue.drain();
    assert_eq!(
        drained
            .iter()
            .map(|p| p.source.as_str())
            .collect::<Vec<_>>(),
        ["a.md", "b.md"]
    );
    assert_eq!(queue.queued(), 0, "drain empties");
    assert!(queue.drain().is_empty(), "a second drain yields nothing");
}

/// `clear` is what stops an operator chat turn earlier in the same cycle — or
/// an abandoned redirect re-run — from having its staged file attributed to
/// this card.
#[test]
fn clear_drops_what_a_prior_turn_staged() {
    let queue = PendingPublishQueue::default();
    queue.push(PendingPublish {
        agent: "maya".to_string(),
        source: "leftover.md".to_string(),
        title: "leftover".to_string(),
        kind: ArtifactKind::Text,
        note: None,
        payload: PublishPayload::Text("b".to_string()),
    });
    queue.clear();
    assert_eq!(queue.queued(), 0);
    assert!(queue.sources().is_empty());
}

/// The queue handle is shared, not copied — the tool built into the agent and
/// the brain that drains it must see one queue.
///
/// Since #445 that sharing has a second half: the **destination** travels with
/// the clone too. `build_agent` hands the tool one clone and nothing else, so a
/// destination that did not survive cloning would leave every built tool
/// permanently unclaimed and unable to publish at all.
#[tokio::test]
async fn a_cloned_handle_sees_the_same_queue() {
    let dir = workspace(&[("spec.md", b"# Spec")]);
    let queue = PendingPublishQueue::default();
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    let _claim = queue.claim(PublishDestination::Task);
    run(&tool, json!({ "path": "spec.md" })).await;

    assert_eq!(queue.queued(), 1, "the brain's handle sees the tool's push");
}

// ── The scan ──────────────────────────────────────────────────────────────

#[test]
fn the_scan_sees_new_and_modified_files_but_not_deletions() {
    let dir = workspace(&[("keep.md", b"one"), ("gone.md", b"two")]);
    let before = WorkspaceSnapshot::take(dir.path());
    assert_eq!(before.len(), 2);

    std::fs::write(dir.path().join("keep.md"), b"one, revised").unwrap();
    std::fs::write(dir.path().join("fresh.md"), b"new").unwrap();
    std::fs::remove_file(dir.path().join("gone.md")).unwrap();

    let changed = before.changed_since(dir.path()).files;
    assert_eq!(
        changed,
        ["fresh.md", "keep.md"],
        "a deleted file is not a deliverable somebody forgot to publish"
    );
}

/// A same-timestamp rewrite still counts, because size is compared too. Coarse
/// filesystem clocks are common enough that mtime alone would miss real edits.
#[test]
fn a_same_instant_rewrite_of_a_different_length_is_still_a_change() {
    let dir = workspace(&[("spec.md", b"short")]);
    let before = WorkspaceSnapshot::take(dir.path());
    let path = dir.path().join("spec.md");
    let stat = std::fs::metadata(&path).unwrap();
    std::fs::write(&path, b"a considerably longer body").unwrap();
    // Force the mtime back so only the size differs.
    let file = std::fs::File::options().write(true).open(&path).unwrap();
    file.set_modified(stat.modified().unwrap()).unwrap();
    drop(file);

    assert_eq!(before.changed_since(dir.path()).files, ["spec.md"]);
}

#[test]
fn the_scan_skips_the_directories_an_exec_sandbox_fills() {
    let dir = workspace(&[
        ("spec.md", b"one"),
        (".git/objects/ab/cdef", b"blob"),
        ("node_modules/left-pad/index.js", b"module"),
        ("target/debug/build.log", b"log"),
    ]);
    let snapshot = WorkspaceSnapshot::take(dir.path());
    assert_eq!(snapshot.len(), 1, "only the agent's own file");
    assert!(!snapshot.truncated());

    // …and they are skipped on the diff side too, so a build never nudges.
    let before = WorkspaceSnapshot::take(dir.path());
    std::fs::write(dir.path().join("target/debug/build.log"), b"rebuilt").unwrap();
    assert!(before.changed_since(dir.path()).files.is_empty());
}

/// **The false-positive test that matters most.** The agent's `workspace_dir`
/// is also where OpenHuman writes its own session transcripts, audit trail and
/// checkpoints — on *every* run, by the harness rather than the agent. If the
/// scan counted them, the nudge would fire after every single dispatch, asking
/// an agent whether its own transcript is a deliverable.
///
/// Found the hard way: before these exclusions, every existing dispatch test
/// grew a second model turn.
#[test]
fn the_scan_ignores_what_the_runtime_itself_writes() {
    let dir = workspace(&[("spec.md", b"one")]);
    let before = WorkspaceSnapshot::take(dir.path());

    // Exactly what a real run leaves behind beside the agent's own work.
    for path in [
        "sessions/2026_08_05/1785952277_chief.md",
        "session_raw/1785952277_chief.jsonl",
        "artifacts/some-id/content",
        "checkpoints/state.json",
        "tinyagents_store/journal/session.1785953147_ceo.messages.jsonl",
        ".openhuman/subagent_checkpoints/a.json",
        ".runs/run-1.json",
        "audit.log",
        ".env",
    ] {
        let full = dir.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, b"runtime bookkeeping").unwrap();
    }

    assert!(
        before.changed_since(dir.path()).files.is_empty(),
        "the runtime's own files must never look like unpublished agent work"
    );

    // The agent's actual file is still seen, so the exclusions did not blind it.
    std::fs::write(dir.path().join("spec.md"), b"one, revised").unwrap();
    assert_eq!(before.changed_since(dir.path()).files, ["spec.md"]);
}

/// The entry cap. A truncated scan may only under-report — it feeds a warning,
/// never a promotion, so missing something is the acceptable failure.
#[test]
fn the_scan_stops_at_its_entry_cap() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..(MAX_SCAN_ENTRIES + 50) {
        std::fs::write(dir.path().join(format!("f{i}.txt")), b"x").unwrap();
    }
    let snapshot = WorkspaceSnapshot::take(dir.path());
    assert!(snapshot.truncated());
    assert!(snapshot.len() <= MAX_SCAN_ENTRIES);
}

#[test]
fn a_workspace_that_does_not_exist_yet_has_changed_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let never = dir.path().join("no-such-agent/workspace");
    let snapshot = WorkspaceSnapshot::take(&never);
    assert!(snapshot.is_empty());
    assert!(snapshot.changed_since(&never).files.is_empty());
}

#[test]
fn unpublished_is_changed_minus_staged() {
    let changed = vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()];
    assert_eq!(
        unpublished(&changed, &["b.md".to_string()]),
        ["a.md", "c.md"]
    );
    assert!(unpublished(&changed, &changed).is_empty(), "all published");
    assert!(unpublished(&[], &[]).is_empty(), "nothing written");
}

#[test]
fn a_long_file_list_is_bounded_and_says_so() {
    let many: Vec<String> = (0..MAX_NAMED_FILES + 7)
        .map(|i| format!("f{i}.txt"))
        .collect();
    let rendered = name_files(&many);
    assert!(rendered.contains("and 7 more"), "{rendered}");
    assert!(!rendered.contains(&format!("f{}.txt", MAX_NAMED_FILES + 1)));
    // Under the bound, nothing is added.
    assert_eq!(name_files(&["a.md".to_string()]), "a.md");
}

// ── The nudge's words ─────────────────────────────────────────────────────

/// The nudge has to stand alone: turns share no conversation context, so the
/// brief, the reply and the files all have to be inside it.
#[test]
fn the_nudge_carries_its_own_context() {
    let instruction = nudge_instruction(
        "Draft the launch spec.",
        "Done — I've written it up.",
        &["specs/launch.md".to_string(), "scratch.txt".to_string()],
        false,
    );
    assert!(
        instruction.contains("Draft the launch spec."),
        "{instruction}"
    );
    assert!(
        instruction.contains("Done — I've written it up."),
        "{instruction}"
    );
    assert!(instruction.contains("specs/launch.md"), "{instruction}");
    assert!(instruction.contains("scratch.txt"), "{instruction}");
    assert!(instruction.contains(PUBLISH_ARTIFACT_TOOL), "{instruction}");
}

/// **The non-coercion test.** A nudge that reads as an instruction produces
/// published build logs. It must offer the decline in the same breath, and must
/// never claim publishing is required.
#[test]
fn the_nudge_offers_the_decline_and_never_demands_a_publish() {
    let instruction = nudge_instruction("Draft it.", "Done.", &["scratch.txt".to_string()], false);
    let lower = instruction.to_lowercase();

    assert!(
        lower.contains("declining is a normal answer"),
        "the decline must be affirmed, not merely permitted: {instruction}"
    );
    assert!(
        lower.contains("say briefly why not"),
        "there must be a stated way to decline: {instruction}"
    );
    assert!(
        lower.contains("scratch files"),
        "the legitimate reasons to decline must be named: {instruction}"
    );
    for coercion in [
        "you must",
        "you should",
        "required",
        "make sure you publish",
    ] {
        assert!(
            !lower.contains(coercion),
            "the nudge reads as a demand (`{coercion}`): {instruction}"
        );
    }
    // And it must be clear the already-sent answer is not at stake.
    assert!(
        lower.contains("already been sent"),
        "the agent must know its reply is safe: {instruction}"
    );
}

#[test]
fn a_decline_is_recorded_with_both_the_files_and_the_reason() {
    let note = declined_note(
        &["scratch.txt".to_string()],
        "  Those were intermediate notes, not the deliverable.  ",
    );
    assert_eq!(
        note,
        "unpublished: scratch.txt — agent: Those were intermediate notes, not the deliverable."
    );
}

// ── Issue #445: no success receipt for a publish nothing will record ───────

/// **The headline test.** With no claimed destination the tool must refuse,
/// because nothing is listening for what it would stage.
///
/// This is the exact shape of #445: the file resolved, it was readable, and
/// every check the tool used to make passed — so the old tool staged it, said
/// "published", and the item was cleared unread. A green assertion on the
/// receipt string would have passed then too, which is why this asserts on the
/// **queue** as well as on `is_error`.
#[tokio::test]
async fn an_unclaimed_queue_refuses_to_publish_and_stages_nothing() {
    let dir = workspace(&[("specs/launch.md", b"# Spec")]);
    let queue = PendingPublishQueue::default();
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    let result = run(&tool, json!({ "path": "specs/launch.md" })).await;

    assert!(
        result.is_error,
        "a publish nothing will drain must not report success: {}",
        text_of(&result)
    );
    assert_eq!(
        queue.queued(),
        0,
        "a refused publish must not leave anything staged"
    );
    let message = text_of(&result);
    // The agent must be told not to claim delivery — the failure #445 describes
    // is laundered through the agent into a confident lie to the operator, and
    // only the tool's own words can stop that.
    assert!(
        message.contains("NOT published"),
        "the refusal must be unambiguous: {message}"
    );
    assert!(
        message.to_lowercase().contains("do not retry"),
        "an unclaimed queue is not a transient fault: {message}"
    );
    assert!(
        message.contains("sandbox"),
        "the agent must be told where the file actually still is: {message}"
    );
}

/// `Unclaimed` is the [`Default`], which is what makes the guarantee hold for
/// call sites that do not know this module exists.
#[test]
fn a_fresh_queue_is_unclaimed_by_default() {
    assert_eq!(
        PendingPublishQueue::default().destination(),
        PublishDestination::Unclaimed
    );
    assert_eq!(PublishDestination::default(), PublishDestination::Unclaimed);
}

/// The claim is a scope, not a flag: when it ends, publishing is off again.
///
/// This is what protects a turn that runs *after* a drain site returns — an
/// approval re-dispatch, a workflow node, anything reusing the same shared deps
/// — from inheriting a promise that has already been settled.
#[tokio::test]
async fn dropping_the_claim_stops_publishing_again() {
    let dir = workspace(&[("spec.md", b"# Spec")]);
    let queue = PendingPublishQueue::default();
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    let claim = queue.claim(PublishDestination::Task);
    assert!(!run(&tool, json!({ "path": "spec.md" })).await.is_error);
    drop(claim);

    assert_eq!(
        queue.destination(),
        PublishDestination::Unclaimed,
        "the claim must release on drop"
    );
    assert_eq!(
        queue.queued(),
        0,
        "releasing must also clear, so nothing leaks into the next caller"
    );
    assert!(
        run(&tool, json!({ "path": "spec.md" })).await.is_error,
        "publishing must be refused once the claim has ended"
    );
}

/// Claiming clears, so one caller can never be handed the previous caller's
/// staged file. This is the invariant `run_task`'s hand-written `clear()` used
/// to carry, now enforced by the claim itself.
#[test]
fn claiming_clears_whatever_a_previous_caller_left_staged() {
    let queue = PendingPublishQueue::default();
    let claim = queue.claim(PublishDestination::Task);
    queue.push(PendingPublish {
        agent: "maya".to_string(),
        source: "stale.md".to_string(),
        title: "stale".to_string(),
        kind: ArtifactKind::Text,
        note: None,
        payload: PublishPayload::Text("old".to_string()),
    });
    drop(claim);

    let _claim = queue.claim(PublishDestination::Conversation);
    assert_eq!(queue.queued(), 0);
    assert_eq!(queue.destination(), PublishDestination::Conversation);
}

/// The receipt must describe **this** caller's destination. One sentence written
/// for the task case and reused everywhere is what told a chat turn its file
/// would appear on a run that did not exist.
#[tokio::test]
async fn the_receipt_names_the_destination_the_caller_actually_has() {
    let dir = workspace(&[("spec.md", b"# Spec")]);

    let (task_queue, _task_claim) = claimed(PublishDestination::Task);
    let task_tool = PublishArtifactTool::new(dir.path(), "maya", task_queue);
    let task_receipt = text_of(&run(&task_tool, json!({ "path": "spec.md" })).await);

    let (chat_queue, _chat_claim) = claimed(PublishDestination::Conversation);
    let chat_tool = PublishArtifactTool::new(dir.path(), "maya", chat_queue);
    let chat_receipt = text_of(&run(&chat_tool, json!({ "path": "spec.md" })).await);

    assert!(
        task_receipt.contains("this task's Artifacts tab"),
        "the task receipt is unchanged by #445: {task_receipt}"
    );
    assert!(
        chat_receipt.contains("card"),
        "a conversation's file lands on a minted card, and must say so: {chat_receipt}"
    );
    assert!(
        !chat_receipt.contains("this task's"),
        "a chat turn has no task; the receipt must not name one: {chat_receipt}"
    );
    assert_ne!(
        task_receipt, chat_receipt,
        "two destinations must not share one sentence"
    );
}

// ── Issue #445: the card a conversation's publish mints ───────────────────

#[test]
fn a_minted_card_is_titled_from_what_was_published() {
    let publish = |title: &str, source: &str| PendingPublish {
        agent: "maya".to_string(),
        source: source.to_string(),
        title: title.to_string(),
        kind: ArtifactKind::Markdown,
        note: None,
        payload: PublishPayload::Text("body".to_string()),
    };

    assert_eq!(
        conversation_card_title(&[publish("Launch spec", "specs/launch.md")]),
        "Launch spec",
        "one file gives the card its own title"
    );
    assert_eq!(
        conversation_card_title(&[
            publish("Launch spec", "specs/launch.md"),
            publish("Pricing", "pricing.md"),
            publish("FAQ", "faq.md"),
        ]),
        "Launch spec (+2 more)",
        "several files stay one fixed-width title"
    );
    // Never panics on the case that cannot happen.
    assert!(!conversation_card_title(&[]).is_empty());
}

/// A card nobody asked for has to explain itself, or the honest fix for a
/// silent drop introduces its own small mystery on the board.
#[test]
fn a_minted_card_explains_why_it_exists() {
    let note = conversation_card_note(
        "ceo",
        &[PendingPublish {
            agent: "maya".to_string(),
            source: "specs/launch.md".to_string(),
            title: "Launch spec".to_string(),
            kind: ArtifactKind::Markdown,
            note: None,
            payload: PublishPayload::Text("body".to_string()),
        }],
    );
    assert!(note.contains("ceo"), "{note}");
    assert!(note.contains("specs/launch.md"), "{note}");
    assert!(note.contains("conversation"), "{note}");
}

/// If a publish is accepted and then cannot be recorded, the operator hears
/// about it — in the conversation, where the wrong claim was made.
#[test]
fn a_recording_failure_is_stated_in_the_operators_own_reply() {
    let one = recording_failed_notice(1);
    assert!(one.contains("1 file was"), "{one}");
    assert!(
        one.contains("NOT") && one.to_lowercase().contains("incorrect"),
        "the operator must be told the delivery claim is wrong: {one}"
    );
    let many = recording_failed_notice(3);
    assert!(many.contains("3 files were"), "{many}");
}

// ── Issue #445: sandbox is not the company workspace ──────────────────────

/// The naming collision that sent an operator looking in the wrong place.
///
/// `publish_brief` and `workspace_brief` can sit in the same system prompt, and
/// both used to say "your workspace" about different directories. The brief must
/// now name the sandbox as the sandbox and say outright that it is not the
/// company workspace.
#[test]
fn the_brief_distinguishes_the_sandbox_from_the_company_workspace() {
    let brief = publish_brief();
    let lower = brief.to_lowercase();

    assert!(lower.contains("sandbox"), "{brief}");
    assert!(
        lower.contains("not the company workspace"),
        "the two places must be told apart explicitly: {brief}"
    );
    assert!(
        lower.contains("cannot see"),
        "the agent must know a written file is invisible to the operator: {brief}"
    );
    assert!(
        !lower.contains("in your workspace"),
        "the sandbox must never be called `your workspace` again: {brief}"
    );
    // The non-coercive contract from #244 must survive the rewrite.
    assert!(
        lower.contains("normal outcome"),
        "publishing nothing must stay a fine answer: {brief}"
    );
}

/// The agent-facing refusals must not reintroduce the collision either.
#[test]
fn path_errors_call_the_sandbox_a_sandbox() {
    for err in [PublishPathError::Outside, PublishPathError::Missing] {
        let message = err.message("specs/launch.md");
        assert!(message.contains("sandbox"), "{err:?}: {message}");
        assert!(
            !message.contains("your workspace"),
            "{err:?} still says `your workspace`: {message}"
        );
    }
}

// ── Issue #420 item 3: a partial scan says it is partial ──────────────────

/// The flag existed and nothing read it, so the nudge presented an arbitrary
/// DFS prefix as the complete list of what the agent changed.
#[test]
fn a_truncated_scan_reports_that_its_diff_is_partial() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..(MAX_SCAN_ENTRIES + 50) {
        std::fs::write(dir.path().join(format!("f{i}.txt")), b"x").unwrap();
    }
    let before = WorkspaceSnapshot::take(dir.path());
    assert!(before.truncated(), "the fixture must actually truncate");

    let changed = before.changed_since(dir.path());
    assert!(
        changed.partial,
        "a diff of truncated walks must admit it is a subset"
    );
}

/// A scan that saw everything must NOT claim to be partial, or the caveat
/// becomes noise the agent learns to ignore.
#[test]
fn a_complete_scan_is_not_reported_as_partial() {
    let dir = workspace(&[("spec.md", b"one")]);
    let before = WorkspaceSnapshot::take(dir.path());
    std::fs::write(dir.path().join("spec.md"), b"one, revised").unwrap();

    let changed = before.changed_since(dir.path());
    assert_eq!(changed.files, ["spec.md"]);
    assert!(!changed.partial);
}

/// The agent has to be told, or it declines on behalf of files the scan never
/// reached — a completeness claim the scan cannot support.
#[test]
fn the_nudge_says_when_the_file_list_is_incomplete() {
    let files = ["a.md".to_string()];

    let complete = nudge_instruction("brief", "reply", &files, false);
    assert!(
        complete.contains("That is everything you changed."),
        "{complete}"
    );
    assert!(
        !complete.to_lowercase().contains("incomplete"),
        "{complete}"
    );

    let partial = nudge_instruction("brief", "reply", &files, true);
    assert!(
        partial.to_lowercase().contains("incomplete"),
        "a partial scan must say so: {partial}"
    );
    assert!(
        !partial.contains("That is everything you changed."),
        "a partial scan must not claim completeness: {partial}"
    );
    // The caveat must not turn the nudge coercive — #244's contract still holds.
    assert!(!partial.to_lowercase().contains("you must"), "{partial}");
}

/// A refusal that names a tool the agent does not have costs it a turn.
///
/// The listing tool is advertised as `list` (openhuman's `ListFilesTool::name`);
/// the message used to say `list_files`, which is the Rust type name and not
/// anything the model can call.
#[test]
fn the_missing_file_message_names_a_tool_that_exists() {
    let message = PublishPathError::Missing.message("specs/launch.md");
    assert!(message.contains("`list`"), "{message}");
    assert!(!message.contains("list_files"), "{message}");
}

// ── Refused publishes (issue #1192) ───────────────────────────────────────

/// **The incident, at the queue.** An unclaimed publish is refused *and*
/// recorded, so something other than the model's prose knows it happened.
///
/// Before #1192 the refusal existed in exactly two places: the sentence handed
/// to the model, and a `tracing::warn!`. Neither reaches an operator. A caller
/// that can reach one — a workflow run, which has no conversation to speak in —
/// had nothing structural to say, so the model's apology became the node output
/// and the run scored clean.
///
/// The second half of this test is the one that must not be "simplified away":
/// **`sources()` stays empty.** A refused file is not a staged file. It is the
/// file most at risk of being lost, and the #244 unpublished-work scan is
/// `changed − sources()` — so the moment a refusal counts as a source, the nudge
/// goes silent on precisely the file it exists to catch.
#[tokio::test]
async fn a_refused_publish_is_recorded_on_the_queue_not_only_told_to_the_agent() {
    let dir = workspace(&[("spec.md", b"# Spec")]);
    let queue = PendingPublishQueue::default();
    let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());

    // No claim: `Unclaimed` is the default, which is the workflow-run shape.
    assert_eq!(queue.destination(), PublishDestination::Unclaimed);
    let result = run(&tool, json!({ "path": "spec.md" })).await;
    assert!(result.is_error, "an unclaimed publish is still refused");

    assert_eq!(
        queue.sources(),
        Vec::<String>::new(),
        "a refused file is NOT staged — it must still read as unpublished to the #244 scan"
    );
    assert_eq!(
        queue.queued(),
        0,
        "nothing was staged, so nothing can be drained as an artifact"
    );
    assert_eq!(
        queue.drain_refusals(),
        vec!["spec.md".to_string()],
        "…but the refusal itself is a fact the queue carries"
    );
    assert!(
        queue.drain_refusals().is_empty(),
        "draining empties the bucket, so one refusal is reported once"
    );
}

/// The guard on the new bucket: the chat and task paths must not start
/// producing refusals.
///
/// Both claim a destination before the turn, so `receipt_tail()` answers and the
/// refusal arm is never reached. Worth pinning because the queue handle is
/// *shared* — the same `PendingPublishQueue` clone backs every path — so a
/// refusal recorded on one path is visible to a drain on another. The reason
/// that is safe is exactly this: a claimed destination records none.
#[tokio::test]
async fn a_claimed_destination_records_no_refusal() {
    let dir = workspace(&[("spec.md", b"# Spec")]);

    for destination in [PublishDestination::Task, PublishDestination::Conversation] {
        let (queue, _claim) = claimed(destination);
        let tool = PublishArtifactTool::new(dir.path(), "maya", queue.clone());
        let result = run(&tool, json!({ "path": "spec.md" })).await;

        assert!(!result.is_error, "{destination:?}: the publish succeeds");
        assert_eq!(queue.queued(), 1, "{destination:?}: and it is staged");
        assert!(
            queue.drain_refusals().is_empty(),
            "{destination:?}: a claimed destination must never record a refusal"
        );
    }
}

/// A steer redirect abandons the previous turn's work, and `clear()` is how that
/// abandonment is expressed. It must take the refusals with it.
///
/// Otherwise a redirect re-runs from the original brief and the operator is told
/// about a refusal provoked by a turn that was thrown away — attributed to the
/// turn that replaced it, which never asked to publish anything.
#[test]
fn clearing_the_queue_empties_both_buckets() {
    let queue = PendingPublishQueue::default();
    queue.push(PendingPublish {
        agent: "maya".to_string(),
        source: "staged.md".to_string(),
        title: "staged".to_string(),
        kind: ArtifactKind::Text,
        note: None,
        payload: PublishPayload::Text("body".to_string()),
    });
    queue.push_refusal("refused.md".to_string());
    assert_eq!(queue.queued(), 1);

    queue.clear();

    assert_eq!(queue.queued(), 0, "the staged bucket is emptied, as before");
    assert!(
        queue.drain_refusals().is_empty(),
        "an abandoned turn's refusal must not survive into the turn that replaces it"
    );
}
