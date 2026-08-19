//! Running a company's turn on an **ACP agent** instead of the embedded
//! OpenHuman harness.
//!
//! ## What this unlocks
//!
//! [`RunTurn`] is the seam between "the company cycle" and "an agent runs a
//! turn". It had exactly one implementation, `HarnessRunTurn`, which drives an
//! in-process OpenHuman agent and therefore needs an inference credential and
//! the whole vendored runtime. A second implementation over ACP serves three
//! things at once:
//!
//! - **A desktop company with no key.** The embedded host runs a turn on the
//!   operator's own `claude-code-acp`, against their existing subscription.
//!   Nothing to configure on first run, which is a materially different product
//!   from one that opens on a credential form.
//! - **Reverse dispatch.** A cloud host hands a task to a runner on someone's
//!   machine; the runner is an ACP agent as far as this is concerned.
//! - **Any other harness.** Codex, goose, and anything else that speaks ACP.
//!
//! ## Why a port rather than an ACP client in here
//!
//! The transport differs per caller — a subprocess over stdio for the desktop,
//! a WebSocket for a runner — and neither belongs in the host crate. So this
//! defines [`AcpAgent`] as a port and folds whatever it reports; the desktop
//! shell supplies the stdio implementation, and the runner lane will supply the
//! socket one. The same inversion the storage ports use.
//!
//! ## The mapping, and where it is lossy
//!
//! ACP's `session/update` variants and OpenCompany's [`TurnStep`] were designed
//! for different things, and the join is not total:
//!
//! | `sessionUpdate` | becomes |
//! |---|---|
//! | `agent_message_chunk` | appended to the reply |
//! | `agent_thought_chunk` | one coalesced `Thinking` step |
//! | `tool_call` | a `ToolCall` step, `Running` |
//! | `tool_call_update` | that step's status and result |
//! | `plan`, `available_commands_update`, … | dropped |
//!
//! Dropped rather than approximated: a `plan` is a task board, and inventing
//! `TurnStep`s for its entries would put rows on the operator's timeline that
//! no tool call produced.

use std::sync::Arc;

use async_trait::async_trait;

use crate::Result;
use crate::harness::TurnOutcome;
use crate::ports::types::{CompanyId, TurnStep, TurnStepKind, TurnStepStatus};
use crate::runtime::delegation::RunTurn;

/// One `session/update` payload, already parsed into what this layer needs.
///
/// A narrow enum rather than raw JSON, so the wire-format knowledge stays in
/// the transport and the folding below stays testable without one.
#[derive(Clone, Debug, PartialEq)]
pub enum AcpUpdate {
    /// Assistant text. Concatenated, in arrival order, into the reply.
    MessageChunk(String),
    /// Reasoning. Coalesced into a single step — the console shows "Thinking",
    /// never the content, matching what the OpenHuman path surfaces.
    ThoughtChunk,
    /// A tool call started.
    ToolCall { id: String, title: String },
    /// A tool call progressed or finished.
    ToolCallUpdate {
        id: String,
        /// ACP's `pending` / `in_progress` / `completed` / `failed`.
        status: String,
        /// A short summary of what came back, already bounded by the transport.
        result: Option<String>,
    },
}

/// What an ACP agent reports for one turn.
#[derive(Clone, Debug, Default)]
pub struct AcpTurn {
    pub updates: Vec<AcpUpdate>,
    /// ACP's `stopReason`.
    pub stop_reason: String,
}

/// An ACP agent this host can run a turn on.
///
/// Implemented by the desktop (a subprocess over stdio) and, later, by the
/// runner lane (a socket). Deliberately says nothing about transport.
#[async_trait]
pub trait AcpAgent: Send + Sync {
    /// Runs one turn and returns everything it produced.
    ///
    /// `session_key` is stable for a (company, agent) pair so the agent can
    /// keep a conversation rather than starting fresh each turn.
    async fn prompt(
        &self,
        company: &CompanyId,
        session_key: &str,
        message: &str,
    ) -> Result<AcpTurn>;

    /// Asks the agent to stop the turn in flight.
    ///
    /// Advisory, and the caller must treat it that way: ACP's `session/cancel`
    /// is a notification, and a harness inside a long tool call notices only
    /// when that call returns.
    async fn cancel(&self, company: &CompanyId, session_key: &str) -> Result<()>;
}

/// [`RunTurn`] over an [`AcpAgent`].
pub struct AcpRunTurn {
    agent: Arc<dyn AcpAgent>,
}

impl AcpRunTurn {
    pub fn new(agent: Arc<dyn AcpAgent>) -> Self {
        Self { agent }
    }

