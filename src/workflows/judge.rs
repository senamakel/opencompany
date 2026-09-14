//! The opt-in semantic sufficiency gate for workflow agent nodes (issue #1866).

use std::time::Duration;

use serde::Deserialize;
use tinyinference::message::Message;
use tinyinference::model::{ModelRequest, ModelResponse};

use crate::harness::HarnessDeps;
use crate::harness::build::model_for_tier;
use crate::ports::blockers::BlockerKind;
use crate::ports::types::{CompanyId, CompanyRecord, TokenUsage};
use crate::runtime::delegation::RunTurn;

const JUDGE_TIMEOUT: Duration = Duration::from_secs(30);
/// The wall-clock bound on the single peer turn the last recovery rung spends.
/// Wider than [`JUDGE_TIMEOUT`] because a peer runs a full tool-using turn, not
/// a one-shot completion; a consultation that overruns it yields no evidence.
const PEER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_TOKENS: u32 = 256;
const MAX_QUERY_CHARS: usize = 800;
const MAX_RECOVERY_ITEMS: usize = 3;
const MAX_RECOVERY_CHARS: usize = 4_000;
const INSTRUCTION_CAP: usize = 8_000;
const INSTRUCTION_TAIL_RESERVE: usize = 2_000;
const OUTPUT_CAP: usize = 20_000;
const RECOVERED_CONTEXT_HEADING: &str = "\n\nRecovered company context:\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SufficiencyVerdict {
    Continue,
    Retry,
    Recover,
    Escalate { gap: BlockerKind },
    HaltBenign,
}

impl SufficiencyVerdict {
    pub const fn token(self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::Retry => "retry",
            Self::Recover => "recover",
            Self::Escalate { .. } => "escalate",
            Self::HaltBenign => "halt_benign",
        }
    }

    pub const fn tokens() -> [&'static str; 5] {
        [
            Self::Continue.token(),
            Self::Retry.token(),
            Self::Recover.token(),
            Self::Escalate {
                gap: BlockerKind::Information,
            }
            .token(),
            Self::HaltBenign.token(),
        ]
    }

    fn from_parts(token: &str, gap: Option<&str>) -> Option<Self> {
        let tokens = Self::tokens();
        Some(if token == tokens[0] {
            Self::Continue
        } else if token == tokens[1] {
            Self::Retry
        } else if token == tokens[2] {
            Self::Recover
        } else if token == tokens[3] {
            Self::Escalate {
                gap: BlockerKind::from_wire(gap?)?,
            }
        } else if token == tokens[4] {
            Self::HaltBenign
        } else {
            return None;
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct JudgeInput<'a> {
    pub instruction: &'a str,
    pub output: &'a str,
    pub criteria: Option<&'a str>,
    pub execution_failed: bool,
}

#[derive(Debug, Deserialize)]
struct JudgeAnswer {
    verdict: String,
    #[serde(default)]
    gap: Option<String>,
}

fn system_prompt() -> String {
    let [
        continue_token,
        retry_token,
        recover_token,
        escalate_token,
        halt_token,
    ] = SufficiencyVerdict::tokens();
    let gaps = [
        BlockerKind::Information.as_str(),
        BlockerKind::Infrastructure.as_str(),
        BlockerKind::Transient.as_str(),
    ]
    .join("|");
    format!(
        "Judge whether one workflow node's output is semantically sufficient. Return one JSON \
         object only: {{\"verdict\":\"TOKEN\",\"gap\":\"GAP\"}}. TOKEN is exactly one of \
         {continue_token}|{retry_token}|{recover_token}|{escalate_token}|{halt_token}. GAP is \
         required only for {escalate_token} and is exactly one of {gaps}. Choose {continue_token} \
         when the output fulfills the instruction and criteria. Choose {retry_token} for an \
         inadequate attempt likely fixed by rerunning. Choose {recover_token} only when existing \
         company knowledge may fill a missing fact. Choose {escalate_token} when a person or \
         infrastructure change is required. Choose {halt_token} only when the requested work is \
         intentionally unnecessary or already satisfied. Never choose {halt_token} for blank, \
         failed, errored, refused, truncated, or otherwise insufficient output. Do not use tools."
    )
}

fn user_prompt(input: JudgeInput<'_>) -> String {
    format!(
        "INSTRUCTION:\n{}\n\nSUCCESS CRITERIA:\n{}\n\nEXECUTION FAILED: {}\n\nOUTPUT:\n{}",
        cap_keeping_tail(input.instruction, INSTRUCTION_CAP, INSTRUCTION_TAIL_RESERVE),
        input.criteria.unwrap_or("No additional criteria supplied."),
        input.execution_failed,
        cap(input.output, OUTPUT_CAP),
    )
}

/// Composes a reply and the evidence recovery found into the text the
/// re-verification pass judges, keeping the evidence inside [`OUTPUT_CAP`].
pub(crate) fn augment_with_recovery(reply: &str, evidence: &str) -> String {
    let block = format!("{RECOVERED_CONTEXT_HEADING}{evidence}");
    let room = OUTPUT_CAP.saturating_sub(block.chars().count() + 1);
    format!("{}{block}", cap(reply, room))
}

fn parse_verdict(text: &str) -> Option<SufficiencyVerdict> {
    let answer: JudgeAnswer = serde_json::from_str(text.trim()).ok()?;
    SufficiencyVerdict::from_parts(answer.verdict.trim(), answer.gap.as_deref().map(str::trim))
}

fn enforce_anti_suppression(
    verdict: SufficiencyVerdict,
    input: JudgeInput<'_>,
) -> SufficiencyVerdict {
    if verdict == SufficiencyVerdict::HaltBenign
        && (input.execution_failed || input.output.trim().is_empty())
    {
        SufficiencyVerdict::Retry
    } else {
        verdict
    }
}

pub async fn judge_sufficiency(
    deps: &HarnessDeps,
    company: &CompanyId,
    input: JudgeInput<'_>,
) -> SufficiencyVerdict {
    if crate::harness::HarnessPool::total_ceiling_spent(company, deps).await {
        tracing::info!(
            company = %company,
            "[capability-budget] total token ceiling reached; skipping the sufficiency judge \
             (no model call)"
        );
        return SufficiencyVerdict::Retry;
    }

    let model = deps
        .model_override
        .clone()
        .unwrap_or_else(|| model_for_tier(None));
    let request = ModelRequest {
        messages: vec![
            Message::system(system_prompt()),
            Message::user(user_prompt(input)),
        ],
        model: Some(model),
        temperature: Some(crate::company::inference::dialect::DETERMINISTIC),
        max_tokens: Some(MAX_OUTPUT_TOKENS),
        ..ModelRequest::default()
    };
    let response = match tokio::time::timeout(JUDGE_TIMEOUT, deps.provider.invoke(&(), request))
        .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => {
            tracing::warn!(company = %company, error = %err, "workflow sufficiency judge failed");
            return SufficiencyVerdict::Retry;
        }
        Err(_) => {
            tracing::warn!(company = %company, "workflow sufficiency judge timed out");
            return SufficiencyVerdict::Retry;
        }
    };

    let usage = usage_from(&response);
    crate::metering::record_judge_usage(
        &usage,
        &deps.provider.telemetry_provider_id(),
        deps.provider.telemetry_model(),
        company,
        deps.store.as_ref(),
        deps.meter.as_deref(),
    )
    .await;

    let verdict = parse_verdict(&response.text()).unwrap_or(SufficiencyVerdict::Retry);
    enforce_anti_suppression(verdict, input)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryResult {
    pub evidence: Option<String>,
    pub log: String,
}

const MAX_FOCUS_TERMS: usize = 6;
const MIN_FOCUS_TERM_LEN: usize = 4;

/// Candidate single-word `FactStore` queries pulled out of a natural-language
/// question (issue #1990 review, #3903591432): `FactStore::list`'s query is a
/// case-insensitive substring match over a fact's title + body, so the whole
/// question almost never appears verbatim even when a fact IS the answer — a
/// fact titled "Renewal date" never matches the sentence "The answer must
/// include the renewal date". Lowercased, deduplicated, common short/filler
/// words dropped, capped so the bounded recovery ladder stays bounded.
fn focus_terms(question: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the",
        "and",
        "that",
        "this",
        "with",
        "from",
        "must",
        "have",
        "will",
        "shall",
        "should",
        "answer",
        "include",
        "includes",
        "criteria",
        "success",
        "about",
        "into",
        "onto",
        "than",
        "then",
        "when",
        "what",
        "which",
        "specifically",
        "please",
        "need",
        "needs",
    ];
    let mut terms = Vec::new();
    for word in question.split(|c: char| !c.is_alphanumeric()) {
        let lower = word.to_lowercase();
        if lower.chars().count() < MIN_FOCUS_TERM_LEN {
            continue;
        }
        if STOPWORDS.contains(&lower.as_str()) || terms.contains(&lower) {
            continue;
        }
        terms.push(lower);
        if terms.len() >= MAX_FOCUS_TERMS {
            break;
        }
    }
    terms
}

/// What a workflow node lends the last recovery rung so it can put the question
/// to a teammate: the turn seam a peer runs on, the roster it is chosen from,
/// and the node's own agent, which is never its own peer.
pub struct PeerConsult<'a> {
    pub turn: &'a dyn RunTurn,
    pub record: &'a CompanyRecord,
    pub exclude_agent: &'a str,
    /// The workflow this recovery rung belongs to (issue #2150), so the
    /// peer's turn can be scoped with the same `RunOrigin::Dispatched`
    /// trust a workflow agent node's own turn carries.
    pub workflow_id: &'a str,
}

