//! The card-titling pass: one tool-less model call that names the work a
//! request asks for.
//!
//! # What it replaces
//!
//! Every card was named by shortening the message that opened it, so a board
//! read as a chat log — `hey can you take a look at the pricing page, I think
//! the tiers are…` where a task list wanted `Reword the middle pricing tier`.
//! Three producers had each written their own truncator and all three landed on
//! the same shape, because nothing said a title was anything other than the
//! first eighty characters of whatever arrived.
//!
//! # It names, it does not scope
//!
//! The request is the specification; this only says what it is. A model that
//! adds a step nobody asked for writes a card the company may then work, so the
//! prompt forbids it and the caller keeps the full ask in the card's note either
//! way — nothing is lost by a title that is too plain, and something is invented
//! by one that is too helpful. The request carries no tools, so there is no loop
//! and nothing it can reach.
//!
//! # Failure is a duller title, never an error
//!
//! Unreachable, slow, or unreadable all return `None`, and the caller falls back
//! to shortening the request exactly as before. A card is never left unnamed and
//! card creation never fails for want of a model: an offline company keeps the
//! behaviour it has today, and the operator is never shown an inference error
//! for a headline.
//!
//! # The cap is enforced here, not requested
//!
//! [`TaskTitle`] normalises and bounds every value it holds, so a model that
//! answers with a paragraph, a quoted string, `Title: …`, markdown emphasis, or
//! a trailing full stop is corrected rather than trusted. The prompt asks for
//! the right shape because that produces better titles; the type is what
//! guarantees it.

use std::sync::Arc;
use std::time::Duration;

use tinyinference::message::Message;
use tinyinference::model::{ModelRequest, ModelResponse};

use crate::harness::HarnessDeps;
use crate::harness::build::model_for_tier;
use crate::harness::provider::HarnessModel;
use crate::ports::tasks::{TaskTitle, TitleSummariser};
use crate::ports::types::TokenUsage;

/// How long a titling pass may wait on the model before it is abandoned.
///
/// The same budget class as a triage escalation and for the same reason: a
/// person is watching a chat thread with no reply, and the card is opened on the
/// way to answering them. Past this the shortened request is simply better than
/// a late name, and the fallback costs nothing.
const TITLE_TIMEOUT: Duration = Duration::from_secs(3);

/// Output-token ceiling. The answer is a handful of words; this is headroom for
/// a model that wraps them in punctuation, not room to explain itself.
const MAX_OUTPUT_TOKENS: u32 = 32;

/// Deterministic. The same request should name the same card every time — a
/// board whose headlines shift between two runs of the same ask is a board
/// nobody can scan.
///
/// The shared constant rather than a local `0.0`: it is what
/// `Sampling::from_request` reads back as an *intent*, so this workload also
/// gets `seed` where the model supports one, and degrades rather than 400s on a
/// model that forbids a temperature outright.
const TEMPERATURE: f64 = crate::company::inference::dialect::DETERMINISTIC;

/// The system prompt.
///
/// Written as instructions about the *output*, not about the domain: the model
/// is given one message and asked for one line. The negative rules are the
/// load-bearing half — every one of them names a failure seen from a model
/// asked to summarise, and the sanitiser behind them assumes none of them held.
fn system_prompt() -> String {
    "You name tasks. You are given one message somebody sent to their company's \
     chat, and you reply with a short title for the work it asks for.\n\
     \n\
     Reply with the title and nothing else. No quotes, no markdown, no \
     `Title:` prefix, no trailing full stop, no explanation.\n\
     \n\
     Rules:\n\
     \n\
     - Start with a verb, in the imperative: `Reword the middle pricing tier`, \
     `Fix the login redirect`, `Draft the Q3 board update`.\n\
     - At most eight words. Shorter is better.\n\
     - Name only what was actually asked for. Do not add steps, deliverables, \
     or scope the message does not ask for. If the message asks for one small \
     thing, the title is that one small thing.\n\
     - Drop the politeness, the hedging, the reasoning and the background. \
     Those stay on the card; the title is the headline.\n\
     - Keep the message's own language. Do not translate it.\n\
     - Do not add names, dates, numbers or systems the message does not \
     mention.\n\
     \n\
     If the message is already a short task title, reply with it unchanged."
        .to_string()
}

/// The system prompt, for the fixture that has to recognise a titling request
/// without consuming a scripted turn.
#[cfg(test)]
pub fn system_prompt_for_test() -> String {
    system_prompt()
}

/// A model that names the work a request asks for.
///
/// Holds no runtime handle, mirroring [`TriageEvaluator`]: the caller already
/// has the handles metering needs, and an evaluator that owned the runtime back
/// would be a cycle that never frees.
///
/// [`TriageEvaluator`]: crate::harness::triage::TriageEvaluator
pub struct TitleEvaluator {
    model: Arc<dyn HarnessModel>,
    model_name: String,
}

