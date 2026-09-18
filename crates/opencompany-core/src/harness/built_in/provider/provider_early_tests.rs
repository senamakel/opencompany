use super::provider_test_helpers_tests::*;
use super::*;
use crate::app::config::MapEnv;

/// The original defect at this seam: `None` meant "no opinion" and we wrote
/// `0.0` — the one value Anthropic rejects across its entire current lineup
/// and the one Groq rewrites to `1e-8`. Nothing may appear at all.
#[test]
fn no_opinion_puts_no_sampling_field_on_the_wire() {
    let env = crate::test_support::EnvVarGuard::capture(&["OPENCOMPANY_INFERENCE_MAX_TOKENS"]);
    env.remove("OPENCOMPANY_INFERENCE_MAX_TOKENS");
    let mut body = serde_json::json!({ "model": "claude-sonnet-5" });
    let sent = apply_sampling(
        &mut body,
        "https://api.example/v1",
        "claude-sonnet-5",
        inference::dialect::Sampling::Default,
        None,
    );
    assert!(sent.is_empty(), "nothing was asked for: {sent:?}");
    assert!(body.get("temperature").is_none(), "{body}");
}

/// The seam reports what it actually put on the wire, which is what the
/// retry needs: after a rename the caller's name is not the wire's name.
#[test]
fn the_seam_reports_the_field_names_it_sent_after_translation() {
    let mut body = serde_json::json!({ "model": "gpt-5.6-sol" });
    let sent = apply_sampling(
        &mut body,
        "https://api.example/v1",
        "gpt-5.6-sol",
        inference::dialect::Sampling::Deterministic,
        Some(16384),
    );
    // A reasoning model takes no temperature and renames the cap.
    assert!(!sent.contains(&"temperature".to_string()), "{sent:?}");
    assert!(
        sent.contains(&"max_completion_tokens".to_string()),
        "{sent:?}"
    );
    assert!(body.get("max_tokens").is_none(), "{body}");
    assert_eq!(body["max_completion_tokens"], serde_json::json!(16384));
}

/// The output floor only ever raises the harness's cap (issue: reasoning
/// models exhaust a 16k `max_tokens` on their hidden stream).
#[test]
fn output_cap_floor_raises_but_never_lowers() {
    let env = crate::test_support::EnvVarGuard::capture(&["OPENCOMPANY_INFERENCE_MAX_TOKENS"]);
    env.set("OPENCOMPANY_INFERENCE_MAX_TOKENS", "32000");
    assert_eq!(output_cap(Some(16384)), Some(32000));
    assert_eq!(output_cap(Some(64000)), Some(64000));
    assert_eq!(output_cap(None), Some(32000));
}

#[test]
fn output_cap_without_the_variable_is_the_harness_cap() {
    let env = crate::test_support::EnvVarGuard::capture(&["OPENCOMPANY_INFERENCE_MAX_TOKENS"]);
    env.remove("OPENCOMPANY_INFERENCE_MAX_TOKENS");
    assert_eq!(output_cap(Some(16384)), Some(16384));
    assert_eq!(output_cap(None), None);
}

#[tokio::test]
async fn env_config_prefers_specific_key_and_fills_defaults() {
    let env = MapEnv::new([("OPENCOMPANY_INFERENCE_KEY", "sk-specific")]);
    let (cfg, model) = harness_inference_from_env(&env).expect("configured");
    assert_eq!(bearer_of(&cfg).await.as_deref(), Some("sk-specific"));
    assert_eq!(cfg.base_url, DEFAULT_TINYHUMANS_INFERENCE_URL);
    // No explicit model → no roster-wide override (each agent keeps its tier).
    assert_eq!(model, None);
}

#[tokio::test]
async fn env_config_falls_back_to_tinyhumans_key_and_honors_overrides() {
    let env = MapEnv::new([
        ("TINYHUMANS_API_KEY", "sk-platform"),
        (
            "OPENCOMPANY_INFERENCE_URL",
            "https://staging-api.tinyhumans.ai/openai/v1",
        ),
        ("OPENCOMPANY_INFERENCE_MODEL", "reasoning-v1"),
    ]);
    let (cfg, model) = harness_inference_from_env(&env).expect("configured");
    assert_eq!(bearer_of(&cfg).await.as_deref(), Some("sk-platform"));
    assert_eq!(cfg.base_url, "https://staging-api.tinyhumans.ai/openai/v1");
    assert_eq!(model.as_deref(), Some("reasoning-v1"));
}

#[tokio::test]
async fn env_config_derives_the_inference_proxy_from_the_platform_api_url() {
    let env = MapEnv::new([
        ("TINYHUMANS_API_KEY", "sk-platform"),
        (
            crate::company::composio::TINYHUMANS_API_URL_ENV,
            "https://staging-api.tinyhumans.ai/",
        ),
    ]);
    let (cfg, _) = harness_inference_from_env(&env).expect("configured");
    assert_eq!(
        cfg.base_url,
        "https://staging-api.tinyhumans.ai/agent-integrations/openrouter"
    );
}

#[tokio::test]
async fn env_config_uses_resolved_host_api_url_when_environment_omits_it() {
    let env = MapEnv::new([("TINYHUMANS_API_KEY", "sk-platform")]);
    let (cfg, _) =
        harness_inference_from_env_at(&env, Some("https://config-api.tinyhumans.example/"))
            .expect("configured");
    assert_eq!(
        cfg.base_url,
        "https://config-api.tinyhumans.example/agent-integrations/openrouter"
    );
}

