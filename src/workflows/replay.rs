//! Issue #846: a continuation must not make an outward call its own lineage
//! already made.
//!
//! # What this is a second half of
//!
//! A paused workflow run is **settled**, not suspended — the engine finishes and
//! reports the gates it stopped at — so approving is a re-run from the trigger
//! with the gate listed in `approvals`. That primitive is deliberate, it is
//! restart-durable for free, and #438 accepted it: the requirement it wrote down
//! was not "stop re-executing" but **"an approval must never cause a message to
//! be sent to a person twice."**
//!
//! #496 met that requirement for the half the host performs with its own hands:
//! an `output` node's report, routed by [`deliver_outputs`](super::delivery)
//! after the engine settles. A ledger rides the approval card, and a reached
//! output node listed in it is skipped rather than dispatched.
//!
//! It does not reach the other half. A `send`, `publish` or `repo_publish`
//! wired as a **`tool_call` node** is performed by the engine, mid-run, through
//! a capability — so there is no post-hoc dispatch for the host to decline. Put
//! such a node upstream of a gate and today the first run sends, the operator
//! approves, and the continuation sends again. Same exposure, same lineage, the
//! other mechanism.
//!
//! # The seam, and why it is this one
//!
//! [`ToolInvoker::invoke`](tinyflows::caps::ToolInvoker) receives
//! `(slug, args, conn)` — no node id, no run state — which
//! [`gate`](super::gate) already records as the reason the *approval* gate could
//! not live there. The same fact rules out a node-keyed skip inside the invoker,
//! and node identity is not negotiable here: keying on `(tool, args)` instead
//! would miss every send whose body an upstream agent node re-generates, which
//! is most of them.
//!
//! What the host does own is the **translation** — it builds the graph per run,
//! which is where [`apply_policy_gates`](super::gate::apply_policy_gates)
//! already writes per-node decisions. So a node the lineage has already called
//! is rewritten *before the run starts* to invoke a host-private sentinel slug
//! carrying its recorded result, and the invoker answers that slug from its
//! arguments without touching the toolbelt. The engine is unchanged, the graph
//! shape is unchanged, and the node still produces output — the same output,
//! because the recorded value is the verbatim capability return and
//! `envelope::wrap` is a pure function of it.
//!
//! # Which nodes, and the line drawn
//!
//! Two kinds, on two different rules, because the two have different amounts of
//! declaration behind them.
//!
//! **`http_request` with a mutating method** — anything but `GET`/`HEAD`. This
//! is the live one. An `http_request` node reaches an arbitrary address today,
//! on every company, and a `POST` upstream of a gate is a second POST on every
//! approval. Idempotency by HTTP method is the standard the method names carry,
//! and it is the only thing the host can read about a call whose destination is
//! authored per node.
//!
//! **`tool_call` whose [`consequence_of`](crate::policy::consequence_of) group
//! is an outward one** — anything but
//! [`EffectGroup::Other`](crate::ports::types::EffectGroup::Other), less
//! [`Reach::Money`](crate::policy::Reach::Money) (below). That is a reader of the
//! one declaration both policy tiers read, not a second table to keep in step
//! with it.
//!
//! ## What that second rule does and does not reach today, stated plainly
//!
//! **Nothing, today.** A workflow `tool_call` can only invoke the four families
//! [`WORKFLOW_TOOL_NAMESPACES`](super::caps) wires — shell, code, web, search —
//! and every slug in them is declared `EffectGroup::Other` except `web_search`,
//! which this rule excludes. So there is no wired slug this arm currently
//! guards, and #846's own example — "put a `send`, `publish` or `repo_publish`
//! node after two gated steps" — describes agent-turn tool families the workflow
//! invoker does not wire at all.
//!
//! That is worth stating rather than quietly implying otherwise, and it is a
//! reason to write the rule now rather than later: it is the guard that has to
//! exist *before* a send-capable namespace is wired into workflows, or wiring
//! one silently re-opens #438 on the day it lands. It costs one arm of one
//! `match`, and it is exercised by this module's tests against the declared
//! table rather than against a wired tool — which is the most that can honestly
//! be claimed for a rule whose subject does not exist yet.
//!
//! ## Two gaps this does NOT close
//!
//! * **`shell`, `curl` and `git_operations`.** All three are `EffectGroup::Other`
//!   and all three can reach a counterparty — `curl` to an address, `shell` to
//!   anything at all, `git_operations` to a remote. The host cannot tell a
//!   `git log` from a `git push`, and replaying every shell node's recorded
//!   stdout on every continuation would change the behaviour of the most common
//!   effectful node there is on the strength of a guess. Left as it is,
//!   deliberately, and filed as issue #850 rather than folded in.
//! * **`web_fetch` and `web_search`.** Read-only, so the three re-executed
//!   fetches in #846's own reproduction still re-execute — which is the issue's
//!   own reading of them: idempotent reads whose cost is latency and tokens.
//!   `web_search` is excluded by the [`Reach::Money`] carve-out rather than by
//!   its group, because it is declared `EffectGroup::Spend` for billing and is
//!   a read: it reaches nobody and changes nothing, and #438 priced repeated
//!   spend as cost rather than as the harm being guarded here. Replaying it
//!   would also hand a later run a stale answer it never asked for, which is the
//!   argument against replaying a fetch, and the two should not differ.
//!
//! # Two limits, stated rather than hidden
//!
//! * **A truncated result is never replayed.** The recorded value rides the
//!   durable approval card, so it is bounded like everything else that does
//!   ([`bound_node_output`](crate::ports::bound_node_output)). If bounding would
//!   clip it, the node is not recorded and the continuation calls again — a
//!   duplicate send is bad, and feeding downstream a silently-clipped receipt as
//!   if it were real is worse. The operator is told, via a run notice.
//! * **A per-item fan-out is not replayed.** A `split_out` → `tool_call` node
//!   invokes once per item, and the invoker sees no item index, so one recorded
//!   result cannot answer N invocations without inventing which. Recording only
//!   the single-invocation shape keeps the guard exact where it applies instead
//!   of approximate everywhere; the fan-out case behaves as it does today and
//!   says so. #496 took the same side of the same trade for a partial delivery
//!   fan-out.
//!
//! Both limits are *visible*: [`replay_performed`] returns what it could not
//! guard so the runner can surface it as a notice (issue #638's mechanism), so
//! "this continuation called out again" is something an operator reads rather
//! than something they reconstruct.
//!
//! The complete answer to all of this is checkpointed resume, and it is still
//! not available: tinyflows' `run_resumable` installs a no-op observer and a
//! process-local in-memory checkpointer and takes no cancellation token, so it
//! composes with neither the per-node progress trail (#371) nor the stop signal
//! (#398) this runner is built on, and an approval that arrives after a restart
//! would find no checkpoint. That is engine work in a vendored crate, exactly as
//! #438 recorded. This guard is forward-compatible with it: it is keyed on the
//! node and it withdraws to nothing when the ledger is empty.