/// How the one peer consultation ended, so `ask_around` can log each outcome
/// distinctly rather than collapsing "nobody knew" into "nobody was asked".
enum PeerOutcome {
    Answered {
        id: String,
        role: String,
        answer: String,
    },
    Empty {
        id: String,
    },
    Failed {
        id: String,
        error: String,
    },
    TimedOut {
        id: String,
    },
    NoRoleMatched,
    CeilingReached,
}

/// The roster entry whose role, description or name shares the most
/// [`focus_terms`] with the question, or `None` when none shares any.
///
/// Pure and model-free: selecting a peer must not itself cost a model call.
/// Ties keep roster order, so one roster and question always pick one peer.
fn pick_peer(
    record: &CompanyRecord,
    question: &str,
    exclude_agent: &str,
) -> Option<crate::company::Agent> {
    let terms = focus_terms(question);
    if terms.is_empty() {
        return None;
    }
    let mut best: Option<(usize, crate::company::Agent)> = None;
    for agent in record.effective_agents() {
        if agent.id == exclude_agent {
            continue;
        }
        let haystack = format!(
            "{} {} {}",
            agent.role,
            agent.description.as_deref().unwrap_or_default(),
            agent.name.as_deref().unwrap_or_default()
        )
        .to_lowercase();
        let score = terms
            .iter()
            .filter(|term| haystack.contains(term.as_str()))
            .count();
        if score > 0 && best.as_ref().is_none_or(|(top, _)| score > *top) {
            best = Some((score, agent));
        }
    }
    best.map(|(_, agent)| agent)
}

fn peer_prompt(question: &str) -> String {
    format!(
        "A workflow step cannot finish because it is missing company information. Answer from \
         what you already know, in a few sentences. If you do not know, reply with nothing at \
         all.\n\n{question}"
    )
}

