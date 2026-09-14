//! The desktop's HTTP and event lane, in Rust rather than in the webview.
//!
//! ## Why the console does not talk to hosts directly
//!
//! Three reasons, in the order they bite:
//!
//! 1. **CORS.** A webview origin (`tauri://localhost`) is cross-origin with
//!    every host. Fetching directly would require each operator to add that
//!    origin to `OPENCOMPANY_CORS_ORIGINS` before their desktop could connect —
//!    a per-server configuration step standing in front of the product's
//!    headline feature. Requests made from Rust are not subject to CORS at all.
//! 2. **The credential.** A device token attached here never enters the
//!    webview, so a cross-site-scripting bug in rendered agent markdown cannot
//!    exfiltrate N hosts' credentials. It lives in the OS keychain and is read
//!    by this process.
//! 3. **Streaming.** `EventSource` cannot set a request header, so it cannot
//!    carry the session header at all, and a `SameSite=Lax` cookie is never
//!    sent cross-site. There is no way for a desktop webview to open the event
//!    stream on its own.
//!
//! ## The shape, and the one rule
//!
//! [`ProxyRegistry`] holds a `HashMap<ConnectionId, Connection>`. **Never a
//! single "active connection".** That is the field that stops block/buzz from
//! holding more than one relay at a time, and every command here takes an
//! explicit `connection_id` for the same reason — an implicit current
//! connection would reintroduce it through the back door.

pub mod sse;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

pub use sse::SseDecoder;

/// A connection's id, minted by the console and opaque here.
pub type ConnectionId = String;

/// How this client authenticates to one host.
#[derive(Clone, Debug, Default)]
pub enum Credential {
    /// Nothing to present. A host that needs one answers 401 and the console
    /// shows its sign-in.
    #[default]
    None,
    /// A paired device session, presented in the header carrier as
    /// `<company>.<token>`.
    ///
    /// Held as the fully-rendered header value rather than as its parts,
    /// because that is the only form anything here needs — and a struct with a
    /// `token` field invites something to log it.
    Device(String),
    /// A platform bearer, for the hosting layer.
    Platform(String),
}

impl Credential {
    /// Whether a request for this connection carries a secret.
    ///
    /// The transport rule below turns on this and nothing else: reading a host
    /// over plain HTTP exposes what a passer-by could have asked for
    /// themselves, and attaching a credential to the same request exposes the
    /// one thing they could not.
    fn is_present(&self) -> bool {
        !matches!(self, Credential::None)
    }
}

/// One host this client is connected to.
#[derive(Clone, Debug)]
pub struct Connection {
    pub base_url: String,
    pub credential: Credential,
}

/// What a request gets when the caller asks for nothing in particular.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest any single request may ask for.
///
/// The console is trusted to name a route's deadline, not to remove one: this
/// value arrives from the webview, and an unbounded request would hold a
/// connection open for as long as a renderer felt like. Sized above the host's
/// longest deliberate deadline — the profile design pass at 90 seconds — with
/// room for the round trip.
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// The deadline for one request: what was asked for, clamped, or the default.
fn request_timeout(asked: Option<u64>) -> Duration {
    match asked {
        Some(ms) if ms > 0 => Duration::from_millis(ms).min(MAX_REQUEST_TIMEOUT),
        // Zero is not "no deadline" — nothing in the console means that, and
        // reading it as unbounded would turn a bug into a hung connection.
        _ => DEFAULT_REQUEST_TIMEOUT,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub method: String,
    /// Origin-relative, e.g. `/api/v1/company/tasks`. The host is the
    /// connection's, so a caller cannot aim one connection's credential at
    /// another origin by passing an absolute URL.
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// How long this one request may take, in milliseconds.
    ///
    /// `None` — an older console, or a caller with nothing to say — keeps
    /// [`DEFAULT_REQUEST_TIMEOUT`]. It exists because that default is invisible
    /// from the console: a route the **host** deliberately allows longer than
    /// it (the teammate design pass runs a model to 90 seconds) was cut off at
    /// 30 here and reached the operator as a refusal, on the desktop app only.
    /// Only the caller knows which route it is asking for, so the deadline
    /// crosses the bridge with the request.
    ///
    /// Clamped to [`MAX_REQUEST_TIMEOUT`] on the way in: this arrives from the
    /// webview, and a deadline is not a thing to let a renderer set without a
    /// ceiling.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Mirrors the console's `TransportResponse` exactly.
///
/// Field-for-field with what `BrowserTransport` produces, because the console's
/// error handling reads all of it: the status decides success, `statusText`
/// becomes the message when the host sends no envelope, and the header map
/// answers the one `content-disposition` read. A shape that merely resembled it
/// would produce subtly different `ApiError`s on one transport.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResponse {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub text: String,
    /// Lowercased response header names to values.
    pub headers: HashMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("no such connection: {0}")]
    UnknownConnection(ConnectionId),
    #[error("not an absolute host url: {0:?}")]
    UnusableBaseUrl(String),
    /// A credentialed connection to a plain-HTTP host that is not this machine.
    ///
    /// Separate from [`Self::UnusableBaseUrl`] because the two are opposite
    /// problems wearing one message. That one means the url addresses nothing;
    /// this one means it addresses a host perfectly well, over a wire anyone on
    /// the path can read. An operator told "could not be reached" about the
    /// second goes looking at their network, which is working (#613's
    /// complaint, one rung up).
    #[error("this host is not encrypted, so a credential cannot be sent to it: {0:?}")]
    InsecureBaseUrl(String),
    #[error("{0}")]
    Transport(String),
}