use serde_json::{Value, json};
use tinyflows::model::{NodeKind, WorkflowGraph};

use crate::company::{WorkflowFile, WorkflowNodeKind};
use crate::ports::bound_node_output;

use crate::runtime::workflow_resume::{PerformedCall, performed_in_input};

/// The host-private slug a replayed node invokes instead of its real tool.
///
/// Namespaced with a `__opencompany` prefix that no toolbelt tool carries and no
/// authoring surface accepts. Even so the invoker's arm is written to be safe
/// against an author who types it anyway: it reaches no capability, executes
/// nothing and returns only what its own arguments carry, so the worst an
/// authored occurrence can do is produce an inert node — strictly less than any
/// grant would already allow.
pub(crate) const REPLAY_SLUG: &str = "__opencompany.already_performed";

/// The argument key carrying the recorded result, **JSON-encoded as a string**.
///
/// Encoded rather than embedded, and this is load-bearing. Node config is walked
/// by [`tinyflows::expr::resolve`] before the node runs, and every leaf string
/// beginning with `=` is evaluated as an expression against the run scope. A
/// recorded result is arbitrary provider data that may contain such a string, so
/// embedding it verbatim would hand a counterparty's response to the expression
/// engine. `serde_json::to_string` of any value yields a document starting with
/// `{`, `[`, `"`, a digit, `t`, `f` or `n` — never `=` — so a single encoded
/// string is inert by construction rather than by escaping rules.
pub(crate) const REPLAY_RESULT_KEY: &str = "result_json";

/// The recorded result behind a [`REPLAY_SLUG`] invocation, or `None` for every
/// other slug (issue #846).
///
/// The whole of what a tool invoker has to know about this module: one
/// comparison and one decode, so both invokers can answer the sentinel
/// identically without either growing a copy of the rules.
///
/// A sentinel invocation whose argument is missing or is not the JSON the host
/// wrote yields [`Value::Null`] rather than `None`. Falling through to the real
/// toolbelt would be the one outcome this module exists to prevent — the node
/// was rewritten precisely *because* calling out again is the bug — and no live
/// tool answers to this slug anyway, so the fall-through would fail the node
/// rather than send. A null return is a node that produced nothing, which is
/// visible in the run's own output.
pub(crate) fn replayed_result(slug: &str, args: &Value) -> Option<Value> {
    if slug != REPLAY_SLUG {
        return None;
    }
    let decoded = args
        .get(REPLAY_RESULT_KEY)
        .and_then(Value::as_str)
        .and_then(|encoded| serde_json::from_str(encoded).ok())
        .unwrap_or(Value::Null);
    tracing::info!(
        recovered = !decoded.is_null(),
        "workflow: replaying a call this run's lineage already made; not calling out again \
         (issue #846)"
    );
    Some(decoded)
}

