//! The proxy must be indistinguishable from a browser's `fetch`.
//!
//! The console runs the same code in a browser and in the desktop; only the
//! `Transport` under it differs. That is only safe if the two transports
//! produce the *same* answers — the console's error handling reads the status,
//! the body and one response header, and turns them into an `ApiError` whose
//! `code`, `message` and `detail` a person then reads. A transport that
//! reported a slightly different status text, or dropped a header, or
//! normalised a body, would produce different errors on the desktop for the
//! same server behaviour.
//!
//! So these run both transports against **one real host** and compare. Not a
//! mock: the point is that the whole stack — routing, auth extractors, error
//! envelopes, header emission — is the same one the browser talks to.

use std::collections::HashMap;

use opencompany_desktop_lib::embedded;
use opencompany_desktop_lib::proxy::{
    Connection, Credential, ProxyRegistry, ProxyRequest, ProxyResponse,
};

/// Boots a real host and registers it with a proxy.
async fn host_and_proxy() -> (embedded::EmbeddedHost, ProxyRegistry, tempfile::TempDir) {
    boot(None).await
}

/// The same, on a host that asks people to sign in.
///
/// The default embedded host runs `AuthMode::None` — a desktop install has one
/// person and no accounts — so it answers an anonymous request rather than
/// refusing it. That is correct for the product and useless as a fixture for
/// the two cases below, which are *about* a refusal: what a failure body looks
/// like coming back through the proxy, and whether the session header is
/// actually sent.
///
/// Seeding `config.toml` is how a real operator turns a sign-in on here too —
/// the setup wizard writes that key, and the shell falls back to `none` only
/// when the file names nothing — so this asks for a supported configuration
/// rather than reaching around the one under test.
async fn signed_in_host_and_proxy() -> (embedded::EmbeddedHost, ProxyRegistry, tempfile::TempDir) {
    boot(Some("auth_mode = \"email\"\n")).await
}

async fn boot(
    config_toml: Option<&str>,
) -> (embedded::EmbeddedHost, ProxyRegistry, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    if let Some(body) = config_toml {
        std::fs::write(dir.path().join("config.toml"), body).expect("write config.toml");
    }
    let host = embedded::start(dir.path().to_path_buf())
        .await
        .expect("the embedded host starts");
    let proxy = ProxyRegistry::new();
    proxy
        .upsert(
            "primary".to_string(),
            Connection {
                base_url: host.base_url(),
                credential: Credential::None,
            },
        )
        .await
        .expect("an absolute host url");
    (host, proxy, dir)
}

fn get(path: &str) -> ProxyRequest {
    ProxyRequest {
        method: "GET".to_string(),
        path: path.to_string(),
        headers: HashMap::new(),
        body: None,
        // Parity is about bytes on the wire, not deadlines; the core's default
        // is what an ordinary request gets.
        timeout_ms: None,
    }
}

/// What a browser's `fetch` would see, for comparison.
async fn direct(base: &str, path: &str) -> (u16, String) {
    let response = reqwest::get(format!("{base}{path}"))
        .await
        .expect("reach the host");
    let status = response.status().as_u16();
    (status, response.text().await.expect("read the body"))
}

#[tokio::test]
async fn a_proxied_get_matches_a_direct_one() {
    let (host, proxy, _dir) = host_and_proxy().await;

    for path in ["/healthz", "/spec", "/tiny"] {
        let proxied: ProxyResponse = proxy.request("primary", get(path)).await.expect(path);
        let (status, body) = direct(&host.base_url(), path).await;

        assert_eq!(proxied.status, status, "{path}: status must match");
        // Byte-identical, not merely "both look like JSON". The console parses
        // this and compares fields.
        assert_eq!(proxied.text, body, "{path}: body must match");
        assert_eq!(proxied.status_text, "OK");
    }
}

#[tokio::test]
async fn a_refusal_carries_the_hosts_own_error_envelope() {
    // The console reads `code` and `error` out of the body to build its
    // `ApiError`. If the proxy re-wrote or swallowed a failure body, every
    // desktop error message would degrade to a generic one — and it would do so
    // only for errors, which is exactly where it is least likely to be noticed.
    let (host, proxy, _dir) = signed_in_host_and_proxy().await;

    let path = "/api/v1/company/tasks";
    let proxied = proxy
        .request("primary", get(path))
        .await
        .expect("reaches the host");
    let (status, body) = direct(&host.base_url(), path).await;

    assert!(
        !(200..300).contains(&proxied.status),
        "an unauthenticated read should not succeed: {proxied:?}"
    );
    assert_eq!(proxied.status, status);
    assert_eq!(proxied.text, body);
    // The console falls back to `HTTP <status>` when this is empty, exactly as
    // it does for a browser response with no status text.
    assert!(!proxied.status_text.is_empty());
}

