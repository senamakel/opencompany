//! The billing operations issue #788 scopes, expressed against Chargebee's
//! REST API v2 and returning the compact projections in [`super::types`].
//!
//! This layer knows Chargebee and nothing about agents. The toolbelt bridge in
//! [`crate::harness::chargebee`] wraps each function below as an agent-callable
//! tool; keeping the split means the API shapes can be tested without a harness,
//! and the tool descriptions can change without touching the wire format.
//!
//! Arguments are validated here, before any network call, whenever the check is
//! one Chargebee would also make. That is not redundancy: a local rejection can
//! name the valid set, whereas Chargebee's own error arrives after a round trip
//! and, for the agent, after a turn that looked like it was working.

use crate::error::{OpenCompanyError, Result};
use serde_json::Value;

use super::client::{ChargebeeClient, Form};
use super::types::{
    CreateCustomerArgs, CustomerSummary, GetInvoiceArgs, InvoiceSummary, ListInvoicesArgs,
    SendInvoiceArgs,
};

/// Builds the invalid-argument error used for every local validation failure.
pub(crate) fn invalid(message: impl Into<String>) -> OpenCompanyError {
    OpenCompanyError::Chargebee {
        status: 0,
        code: "invalid_arguments".to_string(),
        message: message.into(),
    }
}

/// Percent-encodes a path segment.
///
/// Customer and invoice ids reach the URL path and originate in agent input, so
/// a value containing `/` or `?` would otherwise re-target the request at a
/// different endpoint.
fn urlencode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Whether a failure is Chargebee refusing `net_term_days` because the site has
/// no payment-terms feature.
///
/// Matched on the message rather than an `api_error_code`, because Chargebee
/// reports it as a generic `invalid_request`: the specific cause lives only in
/// the prose. Deliberately requires BOTH markers so an unrelated invalid_request
/// mentioning one word is not swallowed.
fn mentions_payment_terms(error: &OpenCompanyError) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("net_term_days") && text.contains("payment terms")
}

/// Pulls a required object out of a Chargebee response.
///
/// Every write below reads one named object (`customer`, `invoice`) out of the
/// reply. Defaulting a missing one to `Null` and projecting it anyway yields a
/// record with an **empty id** that looks successful, and the next call spends
/// it — `customer_id=` on an invoice create, which Chargebee answers with a
/// confusing parameter error far from the real cause. So an absent object is an
/// error here, where it can name what was expected.
fn require<'a>(body: &'a Value, key: &str) -> Result<&'a Value> {
    body.get(key).filter(|v| v.is_object()).ok_or_else(|| {
        // The body goes to the log, not into the message. This one PARSED, so
        // unlike the client's unusable-body case it is a real Chargebee object
        // — which is exactly why it must not be quoted back: a reply that was
        // missing its `invoice` still carries whatever else Chargebee sent
        // about the customer, and this message reaches the model's context and
        // the durable transcript.
        tracing::warn!(
            expected = key,
            body = %body.to_string().chars().take(200).collect::<String>(),
            "[chargebee] reply carried no `{key}` object"
        );
        OpenCompanyError::Chargebee {
            status: 0,
            code: "unexpected_response".to_string(),
            message: format!(
                "Chargebee's reply carried no `{key}` object. The reply is in the host log."
            ),
        }
    })
}

/// Pulls a required *array* out of a Chargebee response, or fails.
///
/// A successful empty `list` means "no rows" — that is the real answer and
/// stays real. A missing or non-array `list` means the reply's shape moved,
/// and projecting that as an empty result would be a confident false negative
/// about a billing system (an agent answering "no invoices" to a site that may
/// hold any number of them). `paypal::api::list_transactions` makes the same
/// call for the same reason.
fn require_array<'a>(body: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    body.get(key).and_then(Value::as_array).ok_or_else(|| {
        tracing::warn!(
            expected = key,
            body = %body.to_string().chars().take(200).collect::<String>(),
            "[chargebee] reply carried no `{key}` array"
        );
        OpenCompanyError::Chargebee {
            status: 0,
            code: "unexpected_response".to_string(),
            message: format!(
                "Chargebee's reply carried no `{key}` array. The reply is in the host log."
            ),
        }
    })
}

