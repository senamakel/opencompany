//! Per-tenant Composio credential + backend routing (issue #110, epic #26 Cell
//! D). Always compiled (so the console read/write plane can manage the token
//! even in the default build); the live agent tools that consume it live in the
//! feature-gated [`harness::composio`](crate::harness::composio).
//!
//! The per-tenant OAuth bearer token is **write-only**: it is set through the
//! console `PUT …/composio/token` route, stored under [`TOKEN_KEY`], and never
//! returned. The read shape carries only a `tokenConfigured` boolean. The token
//! has **no environment fallback** — a missing token means no tools (fail
//! closed), never a borrowed identity. Only the backend URL may be overridden
//! from the environment.

use std::sync::Arc;

use serde::Serialize;

use crate::Result;
use crate::company::company_key;
use crate::company::credentials::{Credential, TinyhumansTokenSource};
use crate::ports::SecretStore;
use crate::ports::types::{CompanyId, SecretValue};

/// The canonical per-company Composio credential key. The per-tenant OAuth
/// bearer token is stored here (write-only via the console); the value is the
/// raw token string.
pub const TOKEN_KEY: &str = "composio/token";

/// The explicit environment override for the Composio backend URL. Only the
/// **URL** has an env path — the **token** deliberately does not (fail-closed
/// isolation). When unset, resolution falls back to the tenant's shared API
/// base ([`TINYHUMANS_API_URL_ENV`]) so staging Composio follows staging.
pub const COMPOSIO_BACKEND_URL_ENV: &str = "OPENCOMPANY_COMPOSIO_BACKEND_URL";

/// The tenant's shared TinyHumans API base URL (the same backend inference and
/// the rest of the app already use). Used as the Composio backend fallback when
/// [`COMPOSIO_BACKEND_URL_ENV`] is unset, so a staging tenant's Composio calls
/// go to staging instead of the hardcoded prod default.
pub const TINYHUMANS_API_URL_ENV: &str = "TINYHUMANS_API_URL";

/// Default backend base URL for the Composio routes when neither the explicit
/// override nor the tenant API base is set. Mirrors the media backend's default
/// host (prod).
pub const DEFAULT_BACKEND_URL: &str = "https://api.tinyhumans.ai";

/// The effective Composio backend URL, resolved in this order (first non-empty,
/// trimmed, wins):
///
/// 1. `env_override` — [`COMPOSIO_BACKEND_URL_ENV`], the explicit override.
/// 2. `api_url` — [`TINYHUMANS_API_URL_ENV`], the tenant's shared backend base,
///    so Composio follows staging/prod with the rest of the app.
/// 3. [`DEFAULT_BACKEND_URL`] (prod) — last resort.
///
/// Credential-free — safe to surface on the console read plane.
pub fn backend_url_or_default(env_override: Option<String>, api_url: Option<String>) -> String {
    [env_override, api_url]
        .into_iter()
        .flatten()
        .map(|u| u.trim().to_string())
        .find(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string())
}

/// Store (or rotate/clear) the per-tenant Composio token. A non-empty value
/// rotates it; an empty string clears it. Write-only — the value is never read
/// back over the API.
pub async fn store_token(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    token: &str,
) -> Result<()> {
    secrets
        .set(company, TOKEN_KEY, SecretValue(token.trim().to_string()))
        .await
}

/// The credential this company's Composio calls present, or [`Credential::None`]
/// when none can be obtained at all.
///
/// The **one** derivation of that answer, and the reason it lives here rather
/// than in the feature-gated harness: both callers need it in every build.
/// [`TenantComposio::resolve`](crate::harness::composio::TenantComposio::resolve)
/// builds the agent-facing config from it, and the console status route
/// ([`ops::composio`](crate::server::ops::composio)) reports its
/// [`source`](Credential::source) — so the tier the console shows an operator
/// cannot disagree with the identity the agents actually present. Two functions
/// that merely *mirrored* each other's precedence would drift the first time a
/// tier was added to one of them, which is exactly the failure issue #586 exists
/// to remove.
///
/// Precedence: the company's own Composio token ([`TOKEN_KEY`], the BYO escape
/// hatch) wins; otherwise the shared brokered-credential seam
/// [`company_key::resolve`] answers — the company's own TinyHumans key, else this
/// instance's platform identity, else nothing.
///
/// A store read error **propagates** rather than degrading to the next tier —
/// see [`company_key::resolve`] for why an unreadable store must not silently
/// change which account a call is attributed to.
pub async fn resolve_credential(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    token_source: Option<Arc<TinyhumansTokenSource>>,
) -> Result<Credential> {
    let byo = match secrets.get(company, TOKEN_KEY).await? {
        Some(SecretValue(token)) => Credential::from_value(token),
        None => Credential::None,
    };
    Ok(match byo {
        // The company's own Composio token always wins.
        byo @ Credential::Value(_) => byo,
        // Everything else is the shared seam's answer, so a rotated company key
        // reaches Composio the same cycle it reaches every other brokered
        // surface.
        _ => company_key::resolve(company, secrets, token_source).await?,
    })
}