/// A node the continuation could not replay, and why — surfaced to the operator
/// as a run notice rather than left in the host's logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnreplayableCall {
    /// The node that will call out a second time.
    pub node_id: String,
    /// The tool it will call.
    pub slug: String,
    /// Operator-facing prose for why the guard did not apply.
    pub why: &'static str,
}

impl UnreplayableCall {
    /// The sentence an operator reads, on the run that parked — before they
    /// approve, which is the only moment they can still act on it.
    pub fn notice(&self) -> String {
        format!(
            "“{}” ({}) reached outside the company on this run, and approving the gate below it \
             will call it again: {}.",
            self.node_id, self.slug, self.why
        )
    }
}

/// Every `tool_call` node in `graph` whose call left the building on this run,
/// paired with the verbatim result it returned (issue #846).
///
/// Read off the settled run's own `output["nodes"]`, which already holds every
/// completed node's items — so this costs no engine change and no second source
/// of truth. A node that did not complete has no entry and is not recorded; a
/// node the run never reached (everything past the gate) has none either, which
/// is what makes "recorded" mean "actually happened".
///
/// Returns `(performed, unreplayable)`: what a continuation may replay, and what
/// it may not, so the caller can carry the second half to the operator instead
/// of silently guarding less than it appears to.
pub(crate) fn outward_calls_performed(
    graph: &WorkflowGraph,
    output: &Value,
    authored: &WorkflowFile,
) -> (Vec<PerformedCall>, Vec<UnreplayableCall>) {
    let nodes = output.get("nodes");
    let mut performed = Vec::new();
    let mut unreplayable = Vec::new();
    let declared = declared_unrepeatable(authored);

    for node in &graph.nodes {
        let Some(slug) = outward_call_of(node, declared.contains(node.id.as_str())) else {
            continue;
        };
        // Not reached, or reached and produced nothing: there is nothing to
        // guard and nothing to replay.
        let Some(items) = nodes
            .and_then(|map| map.get(&node.id))
            .and_then(|node_output| node_output.get("items"))
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
        else {
            continue;
        };

        if items.len() > 1 {
            unreplayable.push(UnreplayableCall {
                node_id: node.id.clone(),
                slug,
                why: "it runs once per input item, and a single recorded result cannot stand in \
                      for several",
            });
            continue;
        }
        // The engine wraps a capability return as `{ json, text, raw }`, so
        // `raw` is the verbatim value — replaying it reconstructs this exact
        // envelope rather than approximating it. An item without `raw` is not a
        // capability envelope and is not something this can faithfully replay.
        let Some(raw) = items[0].get("raw") else {
            unreplayable.push(UnreplayableCall {
                node_id: node.id.clone(),
                slug,
                why: "its output is not in the engine's capability envelope, so there is no \
                      verbatim result to replay",
            });
            continue;
        };

        let (bounded, truncated) = bound_node_output(raw);
        if truncated {
            unreplayable.push(UnreplayableCall {
                node_id: node.id.clone(),
                slug,
                why: "its result is too large to carry on the approval card, and a clipped \
                      result must not be replayed as if it were whole",
            });
            continue;
        }
        performed.push(PerformedCall {
            node: node.id.clone(),
            tool: slug,
            result: bounded,
        });
    }

    (performed, unreplayable)
}