impl serde::Serialize for ProxyErrorWire {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

/// The wire form of a [`ProxyError`]: a plain string.
///
/// The console turns *any* rejection into its own `network_error` — the
/// transport's own words are deliberately not surfaced, because they differ per
/// transport and the message is shown to a person. So there is nothing to
/// structure here.
#[derive(Debug)]
pub struct ProxyErrorWire(pub String);

impl From<ProxyError> for ProxyErrorWire {
    fn from(error: ProxyError) -> Self {
        Self(error.to_string())
    }
}

/// Every host this client is connected to.
#[derive(Debug)]
pub struct ProxyRegistry {
    connections: RwLock<HashMap<ConnectionId, Connection>>,
    http: reqwest::Client,
}

impl Default for ProxyRegistry {
    fn default() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                // A host that accepts a connection but never answers must not
                // hold a console command open forever. Deliberately *not* a
                // client-wide `timeout`: that would also cut the long-lived
                // `subscribe` event stream.
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("reqwest client with fixed settings cannot fail"),
        }
    }
}

impl ProxyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers or replaces a connection.
    ///
    /// Refuses a base url this registry could never request. `join` is textual,
    /// so a relative base — `""` above all, which a browser reads as "same
    /// origin" — yields a relative url, and `reqwest` rejects that at `send`.
    /// Every request for the connection then fails identically, and the failure
    /// says "could not be reached" about a host that was never addressed.
    ///
    /// Registration is where that has to be caught. It is the moment the base
    /// url is known and the last one at which the caller is still on the stack;
    /// afterwards the mistake is only visible as a network fault, which is how
    /// the desktop came to open on an unreachable connection every launch
    /// (issue #613).
    pub async fn upsert(&self, id: ConnectionId, connection: Connection) -> Result<(), ProxyError> {
        // Parsing alone is too weak a test. `mailto:someone@example.com` and
        // `ftp://host` are both valid urls and neither is something this client
        // can send an OpenCompany request to — so the scheme is checked, and
        // the authority with it, because a scheme without a host is the same
        // relative-url problem wearing a prefix.
        let addressable = reqwest::Url::parse(&connection.base_url)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host());
        if !addressable {
            return Err(ProxyError::UnusableBaseUrl(connection.base_url));
        }
        // Checked here rather than at `request`, for the same reason the
        // addressability test is: registration is the last moment the caller is
        // still on the stack and can be told why. A per-request check would
        // refuse each call individually, and the console renders that as a host
        // that cannot be reached.
        if connection.credential.is_present() && !may_carry_a_credential(&connection.base_url) {
            return Err(ProxyError::InsecureBaseUrl(connection.base_url));
        }
        self.connections.write().await.insert(id, connection);
        Ok(())
    }

    pub async fn remove(&self, id: &str) {
        self.connections.write().await.remove(id);
    }

    pub async fn ids(&self) -> Vec<ConnectionId> {
        self.connections.read().await.keys().cloned().collect()
    }

    /// The base url a connection is registered against.
    ///
    /// Returns the url alone, never the [`Connection`]: `get` is private
    /// precisely so a credential cannot leave this registry, and a public
    /// accessor handing back the whole struct would put `Credential::Device`
    /// one `serde` derive away from the webview. The only caller needs the url
    /// — to re-register after a credential changes — so the url is all it gets.
    pub async fn base_url(&self, id: &str) -> Result<String, ProxyError> {
        self.get(id).await.map(|connection| connection.base_url)
    }

    async fn get(&self, id: &str) -> Result<Connection, ProxyError> {
        self.connections
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| ProxyError::UnknownConnection(id.to_string()))
    }

    /// Performs one request against `id`'s host.
    ///
    /// Resolves for every HTTP status, including 5xx — deciding what a status
    /// means is the console's job, and a proxy that errored on 401 would move
    /// session handling into Rust where only half of it lives.
    pub async fn request(
        &self,
        id: &str,
        request: ProxyRequest,
    ) -> Result<ProxyResponse, ProxyError> {
        let connection = self.get(id).await?;
        let url = join(&connection.base_url, &request.path);

        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| ProxyError::Transport(format!("bad method {:?}", request.method)))?;
        let mut builder = self
            .http
            .request(method, &url)
            // Per-request, not client-wide: `subscribe` must stay long-lived.
            .timeout(request_timeout(request.timeout_ms));
        for (name, value) in &request.headers {
            // The proxy owns the session/authority headers; a caller-supplied
            // copy would be appended rather than replaced, leaving the host to
            // arbitrate between two session values. See `RESERVED_HEADERS`.
            if RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            builder = builder.header(name, value);
        }
        builder = apply_credential(builder, &connection.credential);
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let response = builder
            .send()
            .await
            .map_err(|error| ProxyError::Transport(error.to_string()))?;

        let status = response.status();
        let final_url = response.url().to_string();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
            })
            .collect();
        let text = response
            .text()
            .await
            .map_err(|error| ProxyError::Transport(error.to_string()))?;

        Ok(ProxyResponse {
            status: status.as_u16(),
            // `canonical_reason` is absent for a non-standard status; the
            // console falls back to `HTTP <status>` when this is empty, which is
            // the same thing `BrowserTransport` does with an empty `statusText`.
            status_text: status.canonical_reason().unwrap_or_default().to_string(),
            url: final_url,
            text,
            headers,
        })
    }

    /// Opens `id`'s event stream, handing each payload to `on_event`.
    ///
    /// Runs until the stream ends or the host goes away; the caller spawns it
    /// and drops the task to unsubscribe. Reconnection is deliberately absent —
    /// the console already polls as its safety net, and a retry loop here would
    /// be a second, invisible one.
    pub async fn subscribe<F>(
        &self,
        id: &str,
        path: &str,
        mut on_event: F,
    ) -> Result<(), ProxyError>
    where
        F: FnMut(String) + Send,
    {
        let connection = self.get(id).await?;
        let url = join(&connection.base_url, path);

        let mut builder = self.http.get(&url).header("accept", "text/event-stream");
        builder = apply_credential(builder, &connection.credential);
        let response = builder
            .send()
            .await
            .map_err(|error| ProxyError::Transport(error.to_string()))?;

        if !response.status().is_success() {
            return Err(ProxyError::Transport(format!(
                "event stream refused with {}",
                response.status()
            )));
        }

        let mut decoder = SseDecoder::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| ProxyError::Transport(error.to_string()))?;
            // Bytes, not `from_utf8_lossy` per chunk: a read boundary can fall
            // inside a multi-byte codepoint, and decoding each chunk on its own
            // would turn both halves into U+FFFD. The decoder holds the
            // incomplete tail until the chunk that finishes it. Genuinely
            // malformed bytes are still lossy — a stream is not a place to fail
            // over one bad sequence, and the payloads are JSON the console
            // re-parses.
            for event in decoder.push_bytes(&chunk) {
                on_event(event);
            }
        }
        Ok(())
    }
}