/// Whether a non-empty **BYO override** token is stored under [`TOKEN_KEY`] —
/// never the token itself.
///
/// ## This is not "can this company reach Composio" (issue #886)
///
/// It answers exactly one question about exactly one secret slot: did somebody
/// paste a token into the company's own [`TOKEN_KEY`]. That is the *first* tier
/// of three. [`resolve_credential`] falls through it to the company's own
/// TinyHumans key and then to this instance's platform identity, and on a hosted
/// tenant it is the third tier that answers — nobody pastes a BYO token there.
/// So `false` from here is routinely true of a company whose Composio tools are
/// wired and working, which is precisely what #886 was filed about: the
/// capabilities panel reported `composioTokenConfigured: false` while agents
/// were calling `GITHUB_*` tools successfully in the same session.
///
/// **If you want to know whether Composio will work, call
/// [`resolve_credential`] and ask the returned [`Credential`] — `configured()`
/// for the boolean, [`source`](Credential::source) for the tier.** That is the
/// same derivation the toolbelt gates on
/// ([`TenantComposio::resolve`](crate::harness::composio::TenantComposio::resolve)),
/// so it cannot disagree with what the agents actually hold. Use this function
/// only where the BYO slot itself is the subject — a console field that says
/// whether *this company pasted a token*, not whether it has one.
pub async fn token_configured(company: &CompanyId, secrets: &dyn SecretStore) -> Result<bool> {
    Ok(secrets
        .get(company, TOKEN_KEY)
        .await?
        .map(|SecretValue(token)| !token.trim().is_empty())
        .unwrap_or(false))
}

// ── Routing mode: OpenHuman-managed, or the company's own Composio account ──
//
// Everything above this line is the **managed** route: calls go to the
// OpenHuman/TinyHumans backend (`/agent-integrations/composio/*`), which owns
// the Composio API key, the billing margin and the server-enforced toolkit
// allowlist, and derives the Composio entity from the bearer it is handed.
//
// A company that holds its own Composio account can route around all of that.
// In BYOK mode the harness talks to `backend.composio.dev` directly with that
// company's `x-api-key` — nothing is proxied, nothing is billed here, and the
// providers it can connect are whatever its own Composio dashboard permits.
// This mirrors OpenHuman's own `backend` / `direct` split
// (`vendor/openhuman/src/openhuman/integrations/composio/client.rs::create_composio_client`);
// the vocabulary here is `managed` / `byok` to match the search surface next
// door (`crate::company::search`), which made the same choice first.

/// The [`SecretStore`] key holding this company's Composio routing mode — one
/// of [`MANAGED_MODE`] or [`BYOK_MODE`].
///
/// Stored rather than inferred from "is there an API key", for the reason
/// [`crate::company::search::PROVIDER_SECRET`] is stored: the mode decides
/// which *API* the credential is presented to, and a credential sent to the
/// wrong one fails in a way that reads like a bad credential. It also lets the
/// console report the mode without reading a secret slot at all.
pub const MODE_KEY: &str = "composio/mode";

/// The [`SecretStore`] key holding this company's **own** Composio API key
/// (`ak_…`), written by the console's Composio settings and read only to sign a
/// call. Write-only over the API — never echoed back.
///
/// Distinct from [`TOKEN_KEY`], and not interchangeable with it: that one is a
/// bearer the *TinyHumans backend* recognises, this one is a key *Composio*
/// recognises. They authenticate different hosts.
pub const API_KEY_KEY: &str = "composio/api_key";

/// Storage + wire spelling of [`ComposioMode::Managed`].
pub const MANAGED_MODE: &str = "managed";

/// Storage + wire spelling of [`ComposioMode::Byok`].
pub const BYOK_MODE: &str = "byok";

/// The Composio API host a BYOK company's calls go to directly. Non-secret, and
/// reported by the console in place of the backend URL so an operator can see
/// that the route really did change.
pub const DIRECT_BASE_URL: &str = "https://backend.composio.dev";

/// The Composio entity a BYOK company's authorizations and executes are scoped
/// to.
///
/// `default` on purpose, matching OpenHuman's own direct mode
/// (`config.composio.entity_id`) and matching what a user sees in their own
/// Composio dashboard. Scoping to the company id instead would isolate two
/// OpenCompany companies sharing one key — but it would also hide every
/// connection the operator already made in that account, which is the first
/// thing a BYOK operator looks for. The shared-account caveat is the same one
/// [`TOKEN_KEY`] already carries: two companies pasting one credential share
/// one entity, and that cannot be prevented from this side.
pub const DIRECT_ENTITY_ID: &str = "default";

/// How this company reaches Composio.
///
/// Not a [`CredentialSource`](crate::company::credentials::CredentialSource):
/// that names *whose identity* a call presents, this names *which host* it is
/// presented to. A BYOK company is `Static`-sourced and `Byok`-routed; a
/// company that pasted a [`TOKEN_KEY`] override is `Static`-sourced and
/// `Managed`-routed. Collapsing the two would make either question
/// unanswerable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ComposioMode {
    /// Proxied through the OpenHuman backend — the default, and the only route
    /// that needs no configuration at all.
    #[default]
    Managed,
    /// Straight to `backend.composio.dev` with the company's own API key.
    Byok,
}