/// Rewrites every node this lineage has already called so the continuation
/// replays its recorded result instead of calling again (issue #846).
///
/// Mutates `graph` in place, beside [`apply_policy_gates`](super::gate::apply_policy_gates)
/// and before compilation, which is the one moment the host holds both the node
/// ids and the trigger input. A first run — anything with no ledger on its input
/// — leaves the graph byte-identical, so every existing run and every existing
/// test is untouched.
///
/// Returns the node ids it rewrote, for the log line and for the tests that pin
/// this: an empty return is the honest answer for a graph whose ledger names
/// nodes it does not contain (a graph edited between the pause and the
/// approval), where re-calling is the only thing left to do.
pub(crate) fn replay_performed(graph: &mut WorkflowGraph, trigger_input: &Value) -> Vec<String> {
    let ledger = performed_in_input(trigger_input);
    if ledger.is_empty() {
        return Vec::new();
    }

    let mut replayed = Vec::new();
    for node in &mut graph.nodes {
        if !matches!(node.kind, NodeKind::ToolCall | NodeKind::HttpRequest) {
            continue;
        }
        let Some(call) = ledger.iter().find(|call| call.node == node.id) else {
            continue;
        };
        let Value::Object(config) = &mut node.config else {
            continue;
        };
        let Ok(encoded) = serde_json::to_string(&call.result) else {
            // Unserializable is unreachable for a value that arrived by
            // deserialization, and re-calling is the safe direction if it ever
            // is not: a node that runs twice is the bug being fixed, a node that
            // silently returns nothing is a new one.
            continue;
        };

        // An `http_request` node becomes a `tool_call` invoking the sentinel.
        //
        // The kind change is what lets one seam serve both, and it is safe
        // because the two node kinds already agree about the only thing that
        // leaves the node: every capability node wraps its result in the same
        // `{ json, text, raw }` envelope, so a downstream `=item.json.<field>`
        // binding reads the same value either way. The alternative was a second
        // replay mechanism inside `GuardedHttpClient` — which, like the invoker,
        // sees no node id and would have needed its own identity scheme.
        node.kind = NodeKind::ToolCall;
        // The request descriptor, removed rather than left to rot. Leaving it
        // would have the engine resolve a URL and headers for a call that is
        // not made, and would leave a reader of the compiled graph unable to
        // tell a replayed node from a live one.
        for key in ["url", "method", "headers", "body"] {
            config.remove(key);
        }

        config.insert("slug".to_string(), json!(REPLAY_SLUG));
        config.insert("args".to_string(), json!({ REPLAY_RESULT_KEY: encoded }));
        // Nothing to connect to, and leaving a stale ref would have the engine
        // resolve a connection for a call that is not made.
        config.remove("connection_ref");
        // One invocation, one recorded result. A node left in `per_item` mode
        // would replay the same result once per input item; `outward_calls_performed`
        // refuses to record a fan-out for exactly that reason, and pinning the
        // mode here means a graph edited between the pause and the approval
        // cannot re-open the hole.
        config.insert("execution".to_string(), json!("once"));
        replayed.push(node.id.clone());
    }

    replayed
}

/// The node ids whose author declared `repeatable = false` (issue #850).
///
/// Read off the **authored** file rather than the compiled graph, the same way
/// [`deliver_outputs`](super::delivery::deliver_outputs) reads `destination`:
/// this is host-side policy the engine never sees, so putting it in engine
/// config would be an inert key riding into the graph.
///
/// Restricted to the two kinds that make a call, mirroring the validation that
/// rejects the field anywhere else — so a graph loaded from an older or looser
/// source cannot widen the guarded set through a kind the rewrite would not
/// touch anyway.
fn declared_unrepeatable(authored: &WorkflowFile) -> std::collections::HashSet<&str> {
    authored
        .nodes
        .iter()
        .filter(|node| {
            node.repeatable == Some(false)
                && matches!(
                    node.kind,
                    WorkflowNodeKind::ToolCall | WorkflowNodeKind::HttpRequest
                )
        })
        .map(|node| node.id.as_str())
        .collect()
}

/// The name of the outward call a node makes — or `None` when the node makes no
/// call, or makes one that reaches nobody outside the company.
///
/// The name is for the operator and the log line; the *identity* a ledger entry
/// is matched on is always the node id.
///
/// An `agent` node is deliberately absent, and it is a different question rather
/// than an oversight: its own tool calls park through #395's drain and are
/// decided one at a time, and its re-execution is the token cost #438 already
/// priced and declined to fix here.
fn outward_call_of(node: &tinyflows::model::Node, declared_unrepeatable: bool) -> Option<String> {
    match node.kind {
        NodeKind::ToolCall => {
            let slug = node.config.get("slug").and_then(Value::as_str)?;
            let args = node
                .config
                .get("args")
                .cloned()
                .unwrap_or_else(|| json!({}));
            // The author said this call must not be made twice (issue #850).
            // Read BEFORE the classifier, because the whole point is the calls
            // the classifier cannot see: `shell` runs an arbitrary command and
            // the host does not parse it, so no amount of inspection here will
            // ever reach the right answer. Only the guarding direction is taken
            // from the author — `repeatable = true` falls through to the
            // classifier below rather than overriding it, so a declaration can
            // never switch off a guard #846 already applies.
            if declared_unrepeatable {
                return Some(slug.to_string());
            }
            let consequence = crate::policy::consequence_of(slug, &args);
            // The residual bucket — "no particular consequence to name on the
            // card" — is everything that stays inside the company plus the three
            // this module's docs name as an open gap.
            if consequence.group.is_unclassified() {
                return None;
            }
            // Billed, but it reaches nobody and changes nothing. See the module
            // docs: repeated spend is cost, not the harm being guarded.
            if consequence.reach.costs_money() {
                return None;
            }
            Some(slug.to_string())
        }
        // Reaches an arbitrary address on every company today, so this is the
        // arm that guards a *live* duplicate. Read by method, which is the only
        // thing the host knows about a destination the author supplies per node
        // — and which is exactly what the method names are for.
        NodeKind::HttpRequest => {
            let method = node
                .config
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_uppercase();
            // A `GET` the author knows has a side effect — the method promises
            // to have done nothing, and an endpoint is free to break that
            // promise. Same one-way rule as the `tool_call` arm: the
            // declaration adds this node to the guarded set and can never take
            // a non-safe method out of it.
            if SAFE_METHODS.contains(&method.as_str()) && !declared_unrepeatable {
                return None;
            }
            Some(format!("http_request {method}"))
        }
        _ => None,
    }
}