#[test]
fn env_config_is_none_without_any_key() {
    let env = MapEnv::new([("OPENCOMPANY_INFERENCE_URL", "https://x/v1")]);
    assert!(harness_inference_from_env(&env).is_none());
}

/// The hosted path: no static key anywhere, just a projected token file. The
/// harness must still resolve a managed brain, reading the file per request.
#[tokio::test]
async fn env_config_resolves_a_projected_token_file() {
    let dir = tempfile::Builder::new()
        .prefix("oc-prov-")
        .tempdir()
        .expect("tempdir");
    let path = dir.path().join("token");
    std::fs::write(&path, "projected-token").unwrap();

    let env = MapEnv::new([(
        crate::company::credentials::TOKEN_FILE_ENV,
        path.display().to_string(),
    )]);
    let (cfg, _) = harness_inference_from_env(&env).expect("configured");
    assert_eq!(
        cfg.credential.source(),
        crate::company::CredentialSource::Attested
    );
    assert_eq!(bearer_of(&cfg).await.as_deref(), Some("projected-token"));

    // A projected file outranks a static key that is still lying around.
    let both = MapEnv::new([
        (
            crate::company::credentials::TOKEN_FILE_ENV,
            path.display().to_string(),
        ),
        (
            crate::company::credentials::API_KEY_ENV,
            "th-static".to_string(),
        ),
    ]);
    let (cfg, _) = harness_inference_from_env(&both).expect("configured");
    assert_eq!(bearer_of(&cfg).await.as_deref(), Some("projected-token"));
}

// ---- media backend (issue #109) ---------------------------------------

#[test]
fn media_backend_prefers_specific_key_and_defaults_url() {
    let env = MapEnv::new([("OPENCOMPANY_MEDIA_KEY", "media-specific")]);
    let backend = media_backend_from_env(&env).expect("configured");
    assert_eq!(backend.auth_token, "media-specific");
    assert_eq!(backend.backend_url, DEFAULT_TINYHUMANS_MEDIA_BACKEND_URL);
}

#[test]
fn media_backend_falls_back_to_tinyhumans_key_and_honors_url_override() {
    let env = MapEnv::new([
        ("TINYHUMANS_API_KEY", "platform-key"),
        (
            "OPENCOMPANY_MEDIA_BACKEND_URL",
            "https://staging-api.tinyhumans.ai",
        ),
    ]);
    let backend = media_backend_from_env(&env).expect("configured");
    assert_eq!(backend.auth_token, "platform-key");
    assert_eq!(backend.backend_url, "https://staging-api.tinyhumans.ai");
}

/// Fail-closed: no managed credential ⇒ no media backend, even when a URL is
/// set. A tenant BYOK inference key must never stand in for the media token.
#[test]
fn media_backend_is_none_without_managed_key() {
    let env = MapEnv::new([("OPENCOMPANY_MEDIA_BACKEND_URL", "https://api.tinyhumans.ai")]);
    assert!(media_backend_from_env(&env).is_none());
}

/// Managed search (issue #238) rides the platform identity and accepts a URL
/// override for staging, with the default daily cap applied.
#[tokio::test]
async fn search_backend_rides_the_platform_key_and_honors_the_url_override() {
    let env = MapEnv::new([
        ("TINYHUMANS_API_KEY", "platform-key"),
        (
            "OPENCOMPANY_SEARCH_BACKEND_URL",
            "https://staging-api.tinyhumans.ai",
        ),
    ]);
    let backend = search_backend_from_env(&env).expect("configured");
    assert_eq!(backend.backend_url, "https://staging-api.tinyhumans.ai");
    assert_eq!(
        backend.daily_call_cap,
        crate::company::DEFAULT_SEARCH_DAILY_CALLS
    );
    assert_eq!(
        backend.credential.current().await.unwrap().as_deref(),
        Some("platform-key")
    );

    // Default URL when only the platform key is present.
    let bare = search_backend_from_env(&MapEnv::new([("TINYHUMANS_API_KEY", "platform-key")]))
        .expect("configured");
    assert_eq!(bare.backend_url, DEFAULT_TINYHUMANS_SEARCH_BACKEND_URL);
}

/// There is deliberately **no** `OPENCOMPANY_SEARCH_KEY`: the #188 sign-off
/// admitted search on the platform identity rather than a credential of its
/// own. A per-tenant inference key must never stand in for it, and no
/// credential at all means no search tool is ever wired (fail-closed).
#[test]
fn search_backend_has_no_credential_of_its_own_and_fails_closed() {
    let env = MapEnv::new([
        (
            "OPENCOMPANY_SEARCH_BACKEND_URL",
            "https://api.tinyhumans.ai",
        ),
        // A tenant BYOK inference key is NOT the platform identity.
        ("OPENCOMPANY_INFERENCE_KEY", "tenant-byok"),
        // And a hypothetical per-surface key is not consulted.
        ("OPENCOMPANY_SEARCH_KEY", "search-specific"),
    ]);
    assert!(search_backend_from_env(&env).is_none());
}

/// Company-only Search still needs one process-wide handle so every lane
/// shares its ledger; its empty fallback credential must remain unusable.
#[tokio::test]
async fn search_backend_handle_is_uncredentialed_without_platform_identity() {
    let backend = search_backend_handle_from_env(&MapEnv::new([(
        "OPENCOMPANY_SEARCH_BACKEND_URL",
        "https://staging-api.tinyhumans.ai",
    )]));
    assert_eq!(backend.backend_url, "https://staging-api.tinyhumans.ai");
    assert_eq!(backend.credential.current().await.unwrap(), None);
}