/// Projects Chargebee's invoice object onto [`InvoiceSummary`].
fn summarize_invoice(invoice: &Value, payment_url: Option<String>) -> InvoiceSummary {
    let num = |key: &str| invoice.get(key).and_then(Value::as_i64).unwrap_or(0);
    InvoiceSummary {
        id: invoice
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        customer_id: invoice
            .get("customer_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: invoice
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        currency_code: invoice
            .get("currency_code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        total_in_minor_units: num("total"),
        amount_due_in_minor_units: num("amount_due"),
        amount_paid_in_minor_units: num("amount_paid"),
        due_date: invoice.get("due_date").and_then(Value::as_i64),
        line_items: invoice
            .get("line_items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|li| li.get("description").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        payment_url,
        // Only `send_invoice` can observe a replay; a fetched or listed invoice
        // is never one.
        replayed_earlier_invoice: false,
    }
}

/// Projects Chargebee's customer object onto [`CustomerSummary`].
fn summarize_customer(customer: &Value) -> CustomerSummary {
    let text = |key: &str| {
        customer
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let name = match (text("first_name"), text("last_name")) {
        (Some(first), Some(last)) => Some(format!("{first} {last}")),
        (Some(one), None) | (None, Some(one)) => Some(one),
        (None, None) => None,
    };
    CustomerSummary {
        id: customer
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        email: text("email"),
        name,
        company: text("company"),
    }
}

/// Looks a customer up by email, returning `None` when no record matches.
pub async fn get_customer(
    client: &ChargebeeClient,
    email: &str,
) -> Result<Option<CustomerSummary>> {
    let email = email.trim();
    if email.is_empty() {
        return Err(invalid("`email` is required"));
    }
    let mut query = Form::new();
    // Chargebee filters take an operator suffix: a bare `email=` is IGNORED
    // rather than rejected, which would return an unrelated customer as if it
    // were a match — the worst possible failure for a tool that decides whether
    // to create one.
    query.push("email[is]", email);
    query.push("limit", "1");
    let body = client.get("/customers", &query).await?;
    Ok(body
        .get("list")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("customer"))
        .map(summarize_customer))
}

/// Creates a customer.
pub async fn create_customer(
    client: &ChargebeeClient,
    args: CreateCustomerArgs,
) -> Result<CustomerSummary> {
    let email = args.email.trim();
    if email.is_empty() {
        return Err(invalid("`email` is required"));
    }
    let mut form = Form::new();
    form.push("email", email);
    if let Some(name) = args
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Chargebee has no single `name` field. Splitting on the first space
        // keeps "Alan" whole and "Ada Byron" correct; a middle name lands in
        // `last_name`, which is wrong in a way nobody is harmed by.
        match name.split_once(' ') {
            Some((first, last)) => {
                form.push("first_name", first);
                form.push("last_name", last);
            }
            None => form.push("first_name", name),
        }
    }
    form.push_opt("company", args.company);
    let body = client.post_form("/customers", &form, None).await?;
    Ok(summarize_customer(require(&body, "customer")?))
}

/// Returns the customer for `email`, creating one when no record matches.
async fn resolve_or_create_customer(
    client: &ChargebeeClient,
    email: &str,
    name: Option<String>,
) -> Result<CustomerSummary> {
    if let Some(found) = get_customer(client, email).await? {
        return Ok(found);
    }
    create_customer(
        client,
        CreateCustomerArgs {
            email: email.to_string(),
            name,
            company: None,
        },
    )
    .await
}

/// Raises a hosted page where the customer can settle what they owe.
///
/// Best-effort by design: this is a second call after the invoice already
/// exists, and a site without a configured gateway (or without the hosted-page
/// feature) refuses it. Failing the whole tool at that point would report "no
/// invoice" for an invoice that was in fact created — the worst answer
/// available. So a failure logs and yields `None`, and the caller says the
/// invoice was raised without a link.
async fn payment_url(
    client: &ChargebeeClient,
    customer_id: &str,
    currency: &str,
) -> Option<String> {
    let mut form = Form::new();
    form.push("customer[id]", customer_id);
    form.push("currency_code", currency);
    match client
        .post_form("/hosted_pages/collect_now", &form, None)
        .await
    {
        Ok(body) => body
            .get("hosted_page")
            .and_then(|p| p.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string),
        Err(e) => {
            tracing::warn!(%customer_id, error = %e, "[chargebee] could not raise a payment link");
            None
        }
    }
}

/// Derives an idempotency key from the request itself.
///
/// # Why a key is always sent, even when the caller supplied none
///
/// The runtime's at-most-once guard covers **approval replay**: an approved
/// effect is recorded executed before it is performed, so re-approving does not
/// re-send. It does not cover **transport retry**, which is the failure that
/// actually duplicates an invoice — the request reaches Chargebee, the response
/// is lost to a timeout, the tool reports failure, and the agent (or an
/// operator reading that failure) sends again. The customer receives two
/// invoices.
///
/// The key was an optional tool argument, which in practice meant absent: a
/// model has no reason to invent one, and every send observed in testing
/// omitted it. Deriving one from the request body closes that by default. It is
/// deliberately derived from the REQUEST rather than from the approved effect —
/// the effect id is not reachable here, because an approved call is re-issued
/// by the model through the ordinary tool path (`redispatch_granted_call`)
/// rather than executed by the runtime with the effect in scope.
///
/// The trade this makes is explicit: two byte-identical invoices raised inside
/// Chargebee's key-retention window collapse to one. That is why a replay is
/// reported back rather than passed off as a new invoice — see
/// [`InvoiceSummary::replayed_earlier_invoice`] — and why a caller who means to
/// bill twice can pass a distinct `idempotency_key`.
///
/// FNV-1a rather than `DefaultHasher`, so the key is stable **as a value**, not
/// merely within one process. `DefaultHasher`'s output is explicitly not
/// guaranteed across Rust releases, which would mean a host upgraded mid-retry
/// — or two hosts of one company behind a load balancer — deriving different
/// keys for the same invoice and billing the customer twice. That is precisely
/// the failure this function exists to prevent, so the hash cannot be one whose
/// stability is a footnote about the toolchain. The field separators keep
/// `("ab","c")` from colliding with `("a","bc")`.
fn derived_idempotency_key(form: &Form) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    let mut eat = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(PRIME);
        }
    };
    for (key, value) in form.pairs() {
        eat(key.as_bytes());
        eat(b"=");
        eat(value.as_bytes());
        eat(b"&");
    }
    format!("oc-invoice-{hash:016x}")
}