/// HTTP methods a continuation may repeat: the **safe** ones, not the
/// idempotent ones.
///
/// `PUT` and `DELETE` are idempotent in the RFC's sense — the server state after
/// N identical requests equals the state after one — and that is deliberately
/// not the property being asked for. A duplicate `DELETE` still fires whatever
/// the endpoint does on receipt, and "the row is still gone" is no comfort if
/// the second request also sent someone a notification. Only `GET` and `HEAD`
/// promise to have done nothing.
const SAFE_METHODS: [&str; 2] = ["GET", "HEAD"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::run_output::RUN_OUTPUT_MAX_BYTES;
    use crate::runtime::workflow_resume::CONTINUATION_PERFORMED_KEY;
    use tinyflows::model::Node;

    use crate::company::{WorkflowEdgeDef, WorkflowNodeDef};

    /// The authored file behind a test graph: one `WorkflowNodeDef` per
    /// `(id, kind, repeatable)`, and nothing else set.
    ///
    /// Declared kinds matter — [`declared_unrepeatable`] filters on them, so a
    /// test that passed the wrong kind would assert nothing.
    fn authored(nodes: &[(&str, WorkflowNodeKind, Option<bool>)]) -> WorkflowFile {
        WorkflowFile {
            id: "wf".into(),
            name: "wf".into(),
            description: None,
            nodes: nodes
                .iter()
                .map(|(id, kind, repeatable)| WorkflowNodeDef {
                    id: (*id).to_string(),
                    kind: *kind,
                    name: String::new(),
                    summary: None,
                    agent: None,
                    schedule: None,
                    config: None,
                    on_error: None,
                    retry: None,
                    requires_approval: None,
                    repeatable: *repeatable,
                    destination: None,
                })
                .collect(),
            edges: Vec::<WorkflowEdgeDef>::new(),
            global: false,
        }
    }

    /// An authored file that declares nothing — the pre-#850 world, and the
    /// shape every test written before this issue implicitly assumed.
    fn undeclared() -> WorkflowFile {
        authored(&[])
    }

    fn node(id: &str, kind: NodeKind, config: Value) -> Node {
        Node {
            id: id.to_string(),
            kind,
            type_version: 1,
            name: String::new(),
            config,
            ports: Vec::new(),
            position: None,
        }
    }

    fn graph(nodes: Vec<Node>) -> WorkflowGraph {
        WorkflowGraph {
            id: Some("wf".to_string()),
            nodes,
            ..WorkflowGraph::default()
        }
    }

    /// A settled run's output: one completed node, one capability envelope.
    fn settled(node_id: &str, raw: Value) -> Value {
        json!({ "nodes": { node_id: { "items": [{ "json": raw, "text": null, "raw": raw }] } } })
    }

    /// A `POST` that already fired is recorded, so a continuation can replay it.
    ///
    /// The live half of issue #846: an `http_request` node reaches an arbitrary
    /// address on every company today, so this is the duplicate that is
    /// reachable now rather than the one that becomes reachable when a
    /// send-capable namespace is wired.
    #[test]
    fn a_post_that_already_fired_is_recorded() {
        let g = graph(vec![node(
            "notify",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let (performed, unreplayable) = outward_calls_performed(
            &g,
            &settled("notify", json!({ "status": 201 })),
            &undeclared(),
        );

        assert_eq!(performed.len(), 1, "{performed:?}");
        assert_eq!(performed[0].node, "notify");
        assert_eq!(performed[0].tool, "http_request POST");
        assert_eq!(performed[0].result, json!({ "status": 201 }));
        assert!(unreplayable.is_empty(), "{unreplayable:?}");
    }

    /// A `GET` is not recorded, and neither is a read-only tool.
    ///
    /// The negative control for the classification, and the issue's own reading
    /// of its reproduction: the three re-executed `web_fetch` nodes still
    /// re-execute, because repeating a read costs latency rather than reaching
    /// anybody. `web_search` is the `Reach::Money` carve-out — declared
    /// `EffectGroup::Spend` for billing, but still a read.
    #[test]
    fn reads_are_not_recorded_whatever_they_cost() {
        let g = graph(vec![
            node(
                "fetch",
                NodeKind::HttpRequest,
                json!({ "method": "GET", "url": "https://api.test/x" }),
            ),
            node(
                "implicit_get",
                NodeKind::HttpRequest,
                json!({ "url": "https://api.test/x" }),
            ),
            node(
                "page",
                NodeKind::ToolCall,
                json!({ "slug": "web_fetch", "args": { "url": "https://www.bbc.com/sport" } }),
            ),
            node(
                "search",
                NodeKind::ToolCall,
                json!({ "slug": "web_search", "args": { "query": "scores" } }),
            ),
        ]);
        let mut output = json!({ "nodes": {} });
        for id in ["fetch", "implicit_get", "page", "search"] {
            output["nodes"][id] = settled(id, json!({ "ok": true }))["nodes"][id].clone();
        }

        let (performed, unreplayable) = outward_calls_performed(&g, &output, &undeclared());
        assert!(performed.is_empty(), "{performed:?}");
        assert!(unreplayable.is_empty(), "{unreplayable:?}");
    }

    /// `shell` is NOT recorded on its own (issue #850).
    ///
    /// The load-bearing negative. `shell` runs an arbitrary command the host
    /// does not parse, so it is `EffectGroup::Other` and falls in the residual
    /// bucket — and it must stay there. Replaying it by default would stop
    /// every `shell` node that builds, lints or reads from re-running, to guard
    /// the rare one that reached a counterparty. #846 declined that trade on
    /// purpose; this test is what stops a later change making it silently.
    #[test]
    fn shell_is_not_recorded_without_a_declaration() {
        let g = graph(vec![node(
            "build",
            NodeKind::ToolCall,
            json!({ "slug": "shell", "args": { "command": "curl -X POST https://api.test/x" } }),
        )]);
        let (performed, unreplayable) = outward_calls_performed(
            &g,
            &settled("build", json!({ "stdout": "" })),
            &undeclared(),
        );
        assert!(performed.is_empty(), "{performed:?}");
        assert!(unreplayable.is_empty(), "{unreplayable:?}");
    }

    /// `repeatable = false` puts a `shell` node in the guarded set (issue #850).
    ///
    /// The whole feature: the author states what the host cannot infer, and the
    /// same recording path every classified call already travels picks it up.
    #[test]
    fn a_declared_shell_node_is_recorded() {
        let g = graph(vec![node(
            "publish",
            NodeKind::ToolCall,
            json!({ "slug": "shell", "args": { "command": "./bin/announce" } }),
        )]);
        let (performed, unreplayable) = outward_calls_performed(
            &g,
            &settled("publish", json!({ "stdout": "sent" })),
            &authored(&[("publish", WorkflowNodeKind::ToolCall, Some(false))]),
        );
        assert!(unreplayable.is_empty(), "{unreplayable:?}");
        assert_eq!(performed.len(), 1, "{performed:?}");
        assert_eq!(performed[0].node, "publish");
        assert_eq!(performed[0].tool, "shell");
    }

    /// A declaration only ever ADDS a guard.
    ///
    /// `repeatable = true` on a node the host already classifies as outward is
    /// not a way to switch #846 off. The author is not more authoritative than
    /// the consequence table about a call the table can see; the field exists
    /// for the calls it cannot.
    #[test]
    fn repeatable_true_cannot_remove_a_guard() {
        let g = graph(vec![node(
            "notify",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let (performed, _) = outward_calls_performed(
            &g,
            &settled("notify", json!({ "status": 201 })),
            &authored(&[("notify", WorkflowNodeKind::HttpRequest, Some(true))]),
        );
        assert_eq!(
            performed.len(),
            1,
            "a declared-repeatable POST is still guarded"
        );
    }

    /// A declaration on a `GET` guards it, because an endpoint is free to break
    /// the promise the method makes.
    #[test]
    fn a_declared_get_is_recorded() {
        let g = graph(vec![node(
            "trip",
            NodeKind::HttpRequest,
            json!({ "method": "GET", "url": "https://api.test/fire" }),
        )]);
        let (performed, _) = outward_calls_performed(
            &g,
            &settled("trip", json!({ "status": 200 })),
            &authored(&[("trip", WorkflowNodeKind::HttpRequest, Some(false))]),
        );
        assert_eq!(performed.len(), 1, "{performed:?}");
    }

    /// A declaration names a node id, and a stale one guards nothing.
    ///
    /// A graph edited between the pause and the approval can leave a
    /// declaration naming a node that is gone. Silently guarding the wrong node
    /// would be worse than guarding none, so the lookup is by id and misses.
    #[test]
    fn a_declaration_for_a_node_not_in_the_graph_guards_nothing() {
        let g = graph(vec![node(
            "build",
            NodeKind::ToolCall,
            json!({ "slug": "shell", "args": { "command": "make" } }),
        )]);
        let (performed, unreplayable) = outward_calls_performed(
            &g,
            &settled("build", json!({ "stdout": "" })),
            &authored(&[("gone", WorkflowNodeKind::ToolCall, Some(false))]),
        );
        assert!(performed.is_empty(), "{performed:?}");
        assert!(unreplayable.is_empty(), "{unreplayable:?}");
    }

    /// A declared node still obeys every limit `outward_calls_performed`
    /// already enforces — here, the fan-out refusal.
    ///
    /// The declaration decides *whether the node is guarded*, never *how*. A
    /// declared fan-out is still refused and surfaced, because one recorded
    /// result cannot answer N invocations whoever asked for the guard.
    #[test]
    fn a_declared_fan_out_is_still_refused() {
        let g = graph(vec![node(
            "notify_each",
            NodeKind::ToolCall,
            json!({ "slug": "shell", "args": { "command": "./bin/announce" } }),
        )]);
        let output = json!({
            "nodes": { "notify_each": { "items": [
                { "raw": { "status": 201 } },
                { "raw": { "status": 201 } }
            ] } }
        });
        let (performed, unreplayable) = outward_calls_performed(
            &g,
            &output,
            &authored(&[("notify_each", WorkflowNodeKind::ToolCall, Some(false))]),
        );
        assert!(performed.is_empty(), "{performed:?}");
        assert_eq!(unreplayable.len(), 1, "{unreplayable:?}");
        assert_eq!(unreplayable[0].node_id, "notify_each");
    }

    /// A declaration on a kind that makes no call is ignored here as well as
    /// rejected at validation.
    ///
    /// Validation is the place an author hears about it; this is the belt to
    /// that braces, so a graph loaded from an older or looser source cannot
    /// widen the guarded set through a kind the rewrite would not touch.
    #[test]
    fn a_declaration_on_a_non_calling_kind_is_ignored() {
        let file = authored(&[("report", WorkflowNodeKind::Output, Some(false))]);
        assert!(declared_unrepeatable(&file).is_empty());
    }

    /// A node the run never reached is not recorded — which is what makes
    /// "recorded" mean "actually happened" rather than "is in the graph".
    #[test]
    fn a_node_the_run_never_reached_is_not_recorded() {
        let g = graph(vec![node(
            "notify",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let (performed, unreplayable) = outward_calls_performed(
            &g,
            &json!({ "nodes": { "notify": { "items": [] } } }),
            &undeclared(),
        );
        assert!(performed.is_empty(), "{performed:?}");
        assert!(unreplayable.is_empty(), "{unreplayable:?}");
    }

    /// A per-item fan-out is NOT recorded, and says so.
    ///
    /// The invoker sees no item index, so one recorded result cannot answer N
    /// invocations without inventing which. Guarding it approximately would be
    /// worse than not guarding it, so this refuses — and surfaces a notice, so
    /// the operator learns before they approve rather than afterwards.
    #[test]
    fn a_fan_out_is_refused_and_surfaced() {
        let g = graph(vec![node(
            "notify_each",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let output = json!({
            "nodes": { "notify_each": { "items": [
                { "raw": { "status": 201 } },
                { "raw": { "status": 201 } },
            ] } }
        });

        let (performed, unreplayable) = outward_calls_performed(&g, &output, &undeclared());
        assert!(performed.is_empty(), "{performed:?}");
        assert_eq!(unreplayable.len(), 1, "{unreplayable:?}");
        assert_eq!(unreplayable[0].node_id, "notify_each");
        assert!(
            unreplayable[0].notice().contains("will call it again"),
            "the notice must say what approving does: {}",
            unreplayable[0].notice()
        );
    }

    /// A result too large for the card is NOT recorded.
    ///
    /// A duplicate send is bad; feeding a downstream node a silently-clipped
    /// receipt as though it were whole is worse, so the guard withdraws rather
    /// than degrading — and says so.
    #[test]
    fn an_oversized_result_is_refused_rather_than_clipped() {
        let g = graph(vec![node(
            "notify",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let huge = json!({ "body": "x".repeat(RUN_OUTPUT_MAX_BYTES + 1) });
        let (performed, unreplayable) =
            outward_calls_performed(&g, &settled("notify", huge), &undeclared());

        assert!(performed.is_empty(), "{performed:?}");
        assert_eq!(unreplayable.len(), 1, "{unreplayable:?}");
        assert!(
            unreplayable[0].why.contains("too large"),
            "{}",
            unreplayable[0].why
        );
    }

    /// The rewrite: a recorded node invokes the sentinel instead of its tool.
    #[test]
    fn a_recorded_node_is_rewritten_to_replay() {
        let mut g = graph(vec![
            node(
                "notify",
                NodeKind::HttpRequest,
                json!({ "method": "POST", "url": "https://api.test/hooks", "body": "hi" }),
            ),
            node(
                "page",
                NodeKind::ToolCall,
                json!({ "slug": "web_fetch", "args": { "url": "https://www.bbc.com" } }),
            ),
        ]);
        let input = json!({
            CONTINUATION_PERFORMED_KEY: [
                { "node": "notify", "tool": "http_request POST", "result": { "status": 201 } }
            ]
        });

        assert_eq!(replay_performed(&mut g, &input), vec!["notify".to_string()]);

        let notify = &g.nodes[0];
        assert_eq!(notify.kind, NodeKind::ToolCall, "the seam is the invoker's");
        assert_eq!(notify.config["slug"], json!(REPLAY_SLUG));
        assert_eq!(notify.config["execution"], json!("once"));
        // The request descriptor is gone, so nothing resolves a URL for a call
        // that is not made.
        for key in ["url", "method", "body"] {
            assert!(
                notify.config.get(key).is_none(),
                "{key} survived the rewrite"
            );
        }
        // An unrecorded node is untouched — this promotes, it never rewrites
        // what it was not told about.
        assert_eq!(g.nodes[1].config["slug"], json!("web_fetch"));
    }

    /// A first run — no ledger — leaves the graph byte-identical.
    ///
    /// The claim every existing run and every existing test depends on.
    #[test]
    fn a_first_run_rewrites_nothing() {
        let original = graph(vec![node(
            "notify",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let mut g = original.clone();

        assert!(replay_performed(&mut g, &json!({ "topic": "q3" })).is_empty());
        assert_eq!(
            serde_json::to_value(&g).unwrap(),
            serde_json::to_value(&original).unwrap(),
        );
    }

    /// The invoker answers the sentinel with the verbatim recorded value.
    #[test]
    fn the_sentinel_returns_the_recorded_result() {
        let encoded = serde_json::to_string(&json!({ "status": 201, "id": "abc" })).unwrap();
        let replayed = replayed_result(REPLAY_SLUG, &json!({ REPLAY_RESULT_KEY: encoded }));
        assert_eq!(replayed, Some(json!({ "status": 201, "id": "abc" })));

        // Every other slug is none of this module's business.
        assert_eq!(replayed_result("web_fetch", &json!({ "url": "x" })), None);
        // A sentinel with nothing to replay yields null rather than falling
        // through to the real toolbelt — falling through is the one outcome
        // this exists to prevent.
        assert_eq!(replayed_result(REPLAY_SLUG, &json!({})), Some(Value::Null));
    }

    /// A recorded result containing an `=`-prefixed string is replayed
    /// **verbatim**, not evaluated as an engine expression.
    ///
    /// This is why the result is JSON-encoded into a single string rather than
    /// embedded in the node config: `tinyflows::expr::resolve` walks a node's
    /// config before it runs and evaluates every leaf beginning with `=`, and a
    /// recorded result is arbitrary data from a counterparty. The encoding makes
    /// that inert by construction — `serde_json::to_string` never yields a
    /// document starting with `=`.
    #[test]
    fn a_recorded_expression_string_is_not_evaluated() {
        let hostile = json!({ "note": "=run.trigger.secret" });
        let mut g = graph(vec![node(
            "notify",
            NodeKind::HttpRequest,
            json!({ "method": "POST", "url": "https://api.test/hooks" }),
        )]);
        let (performed, _) =
            outward_calls_performed(&g, &settled("notify", hostile.clone()), &undeclared());
        let input = json!({ CONTINUATION_PERFORMED_KEY: performed });

        replay_performed(&mut g, &input);
        let args = &g.nodes[0].config["args"];

        // Nothing in the rewritten config is an `=`-expression: the whole
        // recorded value is one JSON string.
        let encoded = args[REPLAY_RESULT_KEY]
            .as_str()
            .expect("encoded as a string");
        assert!(!encoded.starts_with('='), "{encoded}");
        assert_eq!(replayed_result(REPLAY_SLUG, args), Some(hostile));
    }
}