    /// The session an agent's turns share.
    ///
    /// Per (company, agent) so two desks do not share a conversation, and
    /// stable across turns so the second question in a thread does not arrive
    /// with no memory of the first.
    fn session_key(company: &CompanyId, agent_id: &str) -> String {
        format!("{}::{agent_id}", company.as_ref())
    }

    async fn run_once(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
    ) -> Result<TurnOutcome> {
        let key = Self::session_key(company, agent_id);
        let turn = self.agent.prompt(company, &key, message).await?;
        Ok(fold(turn))
    }
}

/// Folds a turn's updates into the outcome the company cycle expects.
///
/// Separate from the trait impl so it is testable without an agent, and because
/// this — not the plumbing — is where the semantics live.
pub fn fold(turn: AcpTurn) -> TurnOutcome {
    let mut reply = String::new();
    let mut steps: Vec<TurnStep> = Vec::new();
    // Where each tool call's step landed, so a later update finds it. A tool
    // call that never completes keeps the `Running` status it was created with,
    // which is exactly what that status means.
    let mut positions: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut thinking = false;

    for update in turn.updates {
        match update {
            AcpUpdate::MessageChunk(text) => reply.push_str(&text),
            AcpUpdate::ThoughtChunk => {
                // One step for a run of thoughts, not one per chunk: a model
                // emits these by the hundred, and a timeline of them is noise.
                if !thinking {
                    thinking = true;
                    steps.push(TurnStep {
                        kind: TurnStepKind::Thinking,
                        status: TurnStepStatus::Ok,
                        label: "Thinking".to_string(),
                        ..TurnStep::default()
                    });
                }
            }
            AcpUpdate::ToolCall { id, title } => {
                thinking = false;
                positions.insert(id, steps.len());
                steps.push(TurnStep {
                    kind: TurnStepKind::ToolCall,
                    status: TurnStepStatus::Running,
                    label: title,
                    ..TurnStep::default()
                });
            }
            AcpUpdate::ToolCallUpdate { id, status, result } => {
                thinking = false;
                let Some(&index) = positions.get(&id) else {
                    // An update for a call we never saw start. Dropped rather
                    // than synthesised: a step with no label is worse on a
                    // timeline than no step.
                    continue;
                };
                let step = &mut steps[index];
                step.status = match status.as_str() {
                    "completed" => TurnStepStatus::Ok,
                    "failed" => TurnStepStatus::Error,
                    // `pending` and `in_progress` both mean "not done".
                    _ => TurnStepStatus::Running,
                };
                if result.is_some() {
                    step.result = result;
                }
            }
        }
    }

    TurnOutcome {
        reply,
        steps,
        // Issue #926: an ACP turn runs behind an external agent process, whose
        // protocol carries no iteration-cap signal — there is nothing to read,
        // and inventing `true` here would label every ACP reply a pause.
        hit_iteration_cap: false,
        // Issue #1032: nor is there a spend halt to report. The stop hooks are
        // installed around THIS crate's `agent.turn`, and an ACP turn does not
        // run through it — the external process bills and stops on its own
        // terms, which this side neither arms nor observes.
        halted_for_spend: None,
    }
}

#[async_trait]
impl RunTurn for AcpRunTurn {
    async fn run(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
        _chat_id: Option<&str>,
    ) -> Result<TurnOutcome> {
        self.run_once(company, agent_id, message).await
    }