/// Header names the proxy owns, matched case-insensitively.
///
/// The console passes its request headers straight through
/// (`ProxyTransport.request`), and `RequestBuilder::header` **appends** rather
/// than replaces — so without this filter a header the webview supplied and the
/// credential attached alongside it would both go on the wire under one name.
/// Axum reads `HeaderMap::get`, which returns the *first*, so the webview's
/// value would win and the connection's own credential would be the one
/// ignored.
///
/// That inverts the property this module exists for. The token never entering
/// the webview is worth little if the webview can still say what the request
/// authenticates as — a script injected into rendered agent markdown could
/// present a credential of its choosing to every connected host.
///
/// Dropped rather than rejected: these are not headers a legitimate console
/// call sets, so refusing the whole request would turn a defence into a way to
/// break one.
const RESERVED_HEADERS: [&str; 4] = [
    // The session carrier `apply_credential` sets for a paired device.
    "x-opencompany-session",
    // The platform bearer, via `bearer_auth`.
    "authorization",
    // Neither is set here, but both are ambient authority all the same, and a
    // caller has no reason to hand-roll one through the proxy.
    "cookie",
    "proxy-authorization",
];

/// Whether a secret may be sent to `base_url`.
///
/// **HTTPS, or a host that is this machine.** Plain HTTP to anything else puts
/// the credential in front of every device on the path — and for the desktop
/// that credential is a device session, which is a person's standing authority
/// on a company rather than one request's.
///
/// Loopback is the exception and not a grudging one: `http://127.0.0.1:<port>`
/// is how the embedded host is reached (`embedded.rs` binds `127.0.0.1:0`),
/// those bytes never reach a network interface, and a certificate for an
/// ephemeral port is not a thing that can exist. `localhost` is admitted with
/// it because that is what a developer types into `?api=`; RFC 6761 reserves
/// the name for exactly this.
///
/// Deliberately **not** an allowlist of private ranges. `10.0.0.0/8` and
/// `192.168.0.0/16` are the networks this is meant to protect against — an
/// office LAN is precisely where someone else is on the path — so treating
/// them as trusted would invert the rule while looking like a refinement of it.
///
/// Public because the pairing claim in `commands.rs` needs the same answer and
/// does not go through this registry. Two copies of one rule is how the console
/// and the core came to disagree about addressability; one function is the fix.
pub fn may_carry_a_credential(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    url.scheme() == "https" || addresses_this_machine(&url)
}