impl ComposioMode {
    /// The stable wire spelling (`managed` / `byok`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => MANAGED_MODE,
            Self::Byok => BYOK_MODE,
        }
    }

    /// Whether `raw` names BYOK. Everything else — including an empty slot, a
    /// typo, and a mode from some future shape — reads as [`Self::Managed`].
    ///
    /// Unknown-means-managed rather than unknown-is-an-error because this is
    /// read on the roster path: a hand-edited slot must not be able to take a
    /// company's Composio tools away, and managed is the route that works
    /// without anything being stored.
    ///
    /// ## Why `direct` is accepted too
    ///
    /// Three repos in this org spell this split three ways: OpenHuman says
    /// `direct` / `backend`, TinyMemory says `direct` / `proxied`, and this one
    /// says `byok` / `managed`. Only [`BYOK_MODE`] is ever *written* here, so
    /// the alias is not load-bearing today — it is there because of what the
    /// fallback above would otherwise do to the one spelling somebody is most
    /// likely to reach for.
    ///
    /// `direct` falling through to managed would be silent and wrong in the
    /// specific way this whole surface refuses: a company that asked to act
    /// through its own Composio account would act through the platform's
    /// instead. (It would not *leak* the key — managed resolution reads
    /// [`TOKEN_KEY`] and the company key, never [`API_KEY_KEY`], so the stored
    /// Composio key would simply go unread — but the routing surprise is the
    /// part that matters.) Nothing is gained by making the org's own other
    /// spelling of "the company's own account" mean its opposite here.
    ///
    /// The managed spellings need no aliases: `backend` and `proxied` already
    /// land on [`Self::Managed`] through the fallback, which is what they mean.
    pub fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw.eq_ignore_ascii_case(BYOK_MODE) || raw.eq_ignore_ascii_case("direct") {
            Self::Byok
        } else {
            Self::Managed
        }
    }

    /// Whether this mode talks to Composio directly.
    pub fn is_byok(self) -> bool {
        matches!(self, Self::Byok)
    }
}

impl std::fmt::Display for ComposioMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// This company's stored routing mode, or [`ComposioMode::Managed`].
pub async fn load_mode(company: &CompanyId, secrets: &dyn SecretStore) -> Result<ComposioMode> {
    Ok(secrets
        .get(company, MODE_KEY)
        .await?
        .map(|SecretValue(raw)| ComposioMode::parse(&raw))
        .unwrap_or_default())
}

/// Store (or rotate/clear) this company's own Composio API key **and the mode
/// that goes with it**, returning the resulting mode.
///
/// The two are written together on purpose. A mode without a key is a company
/// with no Composio tools (see [`resolve_access`], which fails closed rather
/// than borrowing the platform identity), and a key without a mode is a
/// credential nothing reads — both are states an operator can reach only if
/// this function lets them. A non-empty value therefore sets the key and
/// selects [`ComposioMode::Byok`]; an empty one clears the key and returns the
/// company to [`ComposioMode::Managed`].
///
/// The writes are ordered by **direction**, not fixed key-then-mode: whichever
/// order leaves a failed second write inert, rather than in the outage this
/// whole function exists to rule out.
///
/// Selecting BYOK writes the key first. If the mode write then fails, the
/// company is still `Managed` holding an unread key — inert, since managed
/// resolution never looks at [`API_KEY_KEY`].
///
/// Clearing writes the mode first. A fixed key-then-mode order would write the
/// *empty* key first here — and if the mode write then failed, the company
/// would stay `Byok` (its old mode, unwritten) with an empty key, which
/// [`resolve_access`] resolves to [`Credential::None`]: the exact "BYOK mode,
/// no key" outage the key-first rule above exists to avoid, reached from the
/// other direction. Writing the mode first instead leaves a failed second
/// write as `Managed` holding a stale-but-present key — inert, for the same
/// reason as the set direction.
pub async fn store_api_key(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    api_key: &str,
) -> Result<ComposioMode> {
    let api_key = api_key.trim();
    let mode = if api_key.is_empty() {
        ComposioMode::Managed
    } else {
        ComposioMode::Byok
    };
    if mode.is_byok() {
        secrets
            .set(company, API_KEY_KEY, SecretValue(api_key.to_string()))
            .await?;
        secrets
            .set(company, MODE_KEY, SecretValue(mode.as_str().to_string()))
            .await?;
    } else {
        secrets
            .set(company, MODE_KEY, SecretValue(mode.as_str().to_string()))
            .await?;
        secrets
            .set(company, API_KEY_KEY, SecretValue(api_key.to_string()))
            .await?;
    }
    Ok(mode)
}

/// How a company reaches Composio: the route, and the credential that route
/// presents.
///
/// Returned as a pair rather than resolved twice because the two answers must
/// agree — a console reporting BYOK while the agents present a platform bearer
/// is the exact drift [`resolve_credential`]'s own docs exist to prevent.
pub struct ComposioAccess {
    /// Which host the calls go to.
    pub mode: ComposioMode,
    /// What they authenticate with: a Composio API key under
    /// [`ComposioMode::Byok`], otherwise whatever [`resolve_credential`]
    /// resolves.
    pub credential: Credential,
}