    async fn run_steered(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
        control: &crate::company::steer::SteerControl,
        _chat_id: Option<&str>,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<TurnOutcome> {
        self.steered(company, agent_id, message, control).await
    }

    async fn run_steered_background(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
        control: &crate::company::steer::SteerControl,
        _run_sink: Option<Arc<crate::harness::run_trace::RunTraceSink>>,
    ) -> Result<TurnOutcome> {
        self.steered(company, agent_id, message, control).await
    }
}

impl AcpRunTurn {
    /// A turn that can be cancelled while it runs.
    ///
    /// The turn and the steer check race each other. A cancel forwards
    /// `session/cancel` and then **keeps waiting** rather than abandoning the
    /// turn: ACP cancellation is cooperative, the agent still answers with
    /// `stopReason: "cancelled"`, and dropping the future here would leave a
    /// harness mid-tool-call with nothing reading its output.
    async fn steered(
        &self,
        company: &CompanyId,
        agent_id: &str,
        message: &str,
        control: &crate::company::steer::SteerControl,
    ) -> Result<TurnOutcome> {
        let key = Self::session_key(company, agent_id);
        let turn = self.agent.prompt(company, &key, message);
        tokio::pin!(turn);

        loop {
            tokio::select! {
                outcome = &mut turn => return Ok(fold(outcome?)),
                () = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                    // `pending`, not `take`: the disposition site after the turn
                    // reads the action to decide what happens to the card, and
                    // consuming it here would leave it with nothing to read.
                    if control.pending().is_some() {
                        // Advisory. Told, then waited for — see above.
                        let _ = self.agent.cancel(company, &key).await;
                        let outcome = (&mut turn).await?;
                        return Ok(fold(outcome));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn turn(updates: Vec<AcpUpdate>) -> AcpTurn {
        AcpTurn {
            updates,
            stop_reason: "end_turn".to_string(),
        }
    }

    #[test]
    fn message_chunks_concatenate_in_order() {
        // ACP streams a reply in pieces; the outcome carries one string.
        let outcome = fold(turn(vec![
            AcpUpdate::MessageChunk("Hello".into()),
            AcpUpdate::MessageChunk(", ".into()),
            AcpUpdate::MessageChunk("world".into()),
        ]));
        assert_eq!(outcome.reply, "Hello, world");
        assert!(outcome.steps.is_empty(), "text alone produces no steps");
    }

    #[test]
    fn a_run_of_thoughts_becomes_one_step() {
        // A model emits these by the hundred. One step per chunk would bury the
        // tool calls an operator is actually reading the timeline for.
        let outcome = fold(turn(vec![
            AcpUpdate::ThoughtChunk,
            AcpUpdate::ThoughtChunk,
            AcpUpdate::ThoughtChunk,
        ]));
        assert_eq!(outcome.steps.len(), 1);
        assert_eq!(outcome.steps[0].kind, TurnStepKind::Thinking);
        assert_eq!(outcome.steps[0].label, "Thinking");
    }

    #[test]
    fn thinking_resumes_as_a_new_step_after_a_tool_call() {
        // Two separate bouts of reasoning either side of a call are two steps —
        // coalescing them would put the thinking in the wrong order relative to
        // the work it bracketed.
        let outcome = fold(turn(vec![
            AcpUpdate::ThoughtChunk,
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "Read".into(),
            },
            AcpUpdate::ThoughtChunk,
        ]));
        let kinds: Vec<_> = outcome.steps.iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![
                TurnStepKind::Thinking,
                TurnStepKind::ToolCall,
                TurnStepKind::Thinking
            ]
        );
    }

    #[test]
    fn a_tool_call_takes_its_final_status_and_result() {
        let outcome = fold(turn(vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "Read a file".into(),
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "completed".into(),
                result: Some("2.4 kB".into()),
            },
        ]));
        assert_eq!(outcome.steps.len(), 1, "the update amends, never appends");
        assert_eq!(outcome.steps[0].label, "Read a file");
        assert_eq!(outcome.steps[0].status, TurnStepStatus::Ok);
        assert_eq!(outcome.steps[0].result.as_deref(), Some("2.4 kB"));
    }

    #[test]
    fn a_failed_tool_call_is_an_error_step() {
        let outcome = fold(turn(vec![
            AcpUpdate::ToolCall {
                id: "t1".into(),
                title: "Write".into(),
            },
            AcpUpdate::ToolCallUpdate {
                id: "t1".into(),
                status: "failed".into(),
                result: Some("permission denied".into()),
            },
        ]));
        assert_eq!(outcome.steps[0].status, TurnStepStatus::Error);
        assert!(outcome.steps[0].status.is_failure());
    }

    #[test]
    fn a_tool_call_that_never_completes_stays_running() {
        // Exactly what `Running` means: started, no completion seen by the end
        // of the turn. Marking it `Ok` would report work that never finished as
        // having succeeded.
        let outcome = fold(turn(vec![AcpUpdate::ToolCall {
            id: "t1".into(),
            title: "Long thing".into(),
        }]));
        assert_eq!(outcome.steps[0].status, TurnStepStatus::Running);
    }

    #[test]
    fn several_tool_calls_are_amended_independently() {
        // Interleaved calls are ordinary — an agent starts two and they finish
        // out of order. Each update has to find its own step.
        let outcome = fold(turn(vec![
            AcpUpdate::ToolCall {
                id: "a".into(),
                title: "First".into(),
            },
            AcpUpdate::ToolCall {
                id: "b".into(),
                title: "Second".into(),
            },
            AcpUpdate::ToolCallUpdate {
                id: "b".into(),
                status: "completed".into(),
                result: None,
            },
            AcpUpdate::ToolCallUpdate {
                id: "a".into(),
                status: "failed".into(),
                result: None,
            },
        ]));
        assert_eq!(outcome.steps.len(), 2);
        assert_eq!(outcome.steps[0].label, "First");
        assert_eq!(outcome.steps[0].status, TurnStepStatus::Error);
        assert_eq!(outcome.steps[1].label, "Second");
        assert_eq!(outcome.steps[1].status, TurnStepStatus::Ok);
    }