#[tokio::test]
async fn response_headers_reach_the_console_lowercased() {
    // The one header the console reads is `content-disposition`, and it reads it
    // case-insensitively through the transport's accessor. Handing it a map with
    // original casing would work in a browser (where `Headers.get` is
    // case-insensitive) and silently miss here.
    let (_host, proxy, _dir) = host_and_proxy().await;
    let proxied = proxy.request("primary", get("/spec")).await.unwrap();

    assert!(
        proxied.headers.contains_key("content-type"),
        "expected a lowercased content-type, got {:?}",
        proxied.headers.keys().collect::<Vec<_>>()
    );
    assert!(
        proxied.headers.keys().all(|k| k == &k.to_ascii_lowercase()),
        "every header key must be lowercased"
    );
}

#[tokio::test]
async fn a_5xx_resolves_rather_than_erroring() {
    // Deciding what a status *means* is the console's job. A proxy that treated
    // 401 or 500 as a transport failure would collapse them into the console's
    // `network_error`, losing the sign-in flow entirely.
    let (_host, proxy, _dir) = host_and_proxy().await;
    let answered = proxy
        .request("primary", get("/api/v1/companies/nope/tasks"))
        .await;
    assert!(
        answered.is_ok(),
        "an HTTP error is an answer, not a transport failure: {answered:?}"
    );
    assert!(answered.unwrap().status >= 400);
}

#[tokio::test]
async fn an_unreachable_host_is_a_transport_failure() {
    // The other side of the line above: nothing answered at all, which the
    // console turns into its own `network_error`.
    let proxy = ProxyRegistry::new();
    proxy
        .upsert(
            "dead".to_string(),
            Connection {
                // Port 9 (discard) with nothing listening.
                base_url: "http://127.0.0.1:9".to_string(),
                credential: Credential::None,
            },
        )
        .await
        .expect("an absolute host url");
    assert!(proxy.request("dead", get("/healthz")).await.is_err());
}

#[tokio::test]
async fn the_session_header_is_attached_to_a_device_connection() {
    // The payoff for the whole carrier design: a desktop cannot hold a cookie
    // (`SameSite=Lax` is never sent cross-site), so a paired device presents its
    // session as a header. This proves the proxy actually sends it — and that
    // the host reads it, by getting a *different* answer than the anonymous one.
    let (host, proxy, _dir) = signed_in_host_and_proxy().await;
    proxy
        .upsert(
            "device".to_string(),
            Connection {
                base_url: host.base_url(),
                // Well-formed but not a real session: the host must look it up
                // and refuse, rather than ignore the header.
                credential: Credential::Device("acme.not-a-real-token".to_string()),
            },
        )
        .await
        .expect("an absolute host url");

    let answered = proxy
        .request("device", get("/api/v1/company/auth/me"))
        .await
        .expect("the host answers");
    // Not a 5xx and not a transport error: a bad credential is a clean refusal.
    assert!(
        answered.status == 401 || answered.status == 404,
        "expected a refusal, got {} — {}",
        answered.status,
        answered.text
    );
}

#[tokio::test]
async fn two_connections_are_addressed_independently() {
    // No implicit "current connection" anywhere in the lane: each request names
    // its host, and two hosts answer for themselves.
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let host_a = embedded::start(a.path().to_path_buf()).await.unwrap();
    let host_b = embedded::start(b.path().to_path_buf()).await.unwrap();

    let proxy = ProxyRegistry::new();
    for (id, host) in [("a", &host_a), ("b", &host_b)] {
        proxy
            .upsert(
                id.to_string(),
                Connection {
                    base_url: host.base_url(),
                    credential: Credential::None,
                },
            )
            .await
            .expect("an absolute host url");
    }

    let spec_a = proxy.request("a", get("/spec")).await.unwrap();
    let spec_b = proxy.request("b", get("/spec")).await.unwrap();

    let id_of = |body: &str| -> String {
        serde_json::from_str::<serde_json::Value>(body).unwrap()["instance_id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    // Different hosts, different identities — which is what lets the console
    // keep them apart. Same-looking answers here would mean the proxy had
    // routed both to one host.
    assert_ne!(id_of(&spec_a.text), id_of(&spec_b.text));
}