/// Puts the question to exactly one peer, under [`PEER_TIMEOUT`], through
/// `run_background` — a consultation is not a workflow node and must not be
/// tagged as one on the console's run trace.
async fn consult_peer(
    deps: &HarnessDeps,
    company: &CompanyId,
    question: &str,
    consult: &PeerConsult<'_>,
) -> PeerOutcome {
    if crate::harness::HarnessPool::total_ceiling_spent(company, deps).await {
        tracing::info!(
            company = %company,
            "[capability-budget] total token ceiling reached; skipping the peer recovery rung \
             (no model call)"
        );
        return PeerOutcome::CeilingReached;
    }
    let Some(peer) = pick_peer(consult.record, question, consult.exclude_agent) else {
        return PeerOutcome::NoRoleMatched;
    };
    let ask = peer_prompt(question);
    // Issue #2150: the peer's turn is dispatched by this recovery rung, not
    // asked by an operator — the same trust a workflow agent node's own turn
    // carries, named for the peer actually chosen rather than the node that
    // raised the question.
    let origin = crate::harness::built_in::run_origin::claim(
        crate::harness::built_in::run_origin::RunOrigin::Dispatched {
            agent: peer.id.clone(),
            source: crate::harness::built_in::run_origin::DispatchSource::Workflow {
                workflow_id: consult.workflow_id.to_string(),
            },
            scope: None,
        },
    );
    match tokio::time::timeout(
        PEER_TIMEOUT,
        origin.scoped(Box::pin(
            consult.turn.run_background(company, &peer.id, &ask, None),
        )),
    )
    .await
    {
        Ok(Ok(outcome)) => {
            let answer = cap(&outcome.reply, MAX_RECOVERY_CHARS);
            if answer.is_empty() {
                PeerOutcome::Empty { id: peer.id }
            } else {
                PeerOutcome::Answered {
                    id: peer.id,
                    role: peer.role,
                    answer,
                }
            }
        }
        Ok(Err(err)) => PeerOutcome::Failed {
            id: peer.id,
            error: err.to_string(),
        },
        Err(_) => PeerOutcome::TimedOut { id: peer.id },
    }
}

/// Bounded fact → workspace → one-peer recovery, in that order, each rung run
/// only when every rung above it found nothing.
///
/// The first two rungs are local reads. The third spends one turn on exactly
/// one roster peer chosen by [`pick_peer`] and bounded by [`PEER_TIMEOUT`] —
/// never a broadcast; `consult = None` skips it. Each rung's outcome is
/// recorded in [`RecoveryResult::log`], which reaches the operator's blocker
/// card when the ladder ends empty.
pub async fn ask_around(
    deps: &HarnessDeps,
    company: &CompanyId,
    question: &str,
    consult: Option<PeerConsult<'_>>,
) -> RecoveryResult {
    let query = cap(question, MAX_QUERY_CHARS);
    let mut evidence = Vec::new();
    let mut log = Vec::new();

    if let Some(facts) = deps.facts.as_ref() {
        let mut queries = vec![query.clone()];
        queries.extend(focus_terms(&query));
        let mut seen_ids = std::collections::HashSet::new();
        let mut query_errors = Vec::new();
        'queries: for q in &queries {
            match facts.list(company, Some(q), None).await {
                Ok(rows) => {
                    for row in rows {
                        if evidence.len() >= MAX_RECOVERY_ITEMS {
                            break 'queries;
                        }
                        if seen_ids.insert(row.id.clone()) {
                            evidence.push(format!("fact: {} — {}", row.title, row.body));
                        }
                    }
                }
                Err(err) => query_errors.push(err.to_string()),
            }
        }
        if evidence.is_empty() && !query_errors.is_empty() {
            log.push(format!("facts: unavailable ({})", query_errors.join("; ")));
        } else {
            log.push(format!("facts: {} match(es)", evidence.len()));
        }
    } else {
        log.push("facts: unavailable".to_string());
    }

    if evidence.is_empty() {
        match deps
            .context
            .search(company, &query, MAX_RECOVERY_ITEMS)
            .await
        {
            Ok(hits) => {
                for hit in hits {
                    evidence.push(format!("workspace: {}", hit.snippet));
                }
                log.push(format!("workspace: {} match(es)", evidence.len()));
            }
            Err(err) => log.push(format!("workspace: unavailable ({err})")),
        }
    } else {
        log.push("workspace: skipped after fact match".to_string());
    }

    if evidence.is_empty() {
        match consult {
            None => log.push("peer: skipped; no consultation handle".to_string()),
            Some(consult) => match consult_peer(deps, company, &query, &consult).await {
                PeerOutcome::Answered { id, role, answer } => {
                    evidence.push(format!("peer {id} ({role}): {answer}"));
                    log.push(format!("peer: {id} answered"));
                }
                PeerOutcome::Empty { id } => log.push(format!("peer: {id} had no answer")),
                PeerOutcome::Failed { id, error } => {
                    log.push(format!("peer: {id} could not answer ({error})"));
                }
                PeerOutcome::TimedOut { id } => log.push(format!("peer: {id} timed out")),
                PeerOutcome::NoRoleMatched => {
                    log.push("peer: skipped; no role matched the question".to_string());
                }
                PeerOutcome::CeilingReached => {
                    log.push("peer: skipped; token ceiling reached".to_string());
                }
            },
        }
    } else {
        log.push("peer: skipped after local match".to_string());
    }

    let joined = cap(&evidence.join("\n"), MAX_RECOVERY_CHARS);
    RecoveryResult {
        evidence: (!joined.is_empty()).then_some(joined),
        log: log.join("; "),
    }
}