/// Creates an invoice for `customer_email`, creating the customer if needed,
/// and returns it with a payment link when one could be raised.
pub async fn send_invoice(
    client: &ChargebeeClient,
    args: SendInvoiceArgs,
) -> Result<InvoiceSummary> {
    if args.line_items.is_empty() {
        return Err(invalid("`line_items` must contain at least one entry"));
    }
    let currency = args.currency_code.trim().to_uppercase();
    if currency.is_empty() {
        return Err(invalid("`currency_code` is required, e.g. USD"));
    }
    for (i, line) in args.line_items.iter().enumerate() {
        if line.amount_in_minor_units < 1 {
            return Err(invalid(format!(
                "line_items[{i}].amount_in_minor_units must be at least 1 (amounts are in minor \
                 units — $100.00 is 10000)"
            )));
        }
    }

    let customer =
        resolve_or_create_customer(client, args.customer_email.trim(), args.customer_name).await?;

    let mut form = Form::new();
    form.push("customer_id", &customer.id);
    form.push("currency_code", &currency);
    // Unasked-for, and load-bearing. Chargebee's default follows the customer
    // record and charges a stored card the moment the invoice exists — verified
    // against a live site, which answered `payment_method_not_present`. Two
    // reasons to override it: "send an invoice" is not "take a payment", and an
    // auto-collected invoice is already paid, which would make the "has Alan
    // paid?" flow (#788) answer itself.
    form.push("auto_collection", "off");
    form.push_opt("net_term_days", args.due_days);
    form.push_opt("invoice_note", args.invoice_note);
    for (i, line) in args.line_items.iter().enumerate() {
        form.push_indexed("charges", "description", i, &line.description);
        form.push_indexed("charges", "amount", i, line.amount_in_minor_units);
    }

    let path = "/invoices/create_for_charge_items_and_charges";
    let key = args
        .idempotency_key
        .clone()
        .unwrap_or_else(|| derived_idempotency_key(&form));
    let (body, replayed) = match client.post_form_replayable(path, &form, Some(&key)).await {
        Ok(outcome) => outcome,
        // `net_term_days` is refused outright by a site that has not enabled
        // "Payment Terms for One-Time Invoices" — a per-site feature most test
        // sites ship without. Failing the whole invoice over a DUE DATE is the
        // wrong trade: the operator asked for an invoice and would rather have
        // one without terms than none at all. So the term is dropped and the
        // call retried once, and the caller is told in the log.
        //
        // Narrow on purpose: only this one error, and only when we actually
        // sent the field. Anything else propagates untouched.
        Err(e) if args.due_days.is_some() && mentions_payment_terms(&e) => {
            tracing::warn!(
                "[chargebee] this site has not enabled payment terms for one-time invoices; \
                 raising the invoice without a due date"
            );
            let mut retry = Form::new();
            for (field, value) in form.pairs() {
                if field != "net_term_days" {
                    retry.push(field.clone(), value.clone());
                }
            }
            // A DIFFERENT key from the first attempt, deliberately. Chargebee
            // may have stored that attempt's 400 against its key, and replaying
            // a refusal would turn the recovery into the failure it exists to
            // avoid. The retry is a genuinely different request — it asks for
            // no payment terms — so it gets its own key. A derived key changes
            // on its own, since the body changed; a caller-supplied one is
            // suffixed rather than reused.
            let retry_key = match &args.idempotency_key {
                Some(supplied) => format!("{supplied}-no-terms"),
                None => derived_idempotency_key(&retry),
            };
            client
                .post_form_replayable(path, &retry, Some(&retry_key))
                .await?
        }
        Err(e) => return Err(e),
    };
    let invoice = require(&body, "invoice")?.clone();
    let url = payment_url(client, &customer.id, &currency).await;
    let mut summary = summarize_invoice(&invoice, url);
    if replayed {
        // Chargebee returned an earlier invoice verbatim, so nothing was
        // raised. Reported rather than swallowed: for a retry this is the
        // outcome you want, and for a deliberate second charge it is the one
        // fact that distinguishes "billed twice" from "billed once".
        tracing::warn!(
            invoice_id = %summary.id,
            "[chargebee] send_invoice replayed an earlier invoice for this idempotency key"
        );
        summary.replayed_earlier_invoice = true;
    }
    Ok(summary)
}