impl ComposioAccess {
    /// The non-secret endpoint this access reaches — [`DIRECT_BASE_URL`] for
    /// BYOK, the resolved backend URL otherwise. Safe to surface on the console
    /// read plane.
    pub fn endpoint(&self, backend_url: &str) -> String {
        match self.mode {
            ComposioMode::Byok => DIRECT_BASE_URL.to_string(),
            ComposioMode::Managed => backend_url.to_string(),
        }
    }
}

/// The route and credential this company's Composio calls use.
///
/// **Managed** defers wholly to [`resolve_credential`] — the BYO backend token,
/// then the company's TinyHumans key, then the instance identity — so nothing
/// about the default path changes by adding this.
///
/// **BYOK** reads [`API_KEY_KEY`] and nothing else. It deliberately does *not*
/// fall back to the managed tiers when the key is missing or blank: a company
/// that asked to act through its own Composio account and silently acted
/// through the platform's instead would connect providers into the wrong tenant
/// and bill the wrong party. [`Credential::None`] here means no tools this
/// cycle, which is the same fail-closed answer an absent managed credential
/// gets.
///
/// A store read error **propagates**, for the reason it propagates in
/// [`resolve_credential`]: an unreadable store must not be able to change which
/// account a call is attributed to.
pub async fn resolve_access(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    token_source: Option<Arc<TinyhumansTokenSource>>,
) -> Result<ComposioAccess> {
    let mode = load_mode(company, secrets).await?;
    let credential = match mode {
        ComposioMode::Managed => resolve_credential(company, secrets, token_source).await?,
        ComposioMode::Byok => match secrets.get(company, API_KEY_KEY).await? {
            Some(SecretValue(key)) => Credential::from_value(key),
            None => Credential::None,
        },
    };
    if mode.is_byok() && !credential.configured() {
        tracing::warn!(
            company = %company,
            "[composio] this company is in BYOK mode with no Composio API key stored; \
             withholding tools rather than presenting the platform identity"
        );
    }
    Ok(ComposioAccess { mode, credential })
}

/// The [`SecretStore`] key holding this company's per-toolkit default
/// connections — a JSON object `{"gmail": "ca_123"}` written by the console
/// (issue #820).
///
/// Stored the way `inference/config` is: one small JSON blob per company,
/// alongside the credential it qualifies, rather than a new port. It is a
/// *preference*, not a secret — the ids in it are already handed to the console
/// by `GET …/composio/connections`, and are useless without the bearer that
/// scopes them. It lives in the secret store because that is the one per-company
/// key/value plane this repo has, and because keeping it beside [`TOKEN_KEY`]
/// means a company's Composio state moves, backs up and is deleted as one thing.
pub const DEFAULTS_KEY: &str = "composio/defaults";

/// This company's chosen connection per toolkit: `gmail` → a Composio connection
/// id (issue #820).
///
/// Absent for a toolkit means **no company has expressed an intent**, and the
/// execute path then sends no connection id at all, leaving the resolution to
/// Composio exactly as before. That absence is the ordinary case and is not a
/// degraded one — one account per toolkit needs no choice — so nothing here
/// invents a default from the connection list. A default that the product does
/// not actually make would be a claim the harness could not honour, which is the
/// failure #820 was filed about.
pub type ComposioDefaults = std::collections::BTreeMap<String, String>;

/// This company's stored per-toolkit defaults, or an empty map.
///
/// A blob that will not parse is treated as *no defaults* rather than an error:
/// the only writer is [`set_default`] / [`clear_default`], so unparseable means
/// hand-edited or from a future shape, and the honest response on the agent path
/// is to fall back to Composio's own resolution rather than to withhold the
/// tools. It is logged, not swallowed silently.
pub async fn load_defaults(
    company: &CompanyId,
    secrets: &dyn SecretStore,
) -> Result<ComposioDefaults> {
    let Some(SecretValue(raw)) = secrets.get(company, DEFAULTS_KEY).await? else {
        return Ok(ComposioDefaults::new());
    };
    if raw.trim().is_empty() {
        return Ok(ComposioDefaults::new());
    }
    match serde_json::from_str::<ComposioDefaults>(&raw) {
        Ok(defaults) => Ok(defaults
            .into_iter()
            .map(|(toolkit, id)| (toolkit.trim().to_ascii_lowercase(), id.trim().to_string()))
            .filter(|(toolkit, id)| !toolkit.is_empty() && !id.is_empty())
            .collect()),
        Err(err) => {
            tracing::warn!(
                company = %company,
                error = %err,
                "[composio] stored connection defaults did not parse; treating this company as \
                 having expressed no preference"
            );
            Ok(ComposioDefaults::new())
        }
    }
}

/// Pin `toolkit` to `connection_id`, replacing whatever it named before, and
/// return the resulting map.
///
/// The caller is responsible for checking that the id names a connection this
/// company actually holds — see
/// [`set_default_connection`](crate::harness::composio::set_default_connection),
/// which is the only path the console reaches this through. Storing an id blind
/// would let a typo silently redirect every send for a toolkit to nothing.
pub async fn set_default(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    toolkit: &str,
    connection_id: &str,
) -> Result<ComposioDefaults> {
    let mut defaults = load_defaults(company, secrets).await?;
    defaults.insert(
        toolkit.trim().to_ascii_lowercase(),
        connection_id.trim().to_string(),
    );
    save_defaults(company, secrets, &defaults).await?;
    Ok(defaults)
}