/// Caps `text` to `max` characters while keeping its last `tail` characters,
/// which is where [`compose_turn_message`](crate::workflows::caps) leaves the
/// run's own request.
fn cap_keeping_tail(text: &str, max: usize, tail: usize) -> String {
    let trimmed = text.trim();
    let total = trimmed.chars().count();
    if total <= max {
        return trimmed.to_string();
    }
    let tail = tail.min(max);
    let head = max - tail;
    let head_text: String = trimmed.chars().take(head).collect();
    let tail_text: String = trimmed.chars().skip(total - tail).collect();
    format!(
        "{head_text}\n[… {} characters elided …]\n{tail_text}",
        total - max
    )
}

fn cap(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect::<String>() + "…"
}

fn usage_from(response: &ModelResponse) -> TokenUsage {
    let tokens = response.usage.unwrap_or_default();
    let cost_usd = response
        .raw
        .as_ref()
        .and_then(|raw| raw.pointer("/openhuman_usage_meta/charged_amount_usd"))
        .and_then(serde_json::Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost > 0.0)
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
    use async_trait::async_trait;

    use super::*;

    #[test]
    fn prompt_is_assembled_from_the_verdict_and_gap_tokens() {
        let prompt = system_prompt();
        for token in SufficiencyVerdict::tokens() {
            assert!(prompt.contains(token), "missing verdict token {token}");
        }
        for gap in [
            BlockerKind::Information,
            BlockerKind::Infrastructure,
            BlockerKind::Transient,
        ] {
            assert!(prompt.contains(gap.as_str()), "missing gap token");
        }
    }

    #[test]
    fn text_outside_the_json_object_is_rejected() {
        let wrapped = "Sure, here you go: {\"verdict\":\"halt_benign\"} — hope that helps!";
        assert_eq!(parse_verdict(wrapped), None);
    }

    #[test]
    fn parses_each_closed_verdict() {
        for expected in [
            SufficiencyVerdict::Continue,
            SufficiencyVerdict::Retry,
            SufficiencyVerdict::Recover,
            SufficiencyVerdict::Escalate {
                gap: BlockerKind::Infrastructure,
            },
            SufficiencyVerdict::HaltBenign,
        ] {
            let gap = match expected {
                SufficiencyVerdict::Escalate { gap } => {
                    format!(",\"gap\":\"{}\"", gap.as_str())
                }
                _ => String::new(),
            };
            let answer = format!("{{\"verdict\":\"{}\"{gap}}}", expected.token());
            assert_eq!(parse_verdict(&answer), Some(expected));
        }
    }

    #[test]
    fn insufficient_or_failed_output_is_never_halt_benign() {
        for input in [
            JudgeInput {
                instruction: "write it",
                output: "provider failed",
                criteria: None,
                execution_failed: true,
            },
            JudgeInput {
                instruction: "write it",
                output: "   ",
                criteria: None,
                execution_failed: false,
            },
        ] {
            assert_eq!(
                enforce_anti_suppression(SufficiencyVerdict::HaltBenign, input),
                SufficiencyVerdict::Retry
            );
        }
    }

    #[test]
    fn the_run_request_survives_an_oversized_instruction() {
        let standing = "S".repeat(INSTRUCTION_CAP * 2);
        let instruction = format!("{standing}\n\nRequest for this run:\nship dark mode for iOS");
        let prompt = user_prompt(JudgeInput {
            instruction: &instruction,
            output: "done",
            criteria: None,
            execution_failed: false,
        });
        assert!(
            prompt.contains("ship dark mode for iOS"),
            "the run request must survive the instruction cap"
        );
        assert!(prompt.contains("Request for this run:"));
    }

    #[test]
    fn recovered_evidence_stays_inside_the_judge_output_window() {
        let reply = "R".repeat(OUTPUT_CAP + 5_000);
        let evidence = "the renewal date is 2026-11-04";
        let verified = augment_with_recovery(&reply, evidence);
        let prompt = user_prompt(JudgeInput {
            instruction: "draft it",
            output: &verified,
            criteria: None,
            execution_failed: false,
        });
        assert!(
            prompt.contains(evidence),
            "recovered evidence must reach the judge, not fall past the output cap"
        );
        assert!(verified.chars().count() <= OUTPUT_CAP);
    }

    #[test]
    fn recovery_augmentation_leaves_a_short_reply_whole() {
        let verified = augment_with_recovery("the draft", "a recovered fact");
        assert!(verified.starts_with("the draft"));
        assert!(verified.ends_with("a recovered fact"));
    }

    #[test]
    fn recovery_material_is_bounded_on_unicode_boundaries() {
        let text = "🧠".repeat(MAX_RECOVERY_CHARS + 1);
        let capped = cap(&text, MAX_RECOVERY_CHARS);
        assert_eq!(capped.chars().count(), MAX_RECOVERY_CHARS + 1);
        assert!(capped.ends_with('…'));
    }

    /// Codex review on #1990 (#3903591432): a whole success-criteria sentence
    /// pulls out its content words as focused single-term queries, dropping
    /// short/filler words, so a fact titled on ONE of those words is
    /// reachable even though it never contained the sentence verbatim.
    #[test]
    fn focus_terms_extracts_content_words_from_a_criteria_sentence() {
        let terms = focus_terms("The answer must include the renewal date");
        assert!(
            terms.contains(&"renewal".to_string()),
            "expected \"renewal\" among {terms:?}"
        );
        assert!(
            terms.contains(&"date".to_string()),
            "expected \"date\" among {terms:?}"
        );
        assert!(
            !terms.contains(&"the".to_string()) && !terms.contains(&"must".to_string()),
            "filler words must be dropped: {terms:?}"
        );
    }

    #[test]
    fn focus_terms_is_capped_and_deduplicated() {
        let terms =
            focus_terms("alpha alpha bravo charlie delta echo foxtrot golf hotel india juliet");
        assert!(terms.len() <= MAX_FOCUS_TERMS, "{terms:?}");
        let unique: std::collections::HashSet<_> = terms.iter().collect();
        assert_eq!(unique.len(), terms.len(), "no duplicate terms: {terms:?}");
    }

    /// A [`crate::ports::FactStore`] whose `list` only matches an EXACT query
    /// string — standing in for the real substring-match store closely enough
    /// to prove whether a whole-sentence query alone can ever reach a fact
    /// keyed on one of its content words.
    struct ExactMatchFactStore {
        matches: &'static str,
        fact: crate::ports::FactRecord,
    }

    #[async_trait::async_trait]
    impl crate::ports::FactStore for ExactMatchFactStore {
        async fn list(
            &self,
            _company: &CompanyId,
            query: Option<&str>,
            _kind: Option<crate::ports::FactKind>,
        ) -> crate::Result<Vec<crate::ports::FactRecord>> {
            Ok(match query {
                Some(q) if q == self.matches => vec![self.fact.clone()],
                _ => Vec::new(),
            })
        }

        async fn upsert(
            &self,
            _company: &CompanyId,
            _fact: &crate::ports::FactRecord,
        ) -> crate::Result<()> {
            unreachable!("not exercised by this test")
        }

        async fn delete(&self, _company: &CompanyId, _id: &str) -> crate::Result<bool> {
            unreachable!("not exercised by this test")
        }
    }

    /// Codex review on #1990 (#3903591432): the whole-sentence query used to
    /// be the ONLY query `ask_around` ever sent to the fact store. A fact
    /// titled "Renewal date" — reachable by the focused term "renewal" — was
    /// unreachable by the full sentence "The answer must include the renewal
    /// date" against a case-insensitive substring match.
    #[tokio::test]
    async fn ask_around_finds_a_fact_reachable_only_by_a_focused_term() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1990-focused-query-")
            .tempdir()
            .expect("tempdir");
        let (mut deps, _journal) =
            crate::workflows::gated_tool_turn_test::deps(String::new(), dir.path());
        deps.facts = Some(std::sync::Arc::new(ExactMatchFactStore {
            matches: "renewal",
            fact: crate::ports::FactRecord {
                id: "f1".to_string(),
                kind: crate::ports::FactKind::Fact,
                title: "Renewal date".to_string(),
                body: "The contract renews on March 1st.".to_string(),
                source: "test".to_string(),
                updated_at_millis: 0,
            },
        }));

        let result = ask_around(
            &deps,
            &CompanyId::new("acme"),
            "The answer must include the renewal date",
            None,
        )
        .await;

        let evidence = result
            .evidence
            .expect("a fact reachable only by a focused term must still be found");
        assert!(
            evidence.contains("Renewal date"),
            "expected the matched fact in the evidence: {evidence}"
        );
    }

    /// A meter that always reports enough spend to exhaust any total ceiling,
    /// regardless of `since_millis` — standing in for a company already past
    /// its plan-level token cap.
    struct ExhaustedMeter;

    #[async_trait]
    impl crate::ports::UsageMeter for ExhaustedMeter {
        async fn record(
            &self,
            _company: &CompanyId,
            _sample: &crate::ports::UsageSample,
        ) -> crate::Result<()> {
            Ok(())
        }

        async fn query(
            &self,
            _company: &CompanyId,
            _since_millis: u64,
        ) -> crate::Result<Vec<crate::ports::UsageSample>> {
            Ok(vec![crate::ports::UsageSample {
                at_millis: 0,
                agent: "ceo".to_string(),
                provider: "managed".to_string(),
                input_tokens: 10_000,
                output_tokens: 0,
                cached_input_tokens: 0,
                cost_usd: 0.0,
                kind: crate::ports::SampleKind::Inference,
                run_id: None,
                model: None,
            }])
        }
    }

    /// A provider that counts every `invoke` rather than ever answering one —
    /// the judge must never reach it once the total ceiling is spent.
    #[derive(Default)]
    struct PanicIfInvokedProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl tinyinference::model::ChatModel<()> for PanicIfInvokedProvider {
        async fn invoke(
            &self,
            _state: &(),
            _request: ModelRequest,
        ) -> tinyinference::Result<ModelResponse> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ModelResponse::assistant(
                "{\"verdict\":\"continue\"}".to_string(),
            ))
        }
    }

    impl crate::harness::provider::HarnessModel for PanicIfInvokedProvider {
        fn telemetry_provider_id(&self) -> String {
            "panic-if-invoked".to_string()
        }
    }

    /// Codex review on #1990 (#3904894255): `HarnessPool::run_inner` refuses
    /// dispatch at the plan-level total token ceiling before ever invoking the
    /// agent model, but `judge_sufficiency` called `deps.provider.invoke`
    /// unconditionally — a `verify`-declared node whose company had already
    /// exhausted its ceiling still paid for a judge turn, and because that
    /// refusal is not `execution_failed`, retries could repeat the spend.
    /// Exhausting the ceiling and asking the judge to verdict must now cost
    /// zero inference calls.
    #[tokio::test]
    async fn a_spent_total_ceiling_skips_the_judge_call_entirely() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1990-judge-ceiling-")
            .tempdir()
            .expect("tempdir");
        let (mut deps, _journal) =
            crate::workflows::gated_tool_turn_test::deps(String::new(), dir.path());
        let provider = std::sync::Arc::new(PanicIfInvokedProvider::default());
        deps.provider = provider.clone();
        deps.plan = Some(crate::harness::capability_budget::CapabilityPlan {
            period: crate::harness::capability_budget::BudgetPeriod::Daily,
            budgets: Default::default(),
            total_budget: Some(1_000),
        });
        deps.meter = Some(std::sync::Arc::new(ExhaustedMeter));

        let verdict = judge_sufficiency(
            &deps,
            &CompanyId::new("acme"),
            JudgeInput {
                instruction: "send the report",
                output: "the report has been sent",
                criteria: None,
                execution_failed: false,
            },
        )
        .await;

        assert_eq!(
            provider.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the judge must not spend inference once the total ceiling is spent"
        );
        assert_eq!(
            verdict,
            SufficiencyVerdict::Retry,
            "a budget-refused verify must not be accepted as sufficient"
        );
    }

    // ── the recovery ladder's peer rung ──────────────────────────────────────

    /// A roster built from `[[agent]]` blocks, on the fixture record so every
    /// other field keeps the shape the rest of these tests use.
    fn roster(agents: &str) -> CompanyRecord {
        let mut record = crate::workflows::gated_tool_turn_test::record();
        record.manifest =
            toml::from_str(&format!("[company]\nname = \"Acme\"\n\n{agents}\n")).expect("manifest");
        record
    }

    /// `support` is listed FIRST and scores lower than `cfo`, so a scoring
    /// regression that fell back to "the first roster entry that matches at all"
    /// is visible rather than accidentally right.
    const THREE_DESKS: &str = r#"