impl TitleEvaluator {
    /// Wires an evaluator to a model and the name to address it by.
    pub fn new(model: Arc<dyn HarnessModel>, model_name: String) -> Self {
        Self { model, model_name }
    }

    /// Wires an evaluator from the harness deps.
    ///
    /// Takes the roster's own default rather than naming a cheap tier, for the
    /// reason [`TriageEvaluator::from_deps`] gives at length: an abstract tier a
    /// tenant's `[inference].models` table does not map is passed to their
    /// provider verbatim, so inventing one here would send an unknown model name
    /// to every BYOK tenant that had not opted in. Cheapness comes from the
    /// shape of the call — no tools, a short prompt, a tiny output ceiling.
    ///
    /// [`TriageEvaluator::from_deps`]: crate::harness::triage::TriageEvaluator::from_deps
    pub fn from_deps(deps: &HarnessDeps) -> Self {
        let model_name = deps
            .model_override
            .clone()
            .unwrap_or_else(|| model_for_tier(None));
        Self::new(deps.provider.clone(), model_name)
    }

    /// The provider slug this evaluator's usage is metered under, read live so a
    /// BYOK switch re-attributes the next pass.
    pub fn provider_slug(&self) -> String {
        self.model.telemetry_provider_id()
    }

    /// The model this pass's usage is metered against, read live off the
    /// provider. `None` before the provider has issued a turn, or when it cannot
    /// name a model.
    pub fn model_slug(&self) -> Option<crate::metering::ModelSlug> {
        self.model.telemetry_model()
    }

    /// Names the work `request` asks for, with what the call cost.
    ///
    /// Never returns an error: unreachable, too slow, and unreadable are all
    /// `None`, and the caller shortens the request instead. The [`TokenUsage`]
    /// is still returned when the reply could not be used, because those tokens
    /// were really spent and must still be metered.
    ///
    /// An empty or whitespace-only request short-circuits: there is nothing to
    /// name, and a model asked to title nothing invents something.
    pub async fn title(&self, request: &str) -> (Option<TaskTitle>, TokenUsage) {
        if request.trim().is_empty() {
            return (None, TokenUsage::default());
        }
        let request = ModelRequest {
            messages: vec![
                Message::system(system_prompt()),
                Message::user(request.to_string()),
            ],
            model: Some(self.model_name.clone()),
            temperature: Some(TEMPERATURE),
            max_tokens: Some(MAX_OUTPUT_TOKENS),
            ..ModelRequest::default()
        };
        let response =
            match tokio::time::timeout(TITLE_TIMEOUT, self.model.invoke(&(), request)).await {
                Ok(Ok(response)) => response,
                Ok(Err(err)) => {
                    tracing::debug!(
                        error = %err,
                        "[title] the model could not be reached; shortening the request instead"
                    );
                    return (None, TokenUsage::default());
                }
                Err(_elapsed) => {
                    tracing::debug!(
                        timeout_s = TITLE_TIMEOUT.as_secs(),
                        "[title] the model did not answer in time; shortening the request instead"
                    );
                    return (None, TokenUsage::default());
                }
            };
        let usage = usage_from(&response);
        (TaskTitle::summarised(&response.text()), usage)
    }
}

/// The production pass: a [`TitleEvaluator`] whose spend lands on the company's
/// usage and ledger before the title is returned.
pub struct MeteredTitler {
    evaluator: TitleEvaluator,
    company: crate::ports::types::CompanyId,
    store: Arc<dyn crate::ports::CompanyStore>,
    meter: Option<Arc<dyn crate::ports::usage::UsageMeter>>,
    /// Held for the plan-level ceiling check alone. The pass runs before any
    /// teammate has the card, so there is no agent whose refusal would carry it.
    deps: HarnessDeps,
}

impl MeteredTitler {
    /// Wires a titling pass for `company` from the harness deps.
    pub fn from_deps(deps: &HarnessDeps, company: crate::ports::types::CompanyId) -> Self {
        Self {
            evaluator: TitleEvaluator::from_deps(deps),
            company,
            store: deps.store.clone(),
            meter: deps.meter.clone(),
            deps: deps.clone(),
        }
    }
}

#[async_trait::async_trait]
impl TitleSummariser for MeteredTitler {
    async fn title(&self, request: &str) -> Option<TaskTitle> {
        // The plan-level total-token ceiling gates naming a card, exactly as it
        // gates a responder selection (issue #1872). Both run before any agent
        // exists, so `total_ceiling_refusal` has nobody to refuse as and never
        // fires — and without this a tenant past the hard ceiling keeps paying,
        // one call per card opened, after the point that is supposed to permit
        // no model calls at all. `None` costs nothing and lands the caller on
        // the name it would have used anyway (codex on #2055).
        if crate::harness::HarnessPool::total_ceiling_spent(&self.company, &self.deps).await {
            tracing::info!(
                company = %self.company,
                "[title] total token ceiling reached; naming the card from the request instead"
            );
            return None;
        }
        let (title, usage) = self.evaluator.title(request).await;
        crate::metering::record_title_usage(
            &usage,
            &self.evaluator.provider_slug(),
            self.evaluator.model_slug(),
            &self.company,
            self.store.as_ref(),
            self.meter.as_ref().map(|meter| meter.as_ref()),
        )
        .await;
        title
    }
}

