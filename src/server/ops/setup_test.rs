//! HTTP-level tests for `POST {scope}/setup/roster` (HT-124).

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use crate::company::CompanyManifest;
use crate::ports::CompanyStore;
use crate::ports::types::{CompanyId, CompanyRecord};
use crate::runtime::RuntimeBuilder;
use crate::server::router;
use crate::store::FsCompanyStore;
use crate::{AppConfig, AppState};

fn home() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("oc-setup-")
        .tempdir()
        .expect("tempdir")
}

fn manifest() -> CompanyManifest {
    toml::from_str("[company]\nname = \"Acme\"\n[policy]\nmode = \"full\"\n").unwrap()
}

async fn state_with(home: &std::path::Path, company: &str) -> AppState {
    let store = FsCompanyStore::new(home.to_path_buf());
    let id = CompanyId::new(company);
    store
        .save(&CompanyRecord {
            overlay_retired_agents: Vec::new(),
            overlay_agent_edits: Vec::new(),
            id: id.clone(),
            manifest: manifest(),
            ledger: Vec::new(),
            lifecycle: "running".to_string(),
            overlay_agents: Vec::new(),
            overlay_desk_members: Vec::new(),
            overlay_desk_order: Vec::new(),
            overlay_desks: Vec::new(),
            overlay_workflows: Vec::new(),
            overlay_budgets: Vec::new(),
            overlay_policy: None,
            overlay_tool_grants: None,
            overlay_desk_tools: Default::default(),
            overlay_desk_hive: Vec::new(),
            disabled_workflows: Vec::new(),
            template_provenance: None,
            setup: None,
            name_confirmed: false,
            activation_completed_at: None,
            created_at_millis: None,
        })
        .await
        .unwrap();
    let runtime = RuntimeBuilder::new(home.to_path_buf(), manifest())
        .with_id(id.clone())
        .build()
        .await
        .unwrap();
    let state = AppState::new(AppConfig::default()).with_home(home.to_path_buf());
    state.registry().insert(id, std::sync::Arc::new(runtime));
    crate::server::test_support::seed_fixed_admin(&state, company).await;
    state
}

fn roster_request(company: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/company/setup/roster")
        .header("cookie", crate::server::test_support::fixed_cookie(company))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"industry":"bakery","team_hint":"","automate":"orders"}"#,
        ))
        .unwrap()
}

/// A route that pays for inference per call must refuse past some
/// per-company burst rate, not accept an unbounded rerun.
#[tokio::test]
async fn repeated_roster_proposals_are_rate_limited() {
    let home_dir = home();
    let company = "ht124-burst";
    let state = state_with(home_dir.path(), company).await;
    let app = router(state);

    const BURST: usize = 20;
    let mut statuses = Vec::with_capacity(BURST);
    for _ in 0..BURST {
        let response = app.clone().oneshot(roster_request(company)).await.unwrap();
        statuses.push(response.status());
    }

    assert!(
        statuses.contains(&StatusCode::TOO_MANY_REQUESTS),
        "expected at least one 429 across {BURST} rapid calls from the same \
         company, got: {statuses:?}"
    );
}

/// Calls inside the burst cap succeed with a real proposal; the call that
/// would exceed it is refused with a `429` naming the cap, not silently
/// dropped and not let through.
#[tokio::test]
async fn roster_proposals_within_the_burst_cap_succeed_then_429() {
    let home_dir = home();
    let company = "ht124-capped";
    let state = state_with(home_dir.path(), company).await;
    let app = router(state);

    for i in 0..crate::server::ops::setup::ROSTER_PROPOSAL_BURST_LIMIT {
        let response = app.clone().oneshot(roster_request(company)).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "call {i} inside the burst cap should succeed"
        );
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["agents"].is_array());
    }

    let response = app.clone().oneshot(roster_request(company)).await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["code"], "roster_proposal_rate_limited");
}