/// Fetches one invoice by id.
pub async fn get_invoice(client: &ChargebeeClient, args: GetInvoiceArgs) -> Result<InvoiceSummary> {
    let id = args.invoice_id.trim();
    if id.is_empty() {
        return Err(invalid("`invoice_id` is required"));
    }
    let body = client
        .get(&format!("/invoices/{}", urlencode(id)), &Form::new())
        .await?;
    Ok(summarize_invoice(require(&body, "invoice")?, None))
}

/// Lists invoices, optionally narrowed to one customer and/or status.
pub async fn list_invoices(
    client: &ChargebeeClient,
    args: ListInvoicesArgs,
) -> Result<Vec<InvoiceSummary>> {
    let mut query = Form::new();
    if let Some(email) = args
        .customer_email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // An email that matches nobody must return "no invoices", not "every
        // invoice on the site" — which is what dropping an unresolvable filter
        // would do.
        let Some(customer) = get_customer(client, email).await? else {
            return Ok(Vec::new());
        };
        query.push("customer_id[is]", customer.id);
    }
    query.push_opt("status[is]", args.status);
    query.push_opt("limit", args.limit);

    let body = client.get("/invoices", &query).await?;
    let rows = require_array(&body, "list")?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("invoice"))
        .map(|invoice| summarize_invoice(invoice, None))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_invoice_summary_keeps_the_facts_an_operator_asked_about() {
        let raw = json!({
            "id": "inv_1", "customer_id": "cus_1", "status": "payment_due",
            "currency_code": "USD", "total": 10000, "amount_due": 10000,
            "amount_paid": 0, "due_date": 1786603009,
            "line_items": [{"description": "Consulting", "amount": 10000}],
            // Noise the projection must drop rather than hand to a model.
            "linked_payments": [], "site_details_at_creation": {"timezone": "UTC"}
        });
        let s = summarize_invoice(&raw, Some("https://pay.example".to_string()));
        assert_eq!(s.id, "inv_1");
        assert_eq!(s.status, "payment_due");
        assert_eq!(s.total_in_minor_units, 10_000);
        assert_eq!(s.amount_due_in_minor_units, 10_000);
        assert_eq!(s.line_items, vec!["Consulting".to_string()]);
        assert_eq!(s.payment_url.as_deref(), Some("https://pay.example"));
    }

    #[test]
    fn a_missing_field_does_not_panic_the_projection() {
        // Chargebee omits `due_date` on some invoice shapes, and a summary that
        // panicked on one would take the whole turn with it.
        let s = summarize_invoice(&json!({"id": "inv_2"}), None);
        assert_eq!(s.id, "inv_2");
        assert_eq!(s.status, "unknown");
        assert_eq!(s.due_date, None);
        assert!(s.line_items.is_empty());
    }

    #[test]
    fn a_full_name_splits_into_chargebee_first_and_last() {
        let one = summarize_customer(&json!({"id": "c1", "first_name": "Alan"}));
        assert_eq!(one.name.as_deref(), Some("Alan"));
        let two = summarize_customer(
            &json!({"id": "c2", "first_name": "Ada", "last_name": "Byron", "email": "a@b.test"}),
        );
        assert_eq!(two.name.as_deref(), Some("Ada Byron"));
        assert_eq!(two.email.as_deref(), Some("a@b.test"));
    }

    #[test]
    fn ids_are_percent_encoded_so_they_cannot_retarget_the_path() {
        assert_eq!(urlencode("inv_123"), "inv_123");
        assert_eq!(urlencode("../customers/x"), "..%2Fcustomers%2Fx");
    }

    // ---- Wire-level tests -------------------------------------------------
    //
    // These drive a stub over a real socket rather than stopping at argument
    // validation. The wire format is where this module is most likely to be
    // wrong — form-encoded rather than JSON, `charges[amount][0]` nesting,
    // `email[is]` rather than `email` — and none of it is exercised by a test
    // that never builds a request. Every shape asserted below was also checked
    // against a live Chargebee site.

    use crate::chargebee::types::{ChargeLine, ChargebeeConfig};
    use std::sync::{Arc, Mutex};

    /// A canned reply: `"<METHOD> <path fragment>"`, status, JSON body.
    type Route = (&'static str, u16, &'static str);
    /// The stub's shared state: what it has seen, and what to answer with.
    type StubState = (Arc<Mutex<Vec<Seen>>>, Arc<Vec<Route>>);

    /// One request the stub saw.
    #[derive(Clone, Debug)]
    struct Seen {
        method: String,
        path: String,
        query: String,
        body: String,
        /// The `chargebee-idempotency-key` header, when one was sent.
        idempotency: Option<String>,
    }

    /// Serves canned responses by path prefix and records every request.
    ///
    /// Keyed on `"<METHOD> <path fragment>"` because `send_invoice` is three
    /// calls in a row (customer lookup, invoice create, payment link) and two of
    /// them share the `/customers` path — a route table keyed on path alone
    /// answers the create with the lookup's body, which is exactly how the
    /// fabricated-empty-id bug surfaced.
    ///
    /// Listing the SAME prefix more than once makes it answer differently per
    /// attempt: the Nth request matching a prefix gets that prefix's Nth entry,
    /// clamped to the last. That is what lets a test drive a failure and its
    /// retry through one route table; a prefix listed once behaves as before.
    async fn stub<F, Fut, T>(routes: Vec<Route>, call: F) -> (Result<T>, Vec<Seen>)
    where
        F: FnOnce(ChargebeeClient) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        use axum::extract::State;
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
        let routes = Arc::new(routes);

        let handler = move |State((seen, routes)): State<StubState>,
                            method: axum::http::Method,
                            uri: axum::http::Uri,
                            headers: axum::http::HeaderMap,
                            body: String| async move {
            let path = format!("{method} {}", uri.path());
            let attempt = {
                let mut log = seen.lock().expect("lock");
                let attempt = log
                    .iter()
                    .filter(|s| format!("{} {}", s.method, s.path) == path)
                    .count();
                log.push(Seen {
                    method: method.to_string(),
                    path: uri.path().to_string(),
                    query: uri.query().unwrap_or_default().to_string(),
                    body,
                    idempotency: headers
                        .get("chargebee-idempotency-key")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string),
                });
                attempt
            };
            let matching: Vec<&Route> = routes
                .iter()
                .filter(|(prefix, _, _)| path.contains(prefix))
                .collect();
            let (status, payload) = matching
                .get(attempt.min(matching.len().saturating_sub(1)))
                .map(|(_, s, b)| (*s, *b))
                .unwrap_or((404, "{}"));
            let mut out = axum::http::HeaderMap::new();
            out.insert("content-type", "application/json".parse().expect("header"));
            // Test affordance: an idempotency key beginning `replay-` makes the
            // stub answer the way Chargebee answers a replayed request, so the
            // replay path can be driven end to end without a second live send.
            if seen
                .lock()
                .expect("lock")
                .last()
                .and_then(|s| s.idempotency.as_deref())
                .is_some_and(|key| key.starts_with("replay-"))
            {
                out.insert(
                    "chargebee-idempotency-replayed",
                    "true".parse().expect("header"),
                );
            }
            (
                axum::http::StatusCode::from_u16(status).expect("status"),
                out,
                payload,
            )
        };

        let app = axum::Router::new()
            .fallback(axum::routing::any(handler))
            .with_state((seen.clone(), routes));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = ChargebeeClient::with_base_url(
            ChargebeeConfig {
                site: "test".to_string(),
                api_key: "cb_key".to_string(),
            },
            format!("http://{addr}"),
        )
        .expect("client builds");
        let out = call(client).await;
        server.abort();
        let requests = seen.lock().expect("lock").clone();
        (out, requests)
    }

    fn line(desc: &str, minor: i64) -> ChargeLine {
        ChargeLine {
            description: desc.to_string(),
            amount_in_minor_units: minor,
        }
    }

    const NO_CUSTOMER: &str = r#"{"list":[]}"#;
    const ONE_CUSTOMER: &str =
        r#"{"list":[{"customer":{"id":"cus_1","email":"alan@tinyhumans.ai"}}]}"#;
    const CREATED_CUSTOMER: &str = r#"{"customer":{"id":"cus_new","email":"alan@tinyhumans.ai"}}"#;
    const CREATED_INVOICE: &str = r#"{"invoice":{"id":"inv_1","customer_id":"cus_new","status":"payment_due","currency_code":"USD","total":10000,"amount_due":10000,"amount_paid":0,"line_items":[{"description":"Consulting"}]}}"#;
    const HOSTED_PAGE: &str =
        r#"{"hosted_page":{"url":"https://acme.chargebee.com/pages/v3/abc"}}"#;

    #[tokio::test]
    async fn an_unknown_customer_is_created_before_invoicing() {
        // TC-05: the operator names an email, not an internal id.
        let (result, seen) = stub(
            vec![
                ("GET /customers", 200, NO_CUSTOMER),
                ("POST /customers", 200, CREATED_CUSTOMER),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
            ],
            |client| async move {
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        customer_name: Some("Alan Turing".to_string()),
                        currency_code: "usd".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: Some(7),
                        invoice_note: None,
                        idempotency_key: None,
                    },
                )
                .await
            },
        )
        .await;

        let invoice = result.expect("invoice is created");
        assert_eq!(invoice.status, "payment_due");
        assert_eq!(invoice.total_in_minor_units, 10_000);
        assert_eq!(
            invoice.payment_url.as_deref(),
            Some("https://acme.chargebee.com/pages/v3/abc")
        );

        // The exact sequence matters: look up, then create, then invoice the id
        // the create returned. Asserting it here is what catches a reordering
        // that would invoice against an id nothing had produced yet.
        let calls: Vec<(&str, &str)> = seen
            .iter()
            .map(|r| (r.method.as_str(), r.path.as_str()))
            .collect();
        assert_eq!(
            calls,
            vec![
                ("GET", "/customers"),
                ("POST", "/customers"),
                ("POST", "/invoices/create_for_charge_items_and_charges"),
                ("POST", "/hosted_pages/collect_now"),
            ]
        );

        // The lookup is filtered with the operator suffix — a bare `email=` is
        // ignored by Chargebee and would match the wrong customer.
        assert!(seen[0].query.contains("email%5Bis%5D="), "{:?}", seen[0]);
        // Then the create, splitting the display name across Chargebee's fields.
        assert!(seen[1].body.contains("first_name=Alan"), "{:?}", seen[1]);
        assert!(seen[1].body.contains("last_name=Turing"), "{:?}", seen[1]);
        // Then the invoice, against the id the create returned.
        let inv = &seen[2];
        assert!(inv.body.contains("customer_id=cus_new"), "{inv:?}");
        assert!(inv.body.contains("currency_code=USD"), "{inv:?}");
        assert!(inv.body.contains("net_term_days=7"), "{inv:?}");
        assert!(
            inv.body.contains("charges%5Bamount%5D%5B0%5D=10000"),
            "{inv:?}"
        );
        // The guard that a live site taught us: without this Chargebee charges
        // a stored card on creation and the invoice is born paid.
        assert!(inv.body.contains("auto_collection=off"), "{inv:?}");
    }

    #[tokio::test]
    async fn an_existing_customer_is_reused_and_never_renamed() {
        let (result, seen) = stub(
            vec![
                ("GET /customers", 200, ONE_CUSTOMER),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
            ],
            |client| async move {
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        // Supplied, and must be ignored: invoicing someone is
                        // not a licence to rewrite their name.
                        customer_name: Some("Wrong Name".to_string()),
                        currency_code: "USD".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: None,
                        invoice_note: None,
                        idempotency_key: None,
                    },
                )
                .await
            },
        )
        .await;

        result.expect("invoice is created");
        assert!(
            !seen.iter().any(|r| r.body.contains("Wrong")),
            "an existing customer must not be renamed: {seen:?}"
        );
        assert!(
            seen.iter().any(|r| r.body.contains("customer_id=cus_1")),
            "the existing id must be used: {seen:?}"
        );
    }

    #[tokio::test]
    async fn an_unresolvable_email_returns_no_invoices_rather_than_all_of_them() {
        // Dropping an unresolvable filter would list the whole site's invoices
        // in answer to "has this stranger paid?".
        let (result, seen) = stub(
            vec![("GET /customers", 200, NO_CUSTOMER)],
            |client| async move {
                list_invoices(
                    &client,
                    ListInvoicesArgs {
                        customer_email: Some("nobody@nowhere.test".to_string()),
                        ..Default::default()
                    },
                )
                .await
            },
        )
        .await;

        assert!(result.expect("lookup succeeds").is_empty());
        assert_eq!(
            seen.len(),
            1,
            "the invoice list must not be reached: {seen:?}"
        );
    }

    #[tokio::test]
    async fn a_reply_without_a_list_array_is_an_error_not_an_empty_invoice_list() {
        // `{"list":[]}` is a real empty history, but a 2xx body with no `list`
        // array means the reply's shape moved — reporting that as "no invoices"
        // would be a confident false negative about the billing ledger.
        let (result, _seen) = stub(
            vec![("GET /invoices", 200, r#"{"site":"acme"}"#)],
            |client| async move { list_invoices(&client, ListInvoicesArgs::default()).await },
        )
        .await;

        let err = result.expect_err("a missing `list` is an error");
        assert!(err.to_string().contains("no `list` array"), "{err}");
    }

    #[tokio::test]
    async fn an_invoice_survives_a_payment_link_that_cannot_be_raised() {
        // A site with no gateway configured refuses the hosted page. Reporting
        // "no invoice" for an invoice that exists is the worst answer available.
        let (result, _) = stub(
            vec![
                ("GET /customers", 200, ONE_CUSTOMER),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                (
                    "POST /hosted_pages/collect_now",
                    400,
                    r#"{"message":"no gateway","api_error_code":"invalid_request"}"#,
                ),
            ],
            |client| async move {
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        customer_name: None,
                        currency_code: "USD".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: None,
                        invoice_note: None,
                        idempotency_key: None,
                    },
                )
                .await
            },
        )
        .await;

        let invoice = result.expect("the invoice itself still succeeds");
        assert_eq!(invoice.id, "inv_1");
        assert_eq!(invoice.payment_url, None);
    }

    #[tokio::test]
    async fn a_site_without_payment_terms_still_gets_its_invoice() {
        // Chargebee refuses `net_term_days` outright on a site that has not
        // enabled payment terms for one-time invoices. Failing the whole
        // invoice over a due date is the wrong trade — the operator asked for
        // an invoice, and one without terms beats none.
        let mut calls = 0;
        let (result, seen) = stub(
            vec![
                ("GET /customers", 200, ONE_CUSTOMER),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
            ],
            |client| async move {
                let _ = &mut calls;
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        customer_name: None,
                        currency_code: "INR".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: Some(7),
                        invoice_note: None,
                        idempotency_key: None,
                    },
                )
                .await
            },
        )
        .await;
        // The happy path still sends the term when the site accepts it.
        result.expect("invoice created");
        assert!(
            seen.iter().any(|r| r.body.contains("net_term_days=7")),
            "the term must still be sent to a site that accepts it: {seen:?}"
        );
    }

    /// Chargebee's own words when the site lacks the feature.
    const TERMS_REFUSED: &str = r#"{"api_error_code":"invalid_request","message":"net_term_days : should not be sent as the Payment Terms for One-Time Invoices feature is not enabled"}"#;

    #[tokio::test]
    async fn the_payment_terms_refusal_is_retried_without_the_term() {
        // The other half of the trade above: when the site actually refuses,
        // the invoice is raised anyway, once, without `net_term_days`.
        let (result, seen) = stub(
            vec![
                ("GET /customers", 200, ONE_CUSTOMER),
                // Listed twice — the first attempt is refused, the retry lands.
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    400,
                    TERMS_REFUSED,
                ),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
            ],
            |client| async move {
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        customer_name: None,
                        currency_code: "USD".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: Some(7),
                        invoice_note: None,
                        idempotency_key: None,
                    },
                )
                .await
            },
        )
        .await;

        let invoice = result.expect("the invoice survives a site without payment terms");
        assert_eq!(invoice.id, "inv_1");

        let creates: Vec<&Seen> = seen
            .iter()
            .filter(|r| r.path.contains("create_for_charge_items_and_charges"))
            .collect();
        assert_eq!(creates.len(), 2, "one refusal, one retry: {seen:?}");
        assert!(
            creates[0].body.contains("net_term_days=7"),
            "the first attempt asks for the term: {:?}",
            creates[0]
        );
        assert!(
            !creates[1].body.contains("net_term_days"),
            "the retry must drop it: {:?}",
            creates[1]
        );
        // The rest of the invoice is unchanged — a retry that also lost the
        // amount would be worse than the failure it replaces.
        assert!(creates[1].body.contains("charges%5Bamount%5D%5B0%5D=10000"));
        // And it carries a DIFFERENT key: Chargebee may have stored the 400
        // against the first one, and replaying a refusal would defeat the
        // retry entirely.
        let first = creates[0].idempotency.as_deref().expect("first key");
        let retry = creates[1].idempotency.as_deref().expect("retry key");
        assert_ne!(first, retry, "the retry needs its own key: {seen:?}");
    }

    #[tokio::test]
    async fn every_send_carries_an_idempotency_key_even_when_none_was_supplied() {
        // The model has no reason to invent one, so every send observed in
        // testing omitted it — leaving a lost response and a resend to bill the
        // customer twice.
        let (result, seen) = stub(
            vec![
                ("GET /customers", 200, ONE_CUSTOMER),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
            ],
            |client| async move {
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        customer_name: None,
                        currency_code: "USD".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: None,
                        invoice_note: None,
                        idempotency_key: None,
                    },
                )
                .await
            },
        )
        .await;
        let invoice = result.expect("invoice created");
        // Nothing was replayed, so the field stays out of the agent's view.
        assert!(!invoice.replayed_earlier_invoice);
        let create = seen
            .iter()
            .find(|r| r.path.contains("create_for_charge_items_and_charges"))
            .expect("the invoice was created");
        assert!(
            create
                .idempotency
                .as_deref()
                .is_some_and(|key| key.starts_with("oc-invoice-")),
            "a key must be derived when the caller supplies none: {create:?}"
        );
    }

    #[test]
    fn a_derived_key_is_a_fixed_value_not_merely_self_consistent() {
        // Pinned as a literal on purpose. A hash that is only stable within one
        // process still bills a customer twice when the retry lands on a host
        // built from a different toolchain, or on a sibling behind a load
        // balancer -- so "same input, same key" has to hold across builds, and
        // the only way to assert that is to write the value down.
        let mut form = Form::new();
        form.push("customer_id", "cus_1");
        form.push("currency_code", "USD");
        form.push_indexed("charges", "amount", 0, 10_000);
        let key = derived_idempotency_key(&form);
        assert_eq!(key, "oc-invoice-e989cc10e2e5e7d0", "{key}");

        // Field boundaries are part of the input: without a separator these two
        // hash identically, and two different invoices would share a key --
        // which silently drops the second.
        let mut ab_c = Form::new();
        ab_c.push("ab", "c");
        let mut a_bc = Form::new();
        a_bc.push("a", "bc");
        assert_ne!(
            derived_idempotency_key(&ab_c),
            derived_idempotency_key(&a_bc)
        );
    }

    #[tokio::test]
    async fn a_derived_key_is_stable_for_the_same_invoice_and_differs_across_invoices() {
        // The whole point: a retry of the same send must reuse the key, and a
        // different invoice must not collide with it.
        async fn key_for(amount: i64) -> String {
            let (result, seen) = stub(
                vec![
                    ("GET /customers", 200, ONE_CUSTOMER),
                    (
                        "POST /invoices/create_for_charge_items_and_charges",
                        200,
                        CREATED_INVOICE,
                    ),
                    ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
                ],
                |client| async move {
                    send_invoice(
                        &client,
                        SendInvoiceArgs {
                            customer_email: "alan@tinyhumans.ai".to_string(),
                            customer_name: None,
                            currency_code: "USD".to_string(),
                            line_items: vec![line("Consulting", amount)],
                            due_days: None,
                            invoice_note: None,
                            idempotency_key: None,
                        },
                    )
                    .await
                },
            )
            .await;
            result.expect("invoice created");
            seen.iter()
                .find(|r| r.path.contains("create_for_charge_items_and_charges"))
                .and_then(|r| r.idempotency.clone())
                .expect("a key was sent")
        }

        assert_eq!(key_for(10_000).await, key_for(10_000).await);
        assert_ne!(key_for(10_000).await, key_for(20_000).await);
    }

    #[tokio::test]
    async fn a_replayed_invoice_says_so_rather_than_reading_as_a_new_one() {
        // A replay returns the original invoice verbatim, so without this flag
        // a deliberate second charge that was deduped is indistinguishable from
        // a successful new invoice — a silent failure to bill.
        let (result, _seen) = stub(
            vec![
                ("GET /customers", 200, ONE_CUSTOMER),
                (
                    "POST /invoices/create_for_charge_items_and_charges",
                    200,
                    CREATED_INVOICE,
                ),
                ("POST /hosted_pages/collect_now", 200, HOSTED_PAGE),
            ],
            |client| async move {
                send_invoice(
                    &client,
                    SendInvoiceArgs {
                        customer_email: "alan@tinyhumans.ai".to_string(),
                        customer_name: None,
                        currency_code: "USD".to_string(),
                        line_items: vec![line("Consulting", 10_000)],
                        due_days: None,
                        invoice_note: None,
                        // The stub answers this the way Chargebee answers a
                        // replay.
                        idempotency_key: Some("replay-abc".to_string()),
                    },
                )
                .await
            },
        )
        .await;

        let invoice = result.expect("a replay is still a successful call");
        assert!(
            invoice.replayed_earlier_invoice,
            "the replay must be reported: {invoice:?}"
        );
        let rendered = serde_json::to_string(&invoice).expect("serialises");
        assert!(
            rendered.contains("replayed_earlier_invoice"),
            "and it must reach the agent: {rendered}"
        );
    }

    #[test]
    fn only_the_payment_terms_refusal_triggers_the_retry() {
        let terms = OpenCompanyError::Chargebee {
            status: 400,
            code: "invalid_request".to_string(),
            message: "net_term_days : should not be sent as the Payment Terms for One-Time \
                      Invoices feature is not enabled"
                .to_string(),
        };
        assert!(mentions_payment_terms(&terms));

        // An unrelated invalid_request that happens to mention one word must
        // NOT be swallowed and silently retried.
        let other = OpenCompanyError::Chargebee {
            status: 400,
            code: "invalid_request".to_string(),
            message: "net_term_days must be a positive integer".to_string(),
        };
        assert!(!mentions_payment_terms(&other));
        assert!(!mentions_payment_terms(&invalid("something else entirely")));
    }

    #[tokio::test]
    async fn dollars_written_as_cents_are_caught_at_the_floor_only() {
        // The naming convention carries the real weight; the floor is all a
        // guard can check without reading intent.
        let (result, seen) = stub(vec![], |client| async move {
            send_invoice(
                &client,
                SendInvoiceArgs {
                    customer_email: "alan@tinyhumans.ai".to_string(),
                    customer_name: None,
                    currency_code: "USD".to_string(),
                    line_items: vec![line("Consulting", 0)],
                    due_days: None,
                    invoice_note: None,
                    idempotency_key: None,
                },
            )
            .await
        })
        .await;

        let err = result.expect_err("a zero amount is rejected");
        assert!(err.to_string().contains("at least 1"), "got: {err}");
        assert!(seen.is_empty(), "rejected before any request: {seen:?}");
    }

    #[tokio::test]
    async fn an_empty_or_blank_invoice_id_is_rejected_before_any_request() {
        for id in ["", "   "] {
            let (result, seen) = stub(vec![], |client| async move {
                get_invoice(
                    &client,
                    GetInvoiceArgs {
                        invoice_id: id.to_string(),
                    },
                )
                .await
            })
            .await;

            let err = result.expect_err("a blank invoice_id must be refused locally");
            assert!(
                err.to_string().contains("invoice_id"),
                "got: {err} for input {id:?}"
            );
            assert!(
                seen.is_empty(),
                "rejected before any request: {seen:?} for input {id:?}"
            );
        }
    }
}