    #[test]
    fn an_update_for_an_unknown_call_is_dropped_rather_than_invented() {
        // A step with no label is worse on a timeline than no step at all.
        let outcome = fold(turn(vec![AcpUpdate::ToolCallUpdate {
            id: "ghost".into(),
            status: "completed".into(),
            result: Some("x".into()),
        }]));
        assert!(outcome.steps.is_empty());
    }

    /// An agent that answers from a script, so the trait impl can be driven.
    struct Scripted {
        turn: AcpTurn,
        cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait]
    impl AcpAgent for Scripted {
        async fn prompt(&self, _c: &CompanyId, _k: &str, _m: &str) -> Result<AcpTurn> {
            Ok(self.turn.clone())
        }
        async fn cancel(&self, _c: &CompanyId, _k: &str) -> Result<()> {
            self.cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    /// The claim the whole slice rests on: this is usable anywhere the
    /// OpenHuman implementation is.
    ///
    /// Driven through `&dyn RunTurn` rather than through the concrete type,
    /// because that is how the company cycle holds it (`DelegationRunner` takes
    /// `&'a dyn RunTurn`). A type that satisfied the trait but was not
    /// object-safe would compile here and fail at the one site that matters.
    #[tokio::test]
    async fn it_is_usable_through_the_run_turn_seam() {
        let agent = Arc::new(Scripted {
            turn: AcpTurn {
                updates: vec![
                    AcpUpdate::ThoughtChunk,
                    AcpUpdate::ToolCall {
                        id: "t1".into(),
                        title: "Read".into(),
                    },
                    AcpUpdate::ToolCallUpdate {
                        id: "t1".into(),
                        status: "completed".into(),
                        result: Some("4 items".into()),
                    },
                    AcpUpdate::MessageChunk("all done".into()),
                ],
                stop_reason: "end_turn".into(),
            },
            cancelled: Default::default(),
        });
        let run_turn: &dyn RunTurn = &AcpRunTurn::new(agent);

        let outcome = run_turn
            .run(&CompanyId::new("acme"), "ceo", "go", None)
            .await
            .expect("a turn runs");

        assert_eq!(outcome.reply, "all done");
        assert_eq!(outcome.steps.len(), 2);
        assert_eq!(outcome.steps[1].status, TurnStepStatus::Ok);
        assert_eq!(outcome.steps[1].result.as_deref(), Some("4 items"));
    }

    #[tokio::test]
    async fn a_steered_turn_still_returns_an_outcome() {
        // Cancellation in ACP is cooperative: the agent still answers, with
        // `stopReason: "cancelled"`. Abandoning the future on a steer would
        // leave a harness mid-tool-call with nothing reading its output, so the
        // contract is that a steered turn still produces an outcome.
        let agent = Arc::new(Scripted {
            turn: AcpTurn {
                updates: vec![AcpUpdate::MessageChunk("partial".into())],
                stop_reason: "cancelled".into(),
            },
            cancelled: Default::default(),
        });
        let run_turn: &dyn RunTurn = &AcpRunTurn::new(agent);
        let control = crate::company::steer::SteerControl::new();
        control.request(crate::company::steer::SteerAction::Cancel);

        let outcome = run_turn
            .run_steered(&CompanyId::new("acme"), "ceo", "go", &control, None, None)
            .await
            .expect("a steered turn still answers");
        assert_eq!(outcome.reply, "partial");
        // The pending action survives for the disposition site to read, which
        // is what decides where the card lands.
        assert!(
            control.pending().is_some(),
            "the steer must not be consumed here"
        );
    }

    #[test]
    fn a_session_key_separates_agents_and_companies() {
        // Two desks sharing a session would share a conversation, and one
        // company's turn would carry another's context.
        let acme = CompanyId::new("acme");
        let globex = CompanyId::new("globex");
        assert_ne!(
            AcpRunTurn::session_key(&acme, "ceo"),
            AcpRunTurn::session_key(&acme, "cto")
        );
        assert_ne!(
            AcpRunTurn::session_key(&acme, "ceo"),
            AcpRunTurn::session_key(&globex, "ceo")
        );
        // Stable across turns, or the second question in a thread arrives with
        // no memory of the first.
        assert_eq!(
            AcpRunTurn::session_key(&acme, "ceo"),
            AcpRunTurn::session_key(&acme, "ceo")
        );
    }
}