/// Whether this url names the machine it is being requested from.
///
/// Reads the host as text rather than matching on `url::Host`, so this module
/// does not take a direct dependency on `url` for one match arm; the `url`
/// crate already lowercased and normalised it on the way in.
fn addresses_this_machine(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    // `host_str` brackets an IPv6 literal, as it appears in the url.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(address) = bare.parse::<std::net::IpAddr>() {
        // Canonicalised so that `::ffff:127.0.0.1` — which routes to loopback —
        // is not refused for being spelled as IPv6. `to_canonical` leaves an
        // ordinary v4 address alone.
        return address.to_canonical().is_loopback();
    }
    // A name, not an address. Only the one RFC 6761 guarantees resolves to
    // loopback, and the subdomains it guarantees with it — anything else is a
    // DNS answer this process has not seen yet and cannot vouch for.
    bare == "localhost" || bare.ends_with(".localhost")
}

/// Attaches whatever this connection authenticates with.
fn apply_credential(
    builder: reqwest::RequestBuilder,
    credential: &Credential,
) -> reqwest::RequestBuilder {
    match credential {
        Credential::None => builder,
        // The header carrier, which exists precisely because a desktop cannot
        // use the cookie: `SameSite=Lax` means a browser never sends one
        // cross-site, and a webview is cross-site with every host.
        Credential::Device(value) => builder.header("x-opencompany-session", value),
        Credential::Platform(token) => builder.bearer_auth(token),
    }
}