/// Token spend for one titling pass, including the cost the managed provider
/// reports on the wire. Mirrors the triage pass's reader.
fn usage_from(response: &ModelResponse) -> TokenUsage {
    let tokens = response.usage.unwrap_or_default();
    let cost_usd = response
        .raw
        .as_ref()
        .and_then(|raw| raw.pointer("/openhuman_usage_meta/charged_amount_usd"))
        .and_then(serde_json::Value::as_f64)
        .filter(|c| c.is_finite() && *c > 0.0)
        .unwrap_or(0.0);
    TokenUsage {
        input: tokens.input_tokens,
        output: tokens.output_tokens,
        cached_input: tokens.cache_read_tokens,
        cost_usd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tinyinference::Result as TaResult;
    use tinyinference::model::ChatModel;

    /// A model that answers every request with one canned reply.
    struct Canned(&'static str);

    #[async_trait::async_trait]
    impl ChatModel<()> for Canned {
        async fn invoke(&self, _state: &(), _request: ModelRequest) -> TaResult<ModelResponse> {
            Ok(ModelResponse::assistant(self.0))
        }
    }

    impl HarnessModel for Canned {
        fn telemetry_provider_id(&self) -> String {
            "test".to_string()
        }

        fn telemetry_model(&self) -> Option<crate::metering::ModelSlug> {
            None
        }
    }

    async fn titled(reply: &'static str) -> Option<TaskTitle> {
        TitleEvaluator::new(Arc::new(Canned(reply)), "chat-v1".to_string())
            .title("do the thing")
            .await
            .0
    }

    /// The shapes a model actually replies in — quoted, prefixed, emphasised,
    /// full-stopped — all reduce to the bare name.
    #[tokio::test]
    async fn a_title_survives_the_shapes_a_model_replies_in() {
        for reply in [
            "Reword the middle pricing tier",
            "\"Reword the middle pricing tier\"",
            "Title: Reword the middle pricing tier",
            "**Reword the middle pricing tier**",
            "`Reword the middle pricing tier`",
            "Reword the middle pricing tier.",
            "Task: \"Reword the middle pricing tier\".",
            "  Reword the middle pricing tier  \n\nLet me know if you want another.",
        ] {
            assert_eq!(
                titled(reply).await.expect(reply).as_str(),
                "Reword the middle pricing tier",
                "{reply}"
            );
        }
    }

    /// A reply with no name in it leaves the caller on its fallback rather than
    /// putting punctuation on the board.
    #[tokio::test]
    async fn an_unusable_reply_is_no_title_rather_than_a_bad_one() {
        for reply in ["", "   ", "\n\n", "\"\"", "**", "...", "Title:"] {
            assert!(titled(reply).await.is_none(), "{reply:?}");
        }
    }

    /// A model that ignores the word ceiling is cut to the cap the type
    /// advertises — the prompt asks, the type enforces.
    #[tokio::test]
    async fn a_paragraph_is_bounded_rather_than_trusted() {
        let title = titled(
            "Take a really good look at the whole of the pricing page and then rewrite \
             every single one of the tiers from scratch including the middle one",
        )
        .await
        .expect("a long reply still names something");
        assert!(
            title.as_str().chars().count() <= crate::ports::tasks::TASK_TITLE_MAX_CHARS,
            "{title}"
        );
        assert!(!title.as_str().contains('\n'));
    }

    /// Nothing asked is nothing named, and the model is never consulted about
    /// it — an empty request is the one input that makes a titler invent.
    #[tokio::test]
    async fn an_empty_request_is_not_sent_to_the_model() {
        let evaluator = TitleEvaluator::new(Arc::new(Canned("Invented work")), "m".to_string());
        for request in ["", "   ", "\n\t "] {
            assert!(evaluator.title(request).await.0.is_none(), "{request:?}");
        }
    }

    /// A request already written as a title comes back as one, not degraded.
    #[tokio::test]
    async fn an_already_good_title_is_left_alone() {
        assert_eq!(
            titled("Fix the login redirect")
                .await
                .expect("a title")
                .as_str(),
            "Fix the login redirect"
        );
    }

    /// Non-Latin scripts survive intact — the sanitiser is character-wise
    /// throughout, and capitalisation is a no-op where the script has no case.
    #[tokio::test]
    async fn a_non_english_title_is_not_mangled() {
        assert_eq!(
            titled("価格ページの中段プランを書き直す")
                .await
                .expect("a title")
                .as_str(),
            "価格ページの中段プランを書き直す"
        );
    }
}