/// Drop `toolkit`'s pin — back to letting Composio resolve the account — and
/// return the resulting map.
pub async fn clear_default(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    toolkit: &str,
) -> Result<ComposioDefaults> {
    let mut defaults = load_defaults(company, secrets).await?;
    defaults.remove(&toolkit.trim().to_ascii_lowercase());
    save_defaults(company, secrets, &defaults).await?;
    Ok(defaults)
}

/// Drop every pin naming `connection_id`, and report whether anything went.
///
/// Called when an account is revoked: a pin to a connection that no longer
/// exists would be sent on the next execute and refused by Composio, turning a
/// disconnect of the *other* account into a broken toolkit.
pub async fn forget_connection(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    connection_id: &str,
) -> Result<bool> {
    let connection_id = connection_id.trim();
    let mut defaults = load_defaults(company, secrets).await?;
    let before = defaults.len();
    defaults.retain(|_, id| id != connection_id);
    if defaults.len() == before {
        return Ok(false);
    }
    save_defaults(company, secrets, &defaults).await?;
    Ok(true)
}

async fn save_defaults(
    company: &CompanyId,
    secrets: &dyn SecretStore,
    defaults: &ComposioDefaults,
) -> Result<()> {
    // An empty map is stored as an empty string rather than `{}`, matching how
    // every other value here is cleared: `SecretStore` has no delete, and the
    // loader already reads empty as "nothing pinned".
    let raw = if defaults.is_empty() {
        String::new()
    } else {
        serde_json::to_string(defaults).map_err(|err| {
            crate::error::OpenCompanyError::Store(format!(
                "could not serialize composio defaults: {err}"
            ))
        })?
    };
    secrets.set(company, DEFAULTS_KEY, SecretValue(raw)).await
}

/// One provider in the catalog the console renders, carrying the backend's own
/// display metadata rather than a bare slug (issue #600).
///
/// ## Why this lives here and not in the harness
///
/// It is produced by `harness::composio::list_catalog_toolkits` and consumed by
/// the always-compiled status route, and the harness compiles only under the
/// `openhuman` feature. Same reason [`TOKEN_KEY`] and
/// [`backend_url_or_default`] live here: the console plane must keep working in
/// a default build that links none of the live tools.
///
/// ## Why it is not `composio_catalog::CatalogToolkit`
///
/// That type describes the same backend entry for an *agent*, and it drops the
/// logo URL on purpose — a URL a model can never act on costs tokens to no end.
/// The logo and the categories are the entire point of this one: they are what
/// let 123 providers be a browsable grid instead of 123 stacked rows. It also
/// carries no connected flag, because the console learns that from
/// `GET …/composio/connections` — live per-company state, not catalog data.
///
/// Serialized straight into the status DTO, so these field names are the
/// console's wire contract.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// Toolkit slug, e.g. `googlecalendar`. The key every host call is made
    /// with, and the only field the backend always publishes.
    pub slug: String,
    /// Human-readable name, e.g. `Google Calendar`. Empty when the backend
    /// published none — the console then falls back to its own typography.
    pub name: String,
    /// One-line description. Empty when unpublished. The console searches it
    /// alongside the name, so an operator who knows what a provider *does* can
    /// find it without knowing what it is called.
    pub description: String,
    /// Composio-hosted logo URL. `None` when unpublished.
    pub logo: Option<String>,
    /// Composio's own category names, e.g. `["productivity", "email"]`.
    ///
    /// Forwarded **verbatim** and uninterpreted. The console buckets them by
    /// substring, and it does so precisely because that means a Composio
    /// integration added tomorrow lands in the right group with no code change
    /// on either side of this wire.
    pub categories: Vec<String>,
}