/// Joins a base URL and an origin-relative path.
///
/// Both halves are normalised so that a base with a trailing slash and a path
/// with a leading one cannot produce `//api/v1`, which some hosts route
/// differently and some proxies rewrite.
fn join(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// A registry shared with the Tauri command layer.
pub type SharedProxy = Arc<ProxyRegistry>;

#[cfg(test)]
mod test {
    use super::*;

    /// A route the host allows longer than the core's default gets what it
    /// asked for, and a renderer cannot ask for forever.
    ///
    /// The bug: the core applied a flat 30-second `reqwest` timeout that the
    /// console could not see, while the host deliberately allows the teammate
    /// design pass 90 seconds. Every slow-but-valid design on the desktop app
    /// came back as a transport failure and handed the operator the full form
    /// — a refusal for a pass that was working.
    #[test]
    fn a_request_deadline_is_honoured_clamped_and_defaulted() {
        // What `designTeammate` asks for: the host's 90s plus the round trip.
        assert_eq!(
            request_timeout(Some(105_000)),
            Duration::from_millis(105_000),
            "a route that names its own deadline must get it"
        );
        // An older console, or a caller with nothing to say.
        assert_eq!(request_timeout(None), DEFAULT_REQUEST_TIMEOUT);
        // Zero is not "unbounded" — nothing in the console means that, and
        // reading it as unbounded would turn a bug into a hung connection.
        assert_eq!(request_timeout(Some(0)), DEFAULT_REQUEST_TIMEOUT);
        // The value arrives from the webview, so it is capped.
        assert_eq!(request_timeout(Some(u64::MAX)), MAX_REQUEST_TIMEOUT);
        assert!(
            MAX_REQUEST_TIMEOUT > Duration::from_secs(90),
            "the cap has to sit above the host's longest deliberate deadline"
        );
    }

    /// A one-shot host that answers with the request head it received.
    ///
    /// Deliberately raw TCP rather than a framework: what is under test is
    /// which bytes leave this process, and anything that parses the request
    /// into a map on the way in could normalise away the very duplicate the
    /// test exists to catch.
    async fn reflector() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            // Read to the end of the head only; a body would block a reader
            // that does not know the content length.
            while !head.ends_with(b"\r\n\r\n") {
                use tokio::io::AsyncReadExt as _;
                if socket.read_exact(&mut byte).await.is_err() {
                    break;
                }
                head.push(byte[0]);
            }
            use tokio::io::AsyncWriteExt as _;
            let body = String::from_utf8_lossy(&head).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
        format!("http://{addr}")
    }

    /// The webview must not be able to choose what a request authenticates as.
    ///
    /// `RequestBuilder::header` appends, and axum reads `HeaderMap::get`, which
    /// takes the first value — so a caller-supplied session header that reached
    /// the wire would be the one the host honoured, and the connection's own
    /// credential would be the one ignored.
    #[tokio::test]
    async fn a_caller_cannot_supply_the_credential_headers() {
        let base = reflector().await;
        let registry = ProxyRegistry::new();
        registry
            .upsert(
                "primary".into(),
                Connection {
                    base_url: base,
                    credential: Credential::Device("acme.the-real-token".into()),
                },
            )
            .await
            .expect("an absolute host url");

        let mut headers = HashMap::new();
        headers.insert(
            "x-opencompany-session".to_string(),
            "evil.stolen".to_string(),
        );
        headers.insert("Authorization".to_string(), "Bearer evil".to_string());
        headers.insert("cookie".to_string(), "oc_session_acme=evil".to_string());
        // An ordinary header must still get through; this is a filter, not a
        // seal.
        headers.insert("content-type".to_string(), "application/json".to_string());

        let reflected = registry
            .request(
                "primary",
                ProxyRequest {
                    method: "POST".into(),
                    path: "/api/v1/anything".into(),
                    headers,
                    body: None,
                    timeout_ms: None,
                },
            )
            .await
            .expect("the reflector answers")
            .text
            .to_ascii_lowercase();

        assert!(
            reflected.contains("x-opencompany-session: acme.the-real-token"),
            "the connection's own credential must be on the wire: {reflected}"
        );
        assert_eq!(
            reflected.matches("x-opencompany-session:").count(),
            1,
            "exactly one session header, or the host reads the wrong one: {reflected}"
        );
        for forbidden in ["evil.stolen", "bearer evil", "oc_session_acme=evil"] {
            assert!(
                !reflected.contains(forbidden),
                "{forbidden:?} must not reach the host: {reflected}"
            );
        }
        assert!(
            reflected.contains("content-type: application/json"),
            "an ordinary header must still pass: {reflected}"
        );
    }

    #[test]
    fn credential_header_matching_ignores_case() {
        // A caller sends whatever casing it likes; HTTP header names are
        // case-insensitive, so a case-sensitive filter would be no filter.
        let reserved = |name: &str| RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str());
        for name in ["Authorization", "AUTHORIZATION", "X-OpenCompany-Session"] {
            assert!(reserved(name), "{name} must be filtered");
        }
        for name in ["content-type", "accept", "x-request-id"] {
            assert!(!reserved(name), "{name} must pass");
        }
    }

    #[tokio::test]
    async fn the_public_accessor_hands_back_no_credential() {
        // `get` is private so a credential cannot leave this registry. The one
        // public accessor exists for a caller that needs somewhere to re-point
        // a connection, and it must stay a url — a `Connection` here would put
        // `Credential::Device` one `serde` derive away from the webview.
        let registry = ProxyRegistry::new();
        registry
            .upsert(
                "primary".into(),
                Connection {
                    base_url: "https://acme.test".into(),
                    credential: Credential::Device("acme.the-secret".into()),
                },
            )
            .await
            .expect("an absolute host url");

        let url = registry
            .base_url("primary")
            .await
            .expect("a registered host");
        assert_eq!(url, "https://acme.test");
        // The type is what enforces this; the assertion is here so a future
        // widening of the return type has to delete a test that says why.
        assert!(!url.contains("the-secret"));
    }

    #[test]
    fn joining_never_doubles_a_slash() {
        assert_eq!(join("http://h.test", "/api/v1"), "http://h.test/api/v1");
        assert_eq!(join("http://h.test/", "/api/v1"), "http://h.test/api/v1");
        assert_eq!(join("http://h.test/", "api/v1"), "http://h.test/api/v1");
    }

    /// A base url with no authority is not a host, and saying so early is the
    /// whole point.
    ///
    /// This test used to assert the opposite — that `join("", "/api/v1")`
    /// giving `/api/v1` was fine, on the theory that an empty base meant
    /// "same origin, port not known yet". Nothing here has an origin to be the
    /// same as: the embedded host reports a real `127.0.0.1:<port>` once it
    /// binds, and `reqwest` cannot request a relative url from any of them. The
    /// comment made an unreachable connection look intentional, and the desktop
    /// duly shipped one (issue #613).
    #[tokio::test]
    async fn a_base_url_that_names_no_host_is_refused_at_registration() {
        let registry = ProxyRegistry::new();
        for base in [
            "",
            "   ",
            "/api/v1",
            "acme.test",
            // Valid urls, both of them, and neither is a host this client can
            // send a request to. Parsing is not the question; addressability is.
            "mailto:user@example.com",
            "ftp://host",
        ] {
            let error = registry
                .upsert(
                    "primary".into(),
                    Connection {
                        base_url: base.into(),
                        credential: Credential::None,
                    },
                )
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains("not an absolute host url"),
                "{base:?} must be refused by name, not silently: {error}"
            );
        }
        // Refused means not registered, rather than registered and broken.
        assert!(registry.ids().await.is_empty());
    }

    /// A session must not be handed to a host anyone on the path can read.
    ///
    /// Every request for a connection carries `apply_credential`'s header, so a
    /// device session registered against a plain-HTTP LAN address is on the
    /// wire in the clear on every poll and for the whole life of the event
    /// stream — and unlike a leaked request body, it is replayable (#731).
    #[tokio::test]
    async fn a_credential_is_refused_on_an_unencrypted_remote_host() {
        let registry = ProxyRegistry::new();
        for base in [
            "http://192.168.1.20:8080",
            "http://acme.example.com",
            // Not loopback despite the name. A host may call itself whatever it
            // likes, and only the reserved name resolves here by rule.
            "http://localhost.acme.example.com",
            // The private ranges are the ones this exists for, not exceptions
            // to it: an office LAN is exactly where someone else is on the path.
            "http://10.0.0.4:8080",
        ] {
            for credential in [
                Credential::Device("acme.the-session".into()),
                Credential::Platform("a-bearer".into()),
            ] {
                let error = registry
                    .upsert(
                        "primary".into(),
                        Connection {
                            base_url: base.into(),
                            credential,
                        },
                    )
                    .await
                    .unwrap_err();
                assert!(
                    error.to_string().contains("this host is not encrypted"),
                    "{base:?} must be refused for the reason it is refused: {error}"
                );
            }
        }
        assert!(registry.ids().await.is_empty());
    }

    /// The three ways a connection stays legitimate under that rule.
    #[tokio::test]
    async fn https_loopback_and_anonymous_http_all_still_register() {
        let registry = ProxyRegistry::new();
        let cases = [
            // HTTPS carries a credential anywhere.
            (
                "https",
                "https://acme.example.com",
                Credential::Device("acme.s".into()),
            ),
            // Loopback is how the embedded host is reached, and it is the one
            // address a certificate cannot be issued for — `embedded.rs` binds
            // `127.0.0.1:0`, so the port is different every launch.
            (
                "v4",
                "http://127.0.0.1:65364",
                Credential::Device("acme.s".into()),
            ),
            // The rest of `127.0.0.0/8`, which a second local host may bind.
            (
                "v4-block",
                "http://127.0.0.2:8080",
                Credential::Device("acme.s".into()),
            ),
            (
                "v6",
                "http://[::1]:8080",
                Credential::Device("acme.s".into()),
            ),
            // What a developer types into `?api=`.
            (
                "name",
                "http://localhost:8080",
                Credential::Device("acme.s".into()),
            ),
            // Anonymous HTTP anywhere: nothing is exposed that a passer-by
            // could not have asked the host for themselves. This is the case
            // the narrow rule exists to keep working — a home-lab or staging
            // box without a certificate stays readable.
            ("anonymous", "http://192.168.1.20:8080", Credential::None),
        ];
        for (id, base, credential) in cases {
            registry
                .upsert(
                    id.into(),
                    Connection {
                        base_url: base.into(),
                        credential,
                    },
                )
                .await
                .unwrap_or_else(|error| panic!("{base:?} must still register: {error}"));
        }
        assert_eq!(registry.ids().await.len(), 6);
    }

    /// The shorthand spellings of a loopback address, and of everything else.
    ///
    /// `Url::parse` normalises `127.1` and `0177.0.0.1` to `127.0.0.1`, so a
    /// textual comparison cannot be walked past — asserted here because that is
    /// a property of the parser rather than of this module, and a change to it
    /// would otherwise turn into a silently widened rule.
    #[test]
    fn the_loopback_test_reads_addresses_rather_than_strings() {
        for allowed in [
            "http://127.1:8080",
            "http://0177.0.0.1:8080",
            "http://[::ffff:127.0.0.1]:8080",
            "http://sub.localhost:8080",
            "https://acme.example.com",
        ] {
            assert!(may_carry_a_credential(allowed), "{allowed} must be allowed");
        }
        for refused in [
            "http://192.168.1.20:8080",
            "http://127.0.0.1.acme.example.com",
            "http://acme.example.com",
            // Not a url at all, and not addressable either; `upsert` refuses it
            // first, but this must not answer "yes" on its own.
            "not-a-url",
        ] {
            assert!(
                !may_carry_a_credential(refused),
                "{refused} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn an_unknown_connection_is_named_rather_than_guessed() {
        let registry = ProxyRegistry::new();
        let error = registry
            .request(
                "nope",
                ProxyRequest {
                    method: "GET".into(),
                    path: "/healthz".into(),
                    headers: HashMap::new(),
                    body: None,
                    timeout_ms: None,
                },
            )
            .await
            .expect_err("an unregistered connection has no host to reach");
        assert!(error.to_string().contains("nope"));
    }

    #[tokio::test]
    async fn connections_are_independent_entries_not_one_active_slot() {
        // The buzz regression, at the Rust boundary: two hosts coexist, and
        // removing one leaves the other addressable.
        let registry = ProxyRegistry::new();
        registry
            .upsert(
                "a".into(),
                Connection {
                    base_url: "http://a.test".into(),
                    credential: Credential::None,
                },
            )
            .await
            .expect("an absolute host url");
        registry
            .upsert(
                "b".into(),
                Connection {
                    base_url: "http://b.test".into(),
                    credential: Credential::None,
                },
            )
            .await
            .expect("an absolute host url");

        let mut ids = registry.ids().await;
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        registry.remove("a").await;
        assert_eq!(registry.ids().await, vec!["b".to_string()]);
    }
}