[[agent]]
id = "support"
role = "Support Lead"
description = "Handles renewal reminders for customers"

[[agent]]
id = "cfo"
role = "Chief Financial Officer"
description = "Owns pricing and renewal contracts"

[[agent]]
id = "designer"
role = "Brand Designer"
description = "Owns the visual identity"
"#;

    #[test]
    fn pick_peer_picks_the_role_that_shares_most_terms_with_the_question() {
        let record = roster(THREE_DESKS);
        let peer = pick_peer(
            &record,
            "The answer must include the renewal pricing",
            "researcher",
        )
        .expect("a roster role shares terms with this question");
        assert_eq!(
            peer.id, "cfo",
            "the highest-scoring role must be chosen, not the first that matches at all"
        );
    }

    #[test]
    fn pick_peer_never_picks_the_nodes_own_agent() {
        let record = roster(THREE_DESKS);
        let peer = pick_peer(
            &record,
            "The answer must include the renewal pricing",
            "cfo",
        )
        .expect("another role still matches once the node's own agent is excluded");
        assert_eq!(
            peer.id, "support",
            "the node's own agent must be excluded even when it scores highest"
        );
    }

    #[test]
    fn pick_peer_keeps_roster_order_on_a_tie() {
        let record = roster(
            r#"
[[agent]]
id = "first"
role = "Renewal Desk"

[[agent]]
id = "second"
role = "Renewal Team"
"#,
        );
        for _ in 0..8 {
            let peer = pick_peer(&record, "the renewal date", "researcher").expect("a tie matches");
            assert_eq!(
                peer.id, "first",
                "a tie must resolve to roster order, identically on every call"
            );
        }
    }

    #[test]
    fn pick_peer_returns_none_when_no_role_matches() {
        let record = roster(THREE_DESKS);
        assert!(
            pick_peer(&record, "the warehouse forklift inspection", "researcher").is_none(),
            "a question no role shares a term with must pick nobody rather than pick arbitrarily"
        );
    }

    #[test]
    fn pick_peer_ignores_retired_agents() {
        let mut record = roster(THREE_DESKS);
        record.overlay_retired_agents = vec!["cfo".to_string()];
        let peer = pick_peer(
            &record,
            "The answer must include the renewal pricing",
            "researcher",
        )
        .expect("a live role still matches");
        assert_eq!(
            peer.id, "support",
            "a retired teammate must never be consulted"
        );
    }

    /// A [`FactStore`] that records every query and matches nothing, so a test
    /// can read exactly which queries the fact rung sent.
    #[derive(Default)]
    struct RecordingFactStore {
        queries: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl crate::ports::FactStore for RecordingFactStore {
        async fn list(
            &self,
            _company: &CompanyId,
            query: Option<&str>,
            _kind: Option<crate::ports::FactKind>,
        ) -> crate::Result<Vec<crate::ports::FactRecord>> {
            self.queries
                .lock()
                .expect("queries")
                .push(query.unwrap_or_default().to_string());
            Ok(Vec::new())
        }

        async fn upsert(
            &self,
            _company: &CompanyId,
            _fact: &crate::ports::FactRecord,
        ) -> crate::Result<()> {
            unreachable!("not exercised by this test")
        }

        async fn delete(&self, _company: &CompanyId, _id: &str) -> crate::Result<bool> {
            unreachable!("not exercised by this test")
        }
    }

    /// The two rungs must read the question the same way. If the fact rung's
    /// term extraction and the peer rung's scoring vocabulary ever drift apart,
    /// a question could reach a fact the peer scoring cannot see (or the
    /// reverse) and the ladder would disagree with itself about its own
    /// subject. Both sides are asserted against the same `focus_terms` call.
    #[tokio::test]
    async fn the_fact_rung_and_the_peer_rung_read_the_question_the_same_way() {
        let question = "The answer must include the renewal pricing for the enterprise account";
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-term-parity-")
            .tempdir()
            .expect("tempdir");
        let (mut deps, _journal) =
            crate::workflows::gated_tool_turn_test::deps(String::new(), dir.path());
        let facts = std::sync::Arc::new(RecordingFactStore::default());
        deps.facts = Some(facts.clone());

        let _ = ask_around(&deps, &CompanyId::new("acme"), question, None).await;

        let sent = facts.queries.lock().expect("queries").clone();
        let terms = focus_terms(question);
        assert_eq!(
            sent.first().map(String::as_str),
            Some(question),
            "the fact rung still asks the whole sentence first"
        );
        assert_eq!(
            sent[1..],
            terms[..],
            "the fact rung's focused queries must be exactly `focus_terms`"
        );

        for term in &terms {
            let record = roster(&format!(
                "[[agent]]\nid = \"peer\"\nrole = \"Desk\"\ndescription = \"{term}\"\n"
            ));
            assert!(
                pick_peer(&record, question, "researcher").is_some(),
                "a role described by the focused term {term:?} must be reachable by the peer rung"
            );
        }
        for dropped in ["answer", "must", "include", "the", "for"] {
            let record = roster(&format!(
                "[[agent]]\nid = \"peer\"\nrole = \"Desk\"\ndescription = \"{dropped}\"\n"
            ));
            assert!(
                pick_peer(&record, question, "researcher").is_none(),
                "a word the fact rung drops must not select a peer either: {dropped:?}"
            );
        }
    }

    /// A [`RunTurn`] that answers a peer consultation with a canned reply, and
    /// counts the two dispatch seams separately so a regression that routed a
    /// consultation through `run_background_workflow` — which tags live frames
    /// with a run/node id and renders the consultation as a node — is visible.
    struct PeerStub {
        reply: &'static str,
        fail: bool,
        stall: bool,
        background_calls: std::sync::atomic::AtomicUsize,
        workflow_calls: std::sync::atomic::AtomicUsize,
    }

    impl PeerStub {
        fn answering(reply: &'static str) -> Self {
            Self {
                reply,
                fail: false,
                stall: false,
                background_calls: std::sync::atomic::AtomicUsize::new(0),
                workflow_calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn failing() -> Self {
            Self {
                fail: true,
                ..Self::answering("")
            }
        }

        fn stalling() -> Self {
            Self {
                stall: true,
                ..Self::answering("")
            }
        }

        fn background(&self) -> usize {
            self.background_calls
                .load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl RunTurn for PeerStub {
        async fn run(
            &self,
            _company: &CompanyId,
            _agent_id: &str,
            _message: &str,
            _chat: crate::runtime::delegation::ChatTarget<'_>,
        ) -> crate::Result<crate::harness::TurnOutcome> {
            unreachable!("a consultation routes through run_background")
        }

        async fn run_steered(
            &self,
            _company: &CompanyId,
            _agent_id: &str,
            _message: &str,
            _control: &crate::company::steer::SteerControl,
            _chat: crate::runtime::delegation::ChatTarget<'_>,
            _run_sink: Option<std::sync::Arc<crate::harness::run_trace::RunTraceSink>>,
        ) -> crate::Result<crate::harness::TurnOutcome> {
            unreachable!("a consultation routes through run_background")
        }

        async fn run_steered_background(
            &self,
            _company: &CompanyId,
            _agent_id: &str,
            _message: &str,
            _control: &crate::company::steer::SteerControl,
            _chat: crate::runtime::delegation::ChatTarget<'_>,
            _run_sink: Option<std::sync::Arc<crate::harness::run_trace::RunTraceSink>>,
        ) -> crate::Result<crate::harness::TurnOutcome> {
            unreachable!("a consultation routes through run_background")
        }

        async fn run_background(
            &self,
            _company: &CompanyId,
            _agent_id: &str,
            _message: &str,
            _run_sink: Option<std::sync::Arc<crate::harness::run_trace::RunTraceSink>>,
        ) -> crate::Result<crate::harness::TurnOutcome> {
            self.background_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.stall {
                tokio::time::sleep(PEER_TIMEOUT * 4).await;
            }
            if self.fail {
                return Err(crate::OpenCompanyError::Store(
                    "the peer's harness is down".to_string(),
                ));
            }
            Ok(crate::harness::TurnOutcome {
                reply: self.reply.to_string(),
                steps: Vec::new(),
                hit_iteration_cap: false,
                abnormal_stop: None,
                halted_for_spend: None,
                budget_paused: None,
            })
        }

        async fn run_background_workflow(
            &self,
            _company: &CompanyId,
            _agent_id: &str,
            _message: &str,
            _run_sink: Option<std::sync::Arc<crate::harness::run_trace::RunTraceSink>>,
            _workflow_run_id: &str,
            _node_id: &str,
        ) -> crate::Result<crate::harness::TurnOutcome> {
            self.workflow_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(crate::harness::TurnOutcome {
                reply: self.reply.to_string(),
                steps: Vec::new(),
                hit_iteration_cap: false,
                abnormal_stop: None,
                halted_for_spend: None,
                budget_paused: None,
            })
        }
    }

    /// Drives `ask_around`'s peer rung against `stub`, with no fact store and an
    /// empty workspace, so the first two rungs are guaranteed to find nothing.
    async fn ladder_with_peer(
        dir: &std::path::Path,
        stub: &PeerStub,
        record: &CompanyRecord,
        question: &str,
    ) -> RecoveryResult {
        let (deps, _journal) = crate::workflows::gated_tool_turn_test::deps(String::new(), dir);
        ask_around(
            &deps,
            &CompanyId::new("acme"),
            question,
            Some(PeerConsult {
                turn: stub,
                record,
                exclude_agent: "researcher",
                workflow_id: "wf",
            }),
        )
        .await
    }

    #[tokio::test]
    async fn a_peer_answer_lands_as_provenance_tagged_evidence() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-answer-")
            .tempdir()
            .expect("tempdir");
        let stub = PeerStub::answering("Enterprise renewals are priced at 12% uplift.");
        let record = roster(THREE_DESKS);
        let result = ladder_with_peer(
            dir.path(),
            &stub,
            &record,
            "The answer must include the renewal pricing",
        )
        .await;

        let evidence = result.evidence.expect("the peer answered");
        assert_eq!(
            evidence,
            "peer cfo (Chief Financial Officer): Enterprise renewals are priced at 12% uplift.",
            "the answer must carry its provenance into the judge's input and the blocker card"
        );
        assert!(
            result.log.contains("peer: cfo answered"),
            "the recovery log must say who answered: {}",
            result.log
        );
        assert_eq!(stub.background(), 1, "exactly one peer turn is spent");
        assert_eq!(
            stub.workflow_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a consultation is not a node and must not route through the workflow-tagged seam"
        );
    }

    #[tokio::test]
    async fn a_peer_with_no_answer_leaves_the_ladder_empty() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-empty-")
            .tempdir()
            .expect("tempdir");
        let stub = PeerStub::answering("   ");
        let record = roster(THREE_DESKS);
        let result = ladder_with_peer(
            dir.path(),
            &stub,
            &record,
            "The answer must include the renewal pricing",
        )
        .await;

        assert_eq!(result.evidence, None, "an empty reply is not evidence");
        assert!(
            result.log.contains("peer: cfo had no answer"),
            "the log must distinguish an empty answer from nobody being asked: {}",
            result.log
        );
        assert_eq!(stub.background(), 1);
    }

    #[tokio::test]
    async fn a_failed_peer_turn_leaves_the_ladder_empty() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-fail-")
            .tempdir()
            .expect("tempdir");
        let stub = PeerStub::failing();
        let record = roster(THREE_DESKS);
        let result = ladder_with_peer(
            dir.path(),
            &stub,
            &record,
            "The answer must include the renewal pricing",
        )
        .await;

        assert_eq!(result.evidence, None, "a failed turn is not evidence");
        assert!(
            result.log.contains("peer: cfo could not answer"),
            "the log must name the failure rather than report a clean miss: {}",
            result.log
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_peer_turn_that_overruns_its_bound_times_out() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-timeout-")
            .tempdir()
            .expect("tempdir");
        let stub = PeerStub::stalling();
        let record = roster(THREE_DESKS);
        let result = ladder_with_peer(
            dir.path(),
            &stub,
            &record,
            "The answer must include the renewal pricing",
        )
        .await;

        assert_eq!(result.evidence, None, "a timed-out turn is not evidence");
        assert!(
            result.log.contains("peer: cfo timed out"),
            "an unbounded peer turn is the failure this rung must not have: {}",
            result.log
        );
    }

    #[tokio::test]
    async fn a_question_no_role_matches_asks_nobody() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-nomatch-")
            .tempdir()
            .expect("tempdir");
        let stub = PeerStub::answering("should never be reached");
        let record = roster(THREE_DESKS);
        let result = ladder_with_peer(
            dir.path(),
            &stub,
            &record,
            "the warehouse forklift inspection",
        )
        .await;

        assert_eq!(result.evidence, None);
        assert_eq!(
            stub.background(),
            0,
            "no role matched, so no turn may be spent"
        );
        assert!(
            result.log.contains("peer: skipped; no role matched"),
            "{}",
            result.log
        );
    }

    #[tokio::test]
    async fn a_spent_total_ceiling_never_asks_a_peer() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-ceiling-")
            .tempdir()
            .expect("tempdir");
        let (mut deps, _journal) =
            crate::workflows::gated_tool_turn_test::deps(String::new(), dir.path());
        deps.plan = Some(crate::harness::capability_budget::CapabilityPlan {
            period: crate::harness::capability_budget::BudgetPeriod::Daily,
            budgets: Default::default(),
            total_budget: Some(1_000),
        });
        deps.meter = Some(std::sync::Arc::new(ExhaustedMeter));
        let stub = PeerStub::answering("should never be reached");
        let record = roster(THREE_DESKS);

        let result = ask_around(
            &deps,
            &CompanyId::new("acme"),
            "The answer must include the renewal pricing",
            Some(PeerConsult {
                turn: &stub,
                record: &record,
                exclude_agent: "researcher",
                workflow_id: "wf",
            }),
        )
        .await;

        assert_eq!(
            stub.background(),
            0,
            "a company past its token ceiling must not pay for a peer turn"
        );
        assert_eq!(result.evidence, None);
        assert!(
            result.log.contains("peer: skipped; token ceiling reached"),
            "{}",
            result.log
        );
    }

    #[tokio::test]
    async fn a_fact_match_never_asks_a_peer() {
        let dir = tempfile::Builder::new()
            .prefix("oc-1866-peer-last-")
            .tempdir()
            .expect("tempdir");
        let (mut deps, _journal) =
            crate::workflows::gated_tool_turn_test::deps(String::new(), dir.path());
        deps.facts = Some(std::sync::Arc::new(ExactMatchFactStore {
            matches: "renewal",
            fact: crate::ports::FactRecord {
                id: "f1".to_string(),
                kind: crate::ports::FactKind::Fact,
                title: "Renewal pricing".to_string(),
                body: "Enterprise renewals carry a 12% uplift.".to_string(),
                source: "test".to_string(),
                updated_at_millis: 0,
            },
        }));
        let stub = PeerStub::answering("should never be reached");
        let record = roster(THREE_DESKS);

        let result = ask_around(
            &deps,
            &CompanyId::new("acme"),
            "The answer must include the renewal pricing",
            Some(PeerConsult {
                turn: &stub,
                record: &record,
                exclude_agent: "researcher",
                workflow_id: "wf",
            }),
        )
        .await;

        assert_eq!(
            stub.background(),
            0,
            "the peer rung is last; a local answer must add no always-on turn cost"
        );
        assert!(
            result.log.contains("peer: skipped after local match"),
            "{}",
            result.log
        );
    }
}