impl CatalogEntry {
    /// An entry for a provider the backend published a slug and nothing else
    /// for.
    ///
    /// Three real callers, so "no metadata" is a first-class state rather than
    /// a reason to drop the provider: a manifest allowlist (hand-written slugs,
    /// and the catalog is deliberately never consulted for it), the fallback
    /// list (which exists *because* the metadata could not be fetched), and a
    /// backend predating the dynamic catalog (which sends no `catalog[]` at
    /// all). The console renders all three with its own typography.
    pub fn from_slug(slug: impl Into<String>) -> Self {
        Self {
            slug: slug.into(),
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_url_prefers_override_then_api_url_then_default() {
        // Neither set → prod default.
        assert_eq!(backend_url_or_default(None, None), DEFAULT_BACKEND_URL);

        // Explicit override wins over everything.
        assert_eq!(
            backend_url_or_default(
                Some("https://custom.example".into()),
                Some("https://staging-api.tinyhumans.ai".into())
            ),
            "https://custom.example"
        );

        // No override → follow the tenant API base (the staging case).
        assert_eq!(
            backend_url_or_default(None, Some("https://staging-api.tinyhumans.ai".into())),
            "https://staging-api.tinyhumans.ai"
        );

        // Whitespace/empty override falls through to the api_url fallback.
        assert_eq!(
            backend_url_or_default(
                Some("  ".into()),
                Some("https://staging-api.tinyhumans.ai".into())
            ),
            "https://staging-api.tinyhumans.ai"
        );

        // Whitespace/empty api_url falls through to the prod default.
        assert_eq!(
            backend_url_or_default(Some("".into()), Some("   ".into())),
            DEFAULT_BACKEND_URL
        );

        // api_url is trimmed before use.
        assert_eq!(
            backend_url_or_default(None, Some("  https://staging-api.tinyhumans.ai  ".into())),
            "https://staging-api.tinyhumans.ai"
        );
    }

    #[derive(Default)]
    struct MemSecrets {
        map: std::sync::Mutex<std::collections::HashMap<String, String>>,
    }

    #[async_trait::async_trait]
    impl SecretStore for MemSecrets {
        async fn get(&self, _c: &CompanyId, key: &str) -> Result<Option<SecretValue>> {
            Ok(self
                .map
                .lock()
                .unwrap()
                .get(key)
                .map(|v| SecretValue(v.clone())))
        }
        async fn set(&self, _c: &CompanyId, key: &str, value: SecretValue) -> Result<()> {
            self.map.lock().unwrap().insert(key.to_string(), value.0);
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_company_with_no_stored_preference_pins_nothing() {
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        assert!(load_defaults(&company, &secrets).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_pin_round_trips_and_is_replaced_rather_than_appended() {
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();

        let after = set_default(&company, &secrets, "gmail", "ca_ops")
            .await
            .unwrap();
        assert_eq!(after.get("gmail").map(String::as_str), Some("ca_ops"));
        assert_eq!(
            load_defaults(&company, &secrets).await.unwrap(),
            after,
            "the stored blob is what the setter reported"
        );

        // A second toolkit is additive; naming gmail again replaces it.
        set_default(&company, &secrets, "slack", "ca_workspace")
            .await
            .unwrap();
        let after = set_default(&company, &secrets, "gmail", "ca_billing")
            .await
            .unwrap();
        assert_eq!(after.get("gmail").map(String::as_str), Some("ca_billing"));
        assert_eq!(
            after.get("slack").map(String::as_str),
            Some("ca_workspace"),
            "pinning one toolkit must not disturb another"
        );
    }

    #[tokio::test]
    async fn toolkits_are_normalized_so_a_pin_is_found_by_the_slug_prefix() {
        // `slug_toolkit` lowercases (`GMAIL_SEND_EMAIL` → `gmail`), so a pin
        // stored under `GMail` would be invisible to the execute path.
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        set_default(&company, &secrets, " GMail ", " ca_ops ")
            .await
            .unwrap();
        assert_eq!(
            load_defaults(&company, &secrets)
                .await
                .unwrap()
                .get("gmail")
                .map(String::as_str),
            Some("ca_ops")
        );
    }

    #[tokio::test]
    async fn clearing_a_pin_returns_the_toolkit_to_composios_own_resolution() {
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        set_default(&company, &secrets, "gmail", "ca_ops")
            .await
            .unwrap();
        let after = clear_default(&company, &secrets, "gmail").await.unwrap();
        assert!(after.is_empty());
        assert!(load_defaults(&company, &secrets).await.unwrap().is_empty());
        // Clearing what was never pinned is not an error.
        assert!(
            clear_default(&company, &secrets, "gmail")
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn revoking_the_pinned_account_drops_the_pin() {
        // Otherwise the next execute sends an id Composio no longer knows, and
        // disconnecting the *other* account breaks the toolkit.
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        set_default(&company, &secrets, "gmail", "ca_ops")
            .await
            .unwrap();
        set_default(&company, &secrets, "slack", "ca_workspace")
            .await
            .unwrap();

        assert!(
            !forget_connection(&company, &secrets, "ca_unrelated")
                .await
                .unwrap(),
            "revoking an unpinned account changes nothing"
        );
        assert!(
            forget_connection(&company, &secrets, "ca_ops")
                .await
                .unwrap()
        );

        let left = load_defaults(&company, &secrets).await.unwrap();
        assert_eq!(left.get("slack").map(String::as_str), Some("ca_workspace"));
        assert!(!left.contains_key("gmail"));
    }

    #[tokio::test]
    async fn an_unparseable_blob_reads_as_no_preference() {
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        secrets
            .set(&company, DEFAULTS_KEY, SecretValue("not json".into()))
            .await
            .unwrap();
        assert!(
            load_defaults(&company, &secrets).await.unwrap().is_empty(),
            "a hand-edited blob must fall back to Composio's resolution, not withhold the tools"
        );
    }
    // ── BYOK routing ────────────────────────────────────────────────

    #[tokio::test]
    async fn a_company_that_configured_nothing_is_openhuman_managed() {
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        assert_eq!(
            load_mode(&company, &secrets).await.unwrap(),
            ComposioMode::Managed
        );
        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(access.mode, ComposioMode::Managed);
    }

    #[tokio::test]
    async fn storing_a_key_selects_byok_and_clearing_it_gives_the_managed_route_back() {
        // The two writes travel together deliberately — a mode without a key is
        // a company with no Composio tools, and a key without a mode is inert.
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();

        let mode = store_api_key(&company, &secrets, " ak_live ")
            .await
            .unwrap();
        assert_eq!(mode, ComposioMode::Byok);
        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(access.mode, ComposioMode::Byok);
        assert_eq!(
            access.credential.current().await.unwrap().as_deref(),
            Some("ak_live"),
            "the key is trimmed on the way in — Composio rejects a padded x-api-key"
        );

        let mode = store_api_key(&company, &secrets, "").await.unwrap();
        assert_eq!(mode, ComposioMode::Managed);
        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(access.mode, ComposioMode::Managed);
    }

    /// Wraps [`MemSecrets`] and fails every `set` for one chosen key, so a test
    /// can land a `store_api_key` call exactly at its second write and inspect
    /// what the first one left behind.
    struct SecretsFailingToWrite {
        inner: MemSecrets,
        blocked_key: &'static str,
    }

    #[async_trait::async_trait]
    impl SecretStore for SecretsFailingToWrite {
        async fn get(&self, c: &CompanyId, key: &str) -> Result<Option<SecretValue>> {
            self.inner.get(c, key).await
        }
        async fn set(&self, c: &CompanyId, key: &str, value: SecretValue) -> Result<()> {
            if key == self.blocked_key {
                return Err(crate::error::OpenCompanyError::Store(
                    "write refused by test".into(),
                ));
            }
            self.inner.set(c, key, value).await
        }
    }

    /// A clear that dies on its **first** write (the mode) must leave the
    /// company exactly as it was: still `Byok`, still holding the key that was
    /// working a moment ago. This is the direction issue #… — writing the mode
    /// first for a clear — exists to protect: a fixed key-then-mode order would
    /// have written the key EMPTY here, before ever reaching the (blocked) mode
    /// write, stranding a `Byok` company with no key.
    #[tokio::test]
    async fn a_clear_that_fails_on_the_mode_write_leaves_byok_intact() {
        let company = CompanyId::new("acme");
        let secrets = SecretsFailingToWrite {
            inner: MemSecrets::default(),
            blocked_key: MODE_KEY,
        };
        // Seeded directly on `inner`, bypassing the wrapper's own blocking
        // `set()` — the state under test is "already BYOK", not "how it got
        // there", and going through `store_api_key` here would hit the very
        // block this test exists to trigger before the test has even started.
        secrets
            .inner
            .set(&company, API_KEY_KEY, SecretValue("ak_live".into()))
            .await
            .unwrap();
        secrets
            .inner
            .set(&company, MODE_KEY, SecretValue(BYOK_MODE.into()))
            .await
            .unwrap();

        let err = store_api_key(&company, &secrets, "").await;
        assert!(
            err.is_err(),
            "the blocked write must propagate, not swallow"
        );

        assert_eq!(
            load_mode(&company, &secrets).await.unwrap(),
            ComposioMode::Byok
        );
        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(
            access.credential.current().await.unwrap().as_deref(),
            Some("ak_live"),
            "the key a moment ago worked and must still work — nothing broke"
        );
    }

    /// A clear that dies on its **second** write (the key) must still have
    /// landed the mode: the company reads back as `Managed`, with a stale
    /// unused key sitting inert in `API_KEY_KEY` — never consulted once the
    /// mode says managed.
    #[tokio::test]
    async fn a_clear_that_fails_on_the_key_write_still_lands_managed() {
        let company = CompanyId::new("acme");
        let secrets = SecretsFailingToWrite {
            inner: MemSecrets::default(),
            blocked_key: API_KEY_KEY,
        };
        // Seeded directly on `inner` for the same reason as the sibling test
        // above: this test's block is `API_KEY_KEY`, and `store_api_key`'s set
        // direction writes that key first — routing the initial BYOK selection
        // through the wrapper would block before there was anything to clear.
        secrets
            .inner
            .set(&company, API_KEY_KEY, SecretValue("ak_live".into()))
            .await
            .unwrap();
        secrets
            .inner
            .set(&company, MODE_KEY, SecretValue(BYOK_MODE.into()))
            .await
            .unwrap();

        let err = store_api_key(&company, &secrets, "").await;
        assert!(err.is_err());

        assert_eq!(
            load_mode(&company, &secrets).await.unwrap(),
            ComposioMode::Managed,
            "the mode write is first for a clear, and it landed before the blocked one"
        );
        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(
            access.mode,
            ComposioMode::Managed,
            "a stale key under a managed mode is inert — resolve_access never reads it"
        );
    }

    #[tokio::test]
    async fn byok_never_falls_back_to_a_managed_credential() {
        // The load-bearing one. A company that asked to act through its own
        // Composio account must not silently act through the platform's: that
        // would connect providers into the wrong tenant and bill the wrong
        // party. No key means no tools.
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        // A managed-tier credential that *would* answer, so the test proves the
        // BYOK arm ignores it rather than that there was nothing to fall back to.
        secrets
            .set(&company, TOKEN_KEY, SecretValue("backend-bearer".into()))
            .await
            .unwrap();
        secrets
            .set(&company, MODE_KEY, SecretValue(BYOK_MODE.into()))
            .await
            .unwrap();

        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(access.mode, ComposioMode::Byok);
        assert!(
            !access.credential.configured(),
            "BYOK with no API key resolves to nothing, not to the backend token"
        );
    }

    #[tokio::test]
    async fn the_byok_key_is_never_confused_with_the_backend_token() {
        // Two different secrets authenticating two different hosts. Selecting
        // BYOK must present the Composio key, not the bearer stored next to it.
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        secrets
            .set(&company, TOKEN_KEY, SecretValue("backend-bearer".into()))
            .await
            .unwrap();
        store_api_key(&company, &secrets, "ak_live").await.unwrap();

        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(
            access.credential.current().await.unwrap().as_deref(),
            Some("ak_live")
        );

        // And clearing the key hands the backend token back untouched — a
        // switch to BYOK and back must not cost the company its override.
        store_api_key(&company, &secrets, "").await.unwrap();
        let access = resolve_access(&company, &secrets, None).await.unwrap();
        assert_eq!(access.mode, ComposioMode::Managed);
        assert_eq!(
            access.credential.current().await.unwrap().as_deref(),
            Some("backend-bearer")
        );
    }

    #[tokio::test]
    async fn a_hand_edited_mode_slot_cannot_take_a_company_s_tools_away() {
        // Read on the roster path: an unrecognised mode must degrade to the
        // route that works without anything stored, not to no route at all.
        let company = CompanyId::new("acme");
        let secrets = MemSecrets::default();
        secrets
            .set(&company, MODE_KEY, SecretValue("nonsense".into()))
            .await
            .unwrap();
        assert_eq!(
            load_mode(&company, &secrets).await.unwrap(),
            ComposioMode::Managed,
            "an unrecognised mode falls back to the route that works without config"
        );

        // OpenHuman's and TinyMemory's spelling of the same route. Never
        // written here, but a slot that carried it must not silently mean the
        // opposite — a company asking for its own account would get the
        // platform's.
        secrets
            .set(&company, MODE_KEY, SecretValue("dirEct".into()))
            .await
            .unwrap();
        assert_eq!(
            load_mode(&company, &secrets).await.unwrap(),
            ComposioMode::Byok
        );

        // …and the managed spellings the other repos use need no alias: they
        // already mean managed through the fallback.
        for spelling in ["backend", "proxied"] {
            secrets
                .set(&company, MODE_KEY, SecretValue(spelling.into()))
                .await
                .unwrap();
            assert_eq!(
                load_mode(&company, &secrets).await.unwrap(),
                ComposioMode::Managed,
                "`{spelling}` means managed everywhere it is used"
            );
        }

        secrets
            .set(&company, MODE_KEY, SecretValue("  BYOK  ".into()))
            .await
            .unwrap();
        assert_eq!(
            load_mode(&company, &secrets).await.unwrap(),
            ComposioMode::Byok,
            "the one spelling this repo does use is matched case-insensitively"
        );
    }

    #[test]
    fn the_endpoint_reported_is_the_host_the_calls_reach() {
        let byok = ComposioAccess {
            mode: ComposioMode::Byok,
            credential: Credential::from_value("ak_live"),
        };
        assert_eq!(byok.endpoint("https://api.tinyhumans.ai"), DIRECT_BASE_URL);

        let managed = ComposioAccess {
            mode: ComposioMode::Managed,
            credential: Credential::from_value("bearer"),
        };
        assert_eq!(
            managed.endpoint("https://api.tinyhumans.ai"),
            "https://api.tinyhumans.ai"
        );
    }

    /// Fails every `get` for one chosen key, so a test can prove a read error
    /// propagates instead of being swallowed into a fallback tier.
    struct SecretsFailingToRead {
        inner: MemSecrets,
        blocked_key: &'static str,
    }

    #[async_trait::async_trait]
    impl SecretStore for SecretsFailingToRead {
        async fn get(&self, c: &CompanyId, key: &str) -> Result<Option<SecretValue>> {
            if key == self.blocked_key {
                return Err(crate::error::OpenCompanyError::Store(
                    "read refused by test".into(),
                ));
            }
            self.inner.get(c, key).await
        }
        async fn set(&self, c: &CompanyId, key: &str, value: SecretValue) -> Result<()> {
            self.inner.set(c, key, value).await
        }
    }

    /// A store read error on the BYO override key must fail the whole
    /// resolution rather than degrade to the shared brokered tier: an
    /// unreadable store that silently fell through to
    /// [`company_key::resolve`] would let a call be attributed to the wrong
    /// account precisely when the store cannot be trusted to say which
    /// account was configured.
    #[tokio::test]
    async fn a_store_read_error_on_the_byo_token_propagates_rather_than_falling_back() {
        let company = CompanyId::new("acme");
        let secrets = SecretsFailingToRead {
            inner: MemSecrets::default(),
            blocked_key: TOKEN_KEY,
        };
        // A managed-tier credential that *would* answer if resolution fell
        // through to it — proving the error surfaces rather than that there
        // was nothing to fall back to.
        secrets
            .inner
            .set(&company, TOKEN_KEY, SecretValue("unreachable".into()))
            .await
            .unwrap();

        let err = resolve_credential(&company, &secrets, None)
            .await
            .expect_err("an unreadable secret store must not resolve to any credential");
        assert!(
            matches!(err, crate::error::OpenCompanyError::Store(_)),
            "expected the store error to propagate untouched, got {err:?}"
        );
    }
}
