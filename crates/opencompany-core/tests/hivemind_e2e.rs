#![cfg(feature = "openhuman")]
//! **End-to-end proof that a hive-mind desk actually deliberates.**
//!
//! The unit tests in [`hivemind`](opencompany::hivemind) drive the episode
//! driver with a `HiveTurnRunner` that returns strings. They pin the fold, and
//! they cannot tell you whether a *company* deliberates: whether the brain hook
//! fires on an operator message, whether each authorized turn goes through the
//! ordinary harness turn path with its tools and its memory loop, whether the
//! transcript a member is handed is the one the prompt builder promised, or
//! whether the journal ends up holding one row per turn plus one honest closing
//! report.
//!
//! So this boots a **real company** — `RuntimeBuilder`, the embedded OpenHuman
//! harness, the filesystem store, the HTTP surface, loopback magic-link
//! sign-in — and drives it through `POST /api/v1/company/chat`, the same route
//! the console posts to. Only the model is scripted, and the scripted endpoint
//! is **content-aware**: it reads the prompt each agent was handed, works out
//! who is speaking and what that agent can see, and answers accordingly. A
//! member that cites `^N` has to find `N` in the transcript it was given, which
//! is exactly the property a fixed reply queue cannot prove.
//!
//! # What each test proves
//!
//! | Test | Claim |
//! | --- | --- |
//! | `a_desk_deliberates_and_converges_through_the_fold` | three members, one turn each per model call, one `AgentReply` per turn under the right author, one `hive-report` naming the topic and its supporters |
//! | `the_opening_round_is_blind_and_every_later_line_is_attributed` | the first round shows no peer marker line; later rounds render peers as `[seq] <id>: …` and never as the viewer's own words |
//! | `an_objection_silences_an_advocate_and_a_second_topic_carries` | cross-inhibition end to end: the objected author is not among the winning topic's supporters |
//! | `a_desk_reasons_with_what_it_stored_in_an_earlier_episode` | a `memory_store` tool call in episode one is readable by `memory_recall` in episode two, and the room's line cites it |
//! | `a_desk_reasons_with_memory_held_in_a_remote_engine` | the same claim with the memory ports bound to a CortexDB mock: the write lands on `/v1/experience`, the read comes back from `/v1/recall` |
//! | `a_room_that_settles_on_nothing_reports_itself_exhausted` | the budget is spent and the report says so |
//! | `two_carrying_topics_and_no_objection_deadlock` | `Deadlocked`, named honestly |
//! | `a_single_member_desk_answers_with_one_ordinary_turn` | the same company's desk of one is untouched: one reply, no `hive-report` |
//!
//! # Why no shell
//!
//! Every scripted move is a marker line or a memory tool call. Nothing on this
//! path asks for `shell`, so nothing parks for approval and no test depends on
//! an approval policy that would make it hang.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::Query;
use axum::routing::{get, post};
use serde_json::{Value, json};

use opencompany::CompanyRuntime;
use opencompany::company::CompanyManifest;
use opencompany::hivemind::{HIVE_REFERRAL_AUTHOR, HIVE_REPORT_AUTHOR};
use opencompany::ports::types::{CompanyEvent, EventSeq};
use opencompany::runtime::{RuntimeBuilder, company_id_from_name};
use opencompany::{AppConfig, AppState};

// ---------------------------------------------------------------------------
// The content-aware scripted model
// ---------------------------------------------------------------------------

/// One request as the script sees it: who is speaking, what they were shown,
/// and what the turn loop has already handed back.
#[derive(Clone, Debug)]
struct Ask {
    /// The teammate this turn belongs to, read out of the prompt's own
    /// `You are @<id>` opening. `None` for a request that is not a hive turn.
    speaker: Option<String>,
    /// The episode prompt this turn was handed, verbatim.
    prompt: String,
    /// Every `tool` message already in this conversation, oldest first.
    tool_outputs: Vec<String>,
    /// The tool result this request is the continuation of, when it is one.
    pending_tool: Option<String>,
    /// The whole message array, for assertions that need the roles.
    messages: Vec<Value>,
}

impl Ask {
    fn read(body: &Value) -> Self {
        let messages: Vec<Value> = body
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // The hive prompt is a user message. The memory loop may prepend a
        // "## Relevant prior work" preamble to it, so it is found by content
        // rather than by position.
        let prompt = messages
            .iter()
            .rev()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .map(hive_core)
            .find(|content| content.contains(TRANSCRIPT_HEADING))
            .unwrap_or_default();
        let speaker = prompt
            .split_once("You are @")
            .and_then(|(_, rest)| rest.split_once(','))
            .map(|(id, _)| id.trim().to_owned());
        let tool_outputs = messages
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        // The result this request is a continuation OF, as opposed to every
        // tool result still sitting in the agent's conversation. The pool keeps
        // one live agent per teammate for the whole company's lifetime, so a
        // second episode's opening request already carries the first episode's
        // tool messages; "has this turn called a tool yet" has to be read off
        // the tail, not off the pile.
        let pending_tool = messages
            .last()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
            .and_then(|message| message.get("content").and_then(Value::as_str))
            .map(str::to_owned);
        Self {
            speaker,
            prompt,
            tool_outputs,
            pending_tool,
            messages,
        }
    }

    /// Who is speaking, or `"?"` — used only to key a script.
    fn who(&self) -> &str {
        self.speaker.as_deref().unwrap_or("?")
    }

    fn last_user_text(&self) -> &str {
        self.messages
            .iter()
            .rev()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|message| message.get("content").and_then(Value::as_str))
            .unwrap_or_default()
    }

    /// What the operator actually asked, which is what identifies the episode.
    ///
    /// Read from the prompt's own `The operator asked the desk:` block rather
    /// than by searching the whole prompt: the transcript window carries every
    /// earlier operator message on the desk too, so "contains" matches the
    /// *previous* episode's question as readily as this one's.
    fn task(&self) -> String {
        self.prompt
            .split_once("The operator asked the desk:\n")
            .and_then(|(_, rest)| rest.split_once('\n'))
            .map_or_else(String::new, |(task, _)| task.trim().to_owned())
    }

    /// Whether this turn is under the blind projection.
    fn blind(&self) -> bool {
        self.prompt
            .contains("You cannot yet see your peers' positions")
    }

    /// The attributed transcript this turn was handed, as
    /// `(sequence, author, content)`.
    fn transcript(&self) -> Vec<(u64, String, String)> {
        let Some((_, block)) = self.prompt.split_once(TRANSCRIPT_HEADING) else {
            return Vec::new();
        };
        let block = block.split(YOUR_LINE).next().unwrap_or(block);
        block.lines().filter_map(parse_transcript_line).collect()
    }

    /// The sequence of the first transcript line whose text contains `needle`,
    /// which is how a scripted member grounds a citation: it has to read the
    /// number out of what it was shown.
    fn seq_of(&self, needle: &str) -> Option<u64> {
        self.transcript()
            .into_iter()
            .find(|(_, _, content)| content.contains(needle))
            .map(|(seq, _, _)| seq)
    }

    /// The sequence of the first line `author` wrote containing `needle`.
    fn seq_by(&self, author: &str, needle: &str) -> Option<u64> {
        self.transcript()
            .into_iter()
            .find(|(_, who, content)| who == author && content.contains(needle))
            .map(|(seq, _, _)| seq)
    }

    /// Whether this speaker has already said something containing `needle`.
    fn i_said(&self, needle: &str) -> bool {
        let me = self.who().to_owned();
        self.transcript()
            .into_iter()
            .any(|(_, who, content)| who == me && content.contains(needle))
    }
}

/// The heading the prompt builder puts above the attributed transcript.
const TRANSCRIPT_HEADING: &str = "Shared attributed transcript:\n";
/// The closing line of every episode prompt.
const YOUR_LINE: &str = "\n\nYour one line:";
/// The block a member's own previous line is rendered under.
const ALREADY_SAID: &str = "You already said this";

/// The episode prompt inside one user message.
///
/// The memory loop prepends a `## Relevant prior work` preamble to every turn's
/// message, and the outcomes it retrieves are previous turns — whole prompts
/// included. So the episode prompt is what follows the LAST `## Task` heading;
/// reading from the front of the message finds a *quoted* prompt belonging to
/// somebody else's turn, which is a different agent and a staler transcript.
fn hive_core(content: &str) -> String {
    content
        .rsplit_once("\n## Task\n")
        .map_or(content, |(_, task)| task)
        .to_owned()
}

/// `[7] planner: !propose #stage …` → `(7, "planner", "!propose #stage …")`.
fn parse_transcript_line(line: &str) -> Option<(u64, String, String)> {
    let rest = line.strip_prefix('[')?;
    let (seq, rest) = rest.split_once("] ")?;
    let (author, content) = rest.split_once(": ")?;
    // The reader's own rows are attributed `<id> (you)` so a member can tell
    // its own turns from a colleague's without losing the id colleagues cite
    // it by. The id is what every assertion here matches on, so the marker is
    // stripped back off.
    let author = author.strip_suffix(" (you)").unwrap_or(author);
    Some((
        seq.parse().ok()?,
        author.to_owned(),
        content.trim().to_owned(),
    ))
}

/// What the scripted model does with one request.
#[derive(Clone, Debug)]
enum Reply {
    /// Finish the turn with this assistant text.
    Say(String),
    /// Emit a native `tool_calls` entry with these literal arguments.
    Call { tool: &'static str, args: Value },
}

/// Anything that can answer a request from what it can see in it.
type Responder = Arc<dyn Fn(&Ask) -> Reply + Send + Sync>;

/// A scripted OpenAI-compatible endpoint, served on loopback.
///
/// `/embeddings` is served alongside `/chat/completions` for the same reason
/// `offline_e2e` serves it: the host's embeddings client shares the `base_url`,
/// and a 404 there reads as an inference failure and is not one.
struct Script {
    responder: Responder,
    /// Every request body the harness sent, in order.
    seen: Mutex<Vec<Value>>,
}

impl Script {
    fn bodies(&self) -> Vec<Value> {
        self.seen.lock().expect("script poisoned").clone()
    }

    /// Every request that OPENED a hive turn: its last message is the episode
    /// prompt itself, so a tool round trip inside one turn is not counted twice.
    fn turn_openers(&self) -> Vec<Ask> {
        self.bodies()
            .iter()
            .filter(|body| {
                body.get("messages")
                    .and_then(Value::as_array)
                    .and_then(|messages| messages.last())
                    .is_some_and(|last| {
                        last.get("role").and_then(Value::as_str) == Some("user")
                            && last
                                .get("content")
                                .and_then(Value::as_str)
                                .is_some_and(|content| {
                                    hive_core(content).contains(TRANSCRIPT_HEADING)
                                })
                    })
            })
            .map(Ask::read)
            .collect()
    }

    /// Every request that carried a hive prompt at all, opener or follow-up.
    fn hive_asks(&self) -> Vec<Ask> {
        self.bodies()
            .iter()
            .map(Ask::read)
            .filter(|ask| ask.speaker.is_some())
            .collect()
    }
}

async fn spawn_script(responder: Responder) -> (String, Arc<Script>) {
    let script = Arc::new(Script {
        responder,
        seen: Mutex::new(Vec::new()),
    });
    let chat = Arc::clone(&script);
    let app = axum::Router::new()
        .route(
            "/chat/completions",
            post(move |Json(body): Json<Value>| {
                let script = Arc::clone(&chat);
                async move {
                    script
                        .seen
                        .lock()
                        .expect("script poisoned")
                        .push(body.clone());
                    let ask = Ask::read(&body);
                    let message = match (script.responder)(&ask) {
                        Reply::Say(text) => json!({ "role": "assistant", "content": text }),
                        Reply::Call { tool, args } => json!({
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": format!("call-{tool}"),
                                "type": "function",
                                "function": { "name": tool, "arguments": args.to_string() }
                            }]
                        }),
                    };
                    Json(json!({
                        "choices": [{ "index": 0, "message": message, "finish_reason": "stop" }],
                        "usage": { "prompt_tokens": 12, "completion_tokens": 4 }
                    }))
                }
            }),
        )
        .route(
            "/embeddings",
            post(|Json(_body): Json<Value>| async move {
                Json(json!({
                    "data": [{ "index": 0, "embedding": vec![0.0_f32; 1536] }],
                    "usage": { "prompt_tokens": 1, "total_tokens": 1 }
                }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), script)
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

/// The three-member desk every deliberation test runs on.
const DESK: &str = "lab";
/// The one-member desk that proves the single-responder path is untouched.
const SOLO_DESK: &str = "front";
const THEORIST: &str = "theorist";
const PROGRAMMER: &str = "programmer";
const VERIFIER: &str = "verifier";
const ADMIN: &str = "operator@opencompany.local";

/// A company with one deliberating desk of three and one desk of one.
///
/// `[policy] mode = "full"` so no turn parks: this file is about the room, not
/// the approval gate, and a parked turn would hang the episode rather than fail
/// it. `[tools] allow` is empty on purpose — the memory belt is wired
/// unconditionally by `build_agent`, and nothing else is needed, so no scripted
/// move can reach `shell`.
fn manifest(base_url: &str, hive: &str) -> String {
    format!(
        r#"
[company]
name = "Hive Lab"
summary = "Proves a desk deliberates."

[inference]
provider = "ollama"
base_url = "{base_url}"

[inference.models]
chat-v1 = "llama3"

[policy]
mode = "full"

[tools]
allow = []

[users]
admins = ["{ADMIN}"]

[[agent]]
id = "ceo"
role = "Chief Executive"
tier = "orchestrator"

[[agent]]
id = "{THEORIST}"
role = "Theorist"

[[agent]]
id = "{PROGRAMMER}"
role = "Programmer"

[[agent]]
id = "{VERIFIER}"
role = "Verifier"

[[agent]]
id = "greeter"
role = "Front desk"

[[group_chat]]
id = "{DESK}"
name = "Lab"
description = "Settle hard questions together"
members = ["{THEORIST}", "{PROGRAMMER}", "{VERIFIER}"]
hive = {hive}

[[group_chat]]
id = "{SOLO_DESK}"
name = "Front"
members = ["greeter"]
"#
    )
}

/// Boots the company on loopback and returns its address and live runtime.
async fn boot(
    home: &std::path::Path,
    base_url: &str,
    hive: &str,
    memory: Option<opencompany::store::MemoryOverlay>,
) -> (SocketAddr, Arc<CompanyRuntime>) {
    let mut manifest = CompanyManifest::from_stored_toml(&manifest(base_url, hive))
        .expect("the in-test manifest parses");
    manifest.apply_globals();
    let problems = manifest.validate();
    assert!(
        problems.is_empty(),
        "the in-test manifest is valid: {problems:?}"
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let company_id = company_id_from_name(&manifest.company.name);
    let state = AppState::new(AppConfig {
        bind: address.to_string(),
        ..AppConfig::default()
    })
    .with_home(home.to_path_buf());
    let mut builder = RuntimeBuilder::new(state.home().to_path_buf(), manifest)
        .with_id(company_id.clone())
        .with_harness(Arc::new(opencompany::harness::HarnessPool::new()));
    if let Some(overlay) = memory {
        builder = builder.with_memory_overlay(&overlay);
    }
    let runtime = Arc::new(builder.build().await.expect("the company builds"));
    state
        .registry()
        .insert(company_id.clone(), Arc::clone(&runtime));
    tokio::spawn(async move {
        let _ = opencompany::server::serve_on(listener, state).await;
    });
    (address, runtime)
}

// ---------------------------------------------------------------------------
// The operator
// ---------------------------------------------------------------------------

/// A cookie-carrying HTTP client — `reqwest`'s own cookie store is behind a
/// feature this crate does not enable.
struct Client {
    inner: reqwest::Client,
    base: String,
    cookie: Mutex<Option<String>>,
}

impl Client {
    fn new(address: SocketAddr) -> Self {
        Self {
            inner: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .unwrap(),
            base: format!("http://{address}"),
            cookie: Mutex::new(None),
        }
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let mut request = self.inner.post(format!("{}{path}", self.base)).json(&body);
        if let Some(cookie) = self.cookie.lock().unwrap().clone() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request.send().await.expect("the loopback host answers");
        let status = response.status().as_u16();
        if let Some(set) = response.headers().get(reqwest::header::SET_COOKIE)
            && let Ok(value) = set.to_str()
            && let Some((pair, _)) = value.split_once(';')
        {
            *self.cookie.lock().unwrap() = Some(pair.to_string());
        }
        let text = response.text().await.unwrap_or_default();
        let json = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (status, json)
    }

    /// Signs in over the loopback magic-link flow, which echoes the code.
    async fn sign_in(&self) {
        let (status, body) = self
            .post("/api/v1/company/auth/request", json!({ "email": ADMIN }))
            .await;
        assert_eq!(status, 200, "sign-in refused: {body}");
        let code = body["dev_code"]
            .as_str()
            .unwrap_or_else(|| panic!("no dev_code, so no session: {body}"))
            .to_string();
        let (status, body) = self
            .post("/api/v1/company/auth/verify", json!({ "code": code }))
            .await;
        assert_eq!(status, 200, "the login code was refused: {body}");
    }

    /// Posts one operator message to `desk` and waits for the turn to finish.
    async fn say(&self, desk: &str, text: &str) -> Value {
        let (status, body) = self
            .post(
                "/api/v1/company/chat",
                json!({ "text": text, "chat": desk }),
            )
            .await;
        assert_eq!(status, 200, "chat refused: {body}");
        body
    }
}

// ---------------------------------------------------------------------------
// Reading the journal back
// ---------------------------------------------------------------------------

/// Every `AgentReply` on `chat`, as `(seq, author, text)` in journal order.
async fn replies(runtime: &Arc<CompanyRuntime>, chat: &str) -> Vec<(u64, String, String)> {
    let rows = runtime
        .events()
        .read_from(runtime.id(), EventSeq::new(0), 10_000)
        .await
        .expect("the journal reads back");
    rows.into_iter()
        .filter_map(|stored| match stored.event {
            CompanyEvent::AgentReply {
                chat_id,
                agent_id,
                text,
                ..
            } if chat_id == chat => Some((stored.seq.value(), agent_id, text)),
            _ => None,
        })
        .collect()
}

/// The episode's own turns: every desk reply authored by a seated member.
fn turns(rows: &[(u64, String, String)]) -> Vec<(String, String)> {
    rows.iter()
        .filter(|(_, author, _)| [THEORIST, PROGRAMMER, VERIFIER].contains(&author.as_str()))
        .map(|(_, author, text)| (author.clone(), text.clone()))
        .collect()
}

/// The closing `hive-report` rows, in order.
fn reports(rows: &[(u64, String, String)]) -> Vec<String> {
    rows.iter()
        .filter(|(_, author, _)| author == HIVE_REPORT_AUTHOR)
        .map(|(_, _, text)| text.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// 1 + 2: deliberation converges through the fold, and attribution holds
// ---------------------------------------------------------------------------

/// The topic the room settles on in the convergence tests.
const TOPIC: &str = "answer42";

/// The convergence script.
///
/// It is a state machine over what each speaker can *see*, not a queue: the
/// theorist opens an option, and a peer backs it only once it can read the
/// proposal's sequence number out of the transcript it was handed. A queue
/// would pass whatever the prompt said; this cannot.
fn converging_script() -> Responder {
    Arc::new(|ask: &Ask| {
        let propose = format!("!propose #{TOPIC} The closed form of the recurrence is 42.");
        // A citation is only available once the proposal is visible. In the
        // blind round it is not, which is exactly what the blind round means.
        let grounds = ask.seq_of(&format!("!propose #{TOPIC}"));
        let line = match (ask.who(), grounds) {
            (THEORIST, None) => propose,
            (who, None) => {
                format!("!question {who} needs the opening position before it can back anything.")
            }
            (who, Some(seq)) if ask.prompt.contains("The room has reached quorum") => {
                format!("!commit #{TOPIC} ^{seq} {who} records the room's decision.")
            }
            (THEORIST, Some(seq)) => format!(
                "!evidence #{TOPIC} ^{seq} theorist checked base cases 1..5 and the recurrence \
                 closes at 42 for each."
            ),
            (who, Some(seq)) if !ask.i_said("!support") => {
                format!("!support #{TOPIC} ^{seq} {who} checked the derivation and it holds.")
            }
            (who, Some(_)) => {
                format!("!question {who} has nothing further until somebody else moves.")
            }
        };
        Reply::Say(line)
    })
}

/// A desk of three that must all back a topic with grounds before it carries.
const UNANIMOUS: &str = "{ enabled = true, turn_budget = 12, quorum = 3, blind_round = true }";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_agent_uses_speech_to_coordinate_multiple_dm_sessions_without_cards() {
    let script: Responder = Arc::new(|ask: &Ask| {
        let user = ask.last_user_text();
        if user.contains("Coordinate the launch") {
            return match ask.tool_outputs.len() {
                0 => Reply::Call {
                    tool: "desk_dm",
                    args: json!({
                        "to": [THEORIST],
                        "message": "Check the launch argument and reply here."
                    }),
                },
                1 => Reply::Call {
                    tool: "desk_dm",
                    args: json!({
                        "to": [PROGRAMMER],
                        "message": "Check the launch implementation and reply here."
                    }),
                },
                2 => Reply::Call {
                    tool: "desk_post",
                    args: json!({ "message": "I asked both specialists." }),
                },
                _ => Reply::Say("done".to_string()),
            };
        }
        if user.contains("Check the launch argument")
            || user.contains("Check the launch implementation")
        {
            if ask.pending_tool.is_some() {
                return Reply::Say("done".to_string());
            }
            return Reply::Call {
                tool: "desk_post",
                args: json!({ "message": "Checked and ready." }),
            };
        }
        if ask.pending_tool.is_some() {
            return Reply::Say("done".to_string());
        }
        Reply::Call {
            tool: "desk_post",
            args: json!({ "message": "Acknowledged." }),
        }
    });
    let (base_url, _script) = spawn_script(script).await;
    let home = tempfile::tempdir().unwrap();
    let (address, runtime) = boot(home.path(), &base_url, UNANIMOUS, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    let response = client.say(SOLO_DESK, "Coordinate the launch").await;
    assert!(response["responses"].is_array(), "{response}");

    for recipient in [THEORIST, PROGRAMMER] {
        let conversation = opencompany::hivemind::referral::pair_conversation("greeter", recipient);
        let dm = replies(&runtime, &conversation).await;
        assert!(
            dm.iter().any(|(_, author, _)| author == "greeter"),
            "the outbound DM must be in the private {conversation} transcript: {dm:?}"
        );
        assert!(
            dm.iter()
                .any(|(_, author, text)| author == recipient && text == "Checked and ready."),
            "the recipient's tool-call reply must return to the same DM: {dm:?}"
        );
    }
    let cards = runtime.tasks().list(runtime.id()).await.unwrap();
    assert!(
        cards.is_empty(),
        "conversation alone must create no task: {cards:?}"
    );

    // The same greeter now handles its private chat as a second conversation;
    // its per-agent session remains one continuous cross-channel session.
    let _ = client
        .say("dm:greeter", "What did the specialists say?")
        .await;
    let rows = runtime
        .events()
        .read_from(runtime.id(), EventSeq::new(0), 10_000)
        .await
        .unwrap();
    let greeter_chats = rows
        .iter()
        .filter_map(|row| match &row.event {
            CompanyEvent::AgentReply {
                agent_id, chat_id, ..
            } if agent_id == "greeter" => Some(chat_id.as_str()),
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    assert!(greeter_chats.contains(SOLO_DESK), "{greeter_chats:?}");
    assert!(greeter_chats.contains("dm:greeter"), "{greeter_chats:?}");
}

/// **Deliberation converges through the fold.**
///
/// One operator message, three teammates, and an outcome the room can name.
#[tokio::test]
async fn a_desk_deliberates_and_converges_through_the_fold() {
    let home = tempfile::tempdir().unwrap();
    let (base_url, script) = spawn_script(converging_script()).await;
    let (address, runtime) = boot(home.path(), &base_url, UNANIMOUS, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    let body = client
        .say(DESK, "Settle the closed form of the recurrence.")
        .await;

    let rows = replies(&runtime, DESK).await;
    let turns = turns(&rows);
    assert!(
        turns.len() >= 3,
        "a room of three takes at least one turn each: {rows:?}"
    );
    // Every deliberation row is authored by the teammate that took the turn,
    // and carries the ONE line the room counts — never a paragraph.
    for (author, text) in &turns {
        assert!(
            [THEORIST, PROGRAMMER, VERIFIER].contains(&author.as_str()),
            "{rows:?}"
        );
        assert!(text.starts_with('!'), "not a marker line: {text}");
        assert!(!text.contains('\n'), "more than one line: {text}");
    }

    // One closing row, under the reserved author, naming the topic and every
    // member whose grounded support carried it.
    let reports = reports(&rows);
    assert_eq!(reports.len(), 1, "exactly one closing row: {rows:?}");
    let report = &reports[0];
    assert!(report.contains(&format!("#{TOPIC}")), "{report}");
    assert!(report.contains("settled"), "{report}");
    // The decision itself, not only the label the room filed it under: the
    // report leads with what `!propose` actually said, so an operator reading
    // it learns the answer without going back to the transcript for it.
    assert!(
        report.contains("The closed form of the recurrence is 42."),
        "the report names the label but not the decision: {report}"
    );
    for member in [THEORIST, PROGRAMMER, VERIFIER] {
        assert!(
            report.contains(member),
            "the room needed all three to carry #{TOPIC}, so all three are named: {report}"
        );
    }

    // The chat POST's own response — what a synchronous chat-API caller and
    // `emit_cycle_webhooks` both read — must carry the hive answer too. Before
    // this, a hive desk journaled everything directly and pushed nothing into
    // `CycleReport.responses`, so a synchronous caller saw an empty body and
    // `emit_cycle_webhooks` never fired `work.completed`, even though the desk
    // had just answered at length.
    let responses = body["responses"]
        .as_array()
        .expect("the chat POST returns a responses array");
    assert_eq!(
        responses.len(),
        1,
        "the hive answer must reach the response body: {body}"
    );
    assert_eq!(
        responses[0]["text"].as_str(),
        Some(report.as_str()),
        "the response carries the same closing report the journal holds: {body}"
    );

    // And it must not be a SECOND journal write: the response's durable id
    // has to be the exact sequence the episode's own closing report was
    // already journaled under, not a fresh one minted by the generic
    // journal-on-return path every other chat reply goes through.
    let report_seq = rows
        .iter()
        .find(|(_, author, _)| author == HIVE_REPORT_AUTHOR)
        .map(|(seq, _, _)| *seq)
        .expect("the episode journals its own closing report");
    let message_id: u64 = responses[0]["messageId"]
        .as_str()
        .expect("the response carries its durable id")
        .parse()
        .expect("the durable id is a sequence number");
    assert_eq!(
        message_id, report_seq,
        "the response must carry the report's own sequence, not journal it a second time \
         under a different one: {body}"
    );

    // No single-responder bubble: the desk's only authored rows are the
    // episode's own turns and its report. In particular the orchestrator never
    // answered on top of the room. Any author that is neither the report nor
    // a seated member is a stray, whoever it is — narrowing this to only
    // `ceo`/`greeter` would let a regression that journals under some OTHER
    // non-member identity slip past silently.
    let strays: Vec<_> = rows
        .iter()
        .filter(|(_, author, _)| {
            author != HIVE_REPORT_AUTHOR
                && ![THEORIST, PROGRAMMER, VERIFIER].contains(&author.as_str())
        })
        .collect();
    assert!(
        strays.is_empty(),
        "a second responder answered too: {strays:?}"
    );

    // One model call per turn, and the calls are the turns: the speakers the
    // endpoint was asked for are exactly the authors the journal recorded, in
    // order.
    let openers = script.turn_openers();
    let asked: Vec<String> = openers.iter().map(|ask| ask.who().to_owned()).collect();
    let journaled: Vec<String> = turns.iter().map(|(author, _)| author.clone()).collect();
    assert_eq!(
        asked, journaled,
        "one model call per journaled turn, in the same order"
    );
    assert_eq!(
        script.hive_asks().len(),
        openers.len(),
        "no hive turn needed a second model call: nothing on this path uses a tool"
    );
}

/// **Attribution and the blind round.**
///
/// Asserted from the captured request bodies, which is the only place the
/// claim actually lives: the journal cannot tell you what a member was *shown*.
#[tokio::test]
async fn the_opening_round_is_blind_and_every_later_line_is_attributed() {
    let home = tempfile::tempdir().unwrap();
    let (base_url, script) = spawn_script(converging_script()).await;
    let (address, _runtime) = boot(home.path(), &base_url, UNANIMOUS, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client
        .say(DESK, "Settle the closed form of the recurrence.")
        .await;

    let openers = script.turn_openers();
    assert!(
        openers.len() >= 4,
        "a blind round plus at least one open turn"
    );

    let blind: Vec<&Ask> = openers.iter().filter(|ask| ask.blind()).collect();
    assert_eq!(
        blind.len(),
        3,
        "the opening round is one blind turn per member"
    );
    for ask in &blind {
        let me = ask.who().to_owned();
        let peers: Vec<_> = ask
            .transcript()
            .into_iter()
            .filter(|(_, author, _)| {
                author != &me && [THEORIST, PROGRAMMER, VERIFIER].contains(&author.as_str())
            })
            .collect();
        assert!(
            peers.is_empty(),
            "a peer's position leaked into a blind turn for @{me}: {peers:?}"
        );
        // And not through any other door either. The turn's WHOLE request is
        // checked, not just the episode prompt: the memory loop prepends a
        // "## Relevant prior work" preamble to every turn's message, and a
        // stored outcome carries the storing turn's own prompt and reply. A
        // peer's opening position arriving that way would defeat the blind
        // round without ever appearing in the transcript block.
        let whole = ask
            .messages
            .iter()
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        for peer in [THEORIST, PROGRAMMER, VERIFIER] {
            if peer == me {
                continue;
            }
            assert!(
                !whole.contains(&format!("!question {peer}")),
                "@{peer}'s line reached blind turn @{me} outside the transcript"
            );
        }
        if me != THEORIST {
            assert!(
                !whole.contains(&format!("!propose #{TOPIC}")),
                "the theorist's opening position reached blind turn @{me}"
            );
        }
    }

    // Later turns see the room, attributed by id, with the sequence that makes
    // the line citable.
    let seeing: Vec<&Ask> = openers.iter().filter(|ask| !ask.blind()).collect();
    assert!(
        !seeing.is_empty(),
        "the blind round is not the whole episode"
    );
    let mut saw_attributed_peer = false;
    let mut saw_own_line = false;
    for ask in &seeing {
        let me = ask.who().to_owned();
        for (seq, author, content) in ask.transcript() {
            if author == me || !["theorist", "programmer", "verifier"].contains(&author.as_str()) {
                continue;
            }
            saw_attributed_peer = true;
            // Rendered exactly as `[seq] <peer id>: …`.
            assert!(
                ask.prompt.contains(&format!("[{seq}] {author}: {content}")),
                "a peer's line is not attributed the way the citation grammar needs: {content}"
            );
            // And never presented as this viewer's own words — not in the
            // assistant role, and not under the "you already said this" block.
            for message in &ask.messages {
                if message.get("role").and_then(Value::as_str) == Some("assistant")
                    && let Some(text) = message.get("content").and_then(Value::as_str)
                {
                    assert!(
                        !text.contains(&content),
                        "@{me} was handed @{author}'s line as its own assistant turn: {text}"
                    );
                }
            }
            if let Some((_, own)) = ask.prompt.split_once(ALREADY_SAID) {
                let own = own.split(TRANSCRIPT_HEADING).next().unwrap_or(own);
                assert!(
                    !own.contains(&content),
                    "@{author}'s line was rendered to @{me} as something @{me} had said"
                );
            }
        }
        // A member that has spoken is shown its own last line, so it does not
        // restate it.
        if let Some((_, mine)) = ask
            .transcript()
            .into_iter()
            .rev()
            .find_map(|(_, a, c)| (a == me).then_some((a, c)))
        {
            saw_own_line = true;
            let block = ask
                .prompt
                .split_once(ALREADY_SAID)
                .map(|(_, rest)| {
                    rest.split(TRANSCRIPT_HEADING)
                        .next()
                        .unwrap_or(rest)
                        .to_owned()
                })
                .unwrap_or_default();
            assert!(
                block.contains(&mine),
                "@{me} was not shown its own last line: {block}"
            );
        }
    }
    assert!(saw_attributed_peer, "no open turn ever saw a peer");
    assert!(saw_own_line, "no open turn was shown its own previous line");
}

// ---------------------------------------------------------------------------
// 3: cross-inhibition
// ---------------------------------------------------------------------------

const WRONG: &str = "wrongpath";
const RIGHT: &str = "rightpath";

/// A desk that reaches a decision on two grounded supporters and sees the whole
/// room from the first turn.
///
/// The blind round is off here on purpose: cross-inhibition needs a member to
/// back a *specific message* before another member can object to it, and a
/// blind opening round is exactly the window in which no such message is
/// visible. The blind round has its own test.
const OPEN_PAIR: &str = "{ enabled = true, turn_budget = 12, quorum = 2, blind_round = false }";

/// **Cross-inhibition, end to end.**
///
/// The theorist opens the wrong option, the programmer backs it — which is
/// enough to carry it — the verifier objects to the programmer's *message*, and
/// the option the room finally records is the other one, with the objected
/// author nowhere in its supporters.
#[tokio::test]
async fn an_objection_silences_an_advocate_and_a_second_topic_carries() {
    let home = tempfile::tempdir().unwrap();
    let responder: Responder = Arc::new(|ask: &Ask| {
        let wrong = ask.seq_of(&format!("!propose #{WRONG}"));
        let backing = ask.seq_by(PROGRAMMER, &format!("!support #{WRONG}"));
        let right = ask.seq_of(&format!("!propose #{RIGHT}"));
        let line = match ask.who() {
            // Opens the wrong option, then — once it has been objected to —
            // opens the one the room actually records.
            THEORIST => match (wrong, right) {
                (None, _) => format!("!propose #{WRONG} Brute-force every case at run time."),
                (Some(_), None) if backing.is_some() && ask.i_said("!propose") => {
                    format!("!propose #{RIGHT} Precompute the table once and look it up.")
                }
                (Some(seq), None) => format!(
                    "!evidence #{WRONG} ^{seq} theorist has nothing new while the floor is open."
                ),
                (_, Some(seq)) => {
                    format!("!commit #{RIGHT} ^{seq} theorist records the option that carried.")
                }
            },
            // Backs the wrong option once, and never backs anything again —
            // its support is what the objection takes away.
            PROGRAMMER => match wrong {
                Some(seq) if !ask.i_said("!support") => format!(
                    "!support #{WRONG} ^{seq} programmer measured it and brute force is fine."
                ),
                _ => "!question programmer is standing aside until the objection is settled."
                    .to_owned(),
            },
            // Objects to the programmer's backing message, then backs the
            // option that replaces it.
            VERIFIER => match (backing, wrong, right) {
                (Some(at), Some(seq), _) if !ask.i_said("!object") => format!(
                    "!object >{at} ^{seq} verifier ran it at n=10^6 and brute force times out."
                ),
                (_, _, Some(seq)) if !ask.i_said("!support") => format!(
                    "!support #{RIGHT} ^{seq} verifier checked the precomputed table against the \
                     brute force for n<=10^4."
                ),
                (_, _, Some(seq)) => {
                    format!("!commit #{RIGHT} ^{seq} verifier records the option that carried.")
                }
                _ => "!question verifier is waiting for a position to weigh.".to_owned(),
            },
            _ => "!question nothing to add.".to_owned(),
        };
        Reply::Say(line)
    });
    let (base_url, _script) = spawn_script(responder).await;
    let (address, runtime) = boot(home.path(), &base_url, OPEN_PAIR, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client
        .say(DESK, "Pick the approach for the table lookup.")
        .await;

    let rows = replies(&runtime, DESK).await;
    let turns = turns(&rows);
    // The objection is really in the transcript, naming a message rather than a
    // person — that is what makes it cross-inhibition and not a downvote.
    let objection = turns
        .iter()
        .find(|(_, text)| text.starts_with("!object"))
        .unwrap_or_else(|| panic!("nobody objected: {rows:?}"));
    assert_eq!(objection.0, VERIFIER);
    assert!(
        objection.1.contains(" >"),
        "an objection names a message: {objection:?}"
    );

    let reports = reports(&rows);
    assert_eq!(reports.len(), 1, "{rows:?}");
    let report = &reports[0];
    assert!(
        report.contains(&format!("#{RIGHT}")),
        "the room recorded the wrong topic: {report}"
    );
    assert!(
        !report.contains(&format!("#{WRONG}")),
        "the objected-to option still carried: {report}"
    );
    // The whole claim: the author whose backing was objected to is not counted
    // among the supporters of what finally carried.
    assert!(
        !report.contains(PROGRAMMER),
        "the silenced advocate is still named as a supporter: {report}"
    );
    assert!(report.contains(VERIFIER), "{report}");
}

// ---------------------------------------------------------------------------
// 5: terminal outcomes are honest
// ---------------------------------------------------------------------------

/// **A room that settles on nothing says so.**
#[tokio::test]
async fn a_room_that_settles_on_nothing_reports_itself_exhausted() {
    let home = tempfile::tempdir().unwrap();
    let responder: Responder = Arc::new(|ask: &Ask| {
        Reply::Say(format!(
            "!question {} cannot answer this without the benchmark nobody has run.",
            ask.who()
        ))
    });
    let (base_url, _script) = spawn_script(responder).await;
    let hive = "{ enabled = true, turn_budget = 3, quorum = 2, blind_round = true }";
    let (address, runtime) = boot(home.path(), &base_url, hive, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client.say(DESK, "Which sort should we ship?").await;

    let rows = replies(&runtime, DESK).await;
    assert_eq!(
        turns(&rows).len(),
        3,
        "the budget is the bound and nothing else is: {rows:?}"
    );
    let reports = reports(&rows);
    assert_eq!(reports.len(), 1, "{rows:?}");
    assert_eq!(
        reports[0], "The desk spent its 3-turn budget without reaching a decision.",
        "the report says what happened rather than inventing a decision"
    );
}

const ALPHA: &str = "alpha";
const BETA: &str = "beta";

/// **Two carrying topics and nobody to break the tie is a deadlock.**
///
/// Every member ends up backing one of the two, so there is no free dissenter
/// left — which is the library's own condition for calling it terminal rather
/// than giving the floor to whoever could still settle it.
#[tokio::test]
async fn two_carrying_topics_and_no_objection_deadlock() {
    let home = tempfile::tempdir().unwrap();
    let responder: Responder = Arc::new(|ask: &Ask| {
        let alpha = ask.seq_of(&format!("!propose #{ALPHA}"));
        let beta = ask.seq_of(&format!("!propose #{BETA}"));
        let line = match (ask.who(), alpha, beta) {
            // Each opens its own option in the blind round, then crosses over:
            // the theorist backs the programmer's, and everybody else backs the
            // theorist's. Nobody objects to anything.
            (THEORIST, None, _) => format!("!propose #{ALPHA} Ship the streaming rewrite."),
            (PROGRAMMER, _, None) => format!("!propose #{BETA} Ship the batch rewrite."),
            (THEORIST, _, Some(seq)) if !ask.i_said("!support") => {
                format!("!support #{BETA} ^{seq} theorist agrees batch is defensible too.")
            }
            (who, Some(seq), _) if who != THEORIST && !ask.i_said("!support") => {
                format!("!support #{ALPHA} ^{seq} {who} agrees streaming is defensible too.")
            }
            (who, _, _) => format!("!question {who} has nothing further; the room is split."),
        };
        Reply::Say(line)
    });
    let (base_url, _script) = spawn_script(responder).await;
    let hive = "{ enabled = true, turn_budget = 12, quorum = 2, blind_round = true }";
    let (address, runtime) = boot(home.path(), &base_url, hive, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client.say(DESK, "Streaming or batch?").await;

    let rows = replies(&runtime, DESK).await;
    let reports = reports(&rows);
    assert_eq!(reports.len(), 1, "{rows:?}");
    let report = &reports[0];
    assert!(report.contains("deadlocked"), "{report}");
    assert!(report.contains(&format!("#{ALPHA}")), "{report}");
    assert!(report.contains(&format!("#{BETA}")), "{report}");
    assert!(
        report.contains("nobody was left to break the tie"),
        "a deadlock is reported as a deadlock, not as a decision: {report}"
    );
    // And escalated rather than merely stated. `Deadlocked` is returned only
    // when every member has taken a side, so the room cannot break this itself
    // and cannot even pick who to ask — one side would be choosing its own
    // referee. That leaves the operator, and the report has to say so.
    assert!(
        report.contains("It needs your call"),
        "a deadlock the room cannot break is put to the operator: {report}"
    );
}

// ---------------------------------------------------------------------------
// 6: a desk of one is untouched
// ---------------------------------------------------------------------------

/// **A one-member desk answers exactly as it did before.**
#[tokio::test]
async fn a_single_member_desk_answers_with_one_ordinary_turn() {
    let home = tempfile::tempdir().unwrap();
    let responder: Responder = Arc::new(|ask: &Ask| {
        assert!(
            ask.speaker.is_none(),
            "a desk of one must never be handed an episode prompt: {}",
            ask.prompt
        );
        Reply::Say("Noted — the front desk has it.".to_owned())
    });
    let (base_url, _script) = spawn_script(responder).await;
    let (address, runtime) = boot(home.path(), &base_url, UNANIMOUS, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client
        .say(SOLO_DESK, "Anything waiting at the front?")
        .await;

    let rows = replies(&runtime, SOLO_DESK).await;
    let authored: Vec<_> = rows
        .iter()
        .filter(|(_, author, _)| author == "greeter")
        .collect();
    assert_eq!(
        authored.len(),
        1,
        "a desk of one answers with one ordinary turn: {rows:?}"
    );
    assert!(
        reports(&rows).is_empty(),
        "no room opened, so no room reported: {rows:?}"
    );
}

// ---------------------------------------------------------------------------
// 4: the room reasons with memory
// ---------------------------------------------------------------------------

/// What one episode deliberately remembers.
const FACT: &str =
    "The lab's small-case table for this recurrence is n=1 -> 1, n=2 -> 3, n=3 -> 7.";
/// The half of it a later episode has to actually use.
const FACT_KEY: &str = "n=3 -> 7";
/// The operator's first message: the episode that stores.
const ASK_ONE: &str = "Establish the small-case table for the recurrence.";
/// The operator's second message: the episode that has to remember.
const ASK_TWO: &str = "What does the small-case table give for n=3?";

/// Two short episodes: the first stores a fact with `memory_store`, the second
/// asks for it back with `memory_recall` and cites what it got.
///
/// Every turn of episode one stores, and every turn of episode two recalls, so
/// the claim does not depend on which member the library hands the floor to.
fn remembering_script() -> Responder {
    Arc::new(|ask: &Ask| {
        let grounds = ask.transcript().first().map_or(1, |(seq, _, _)| *seq);
        if ask.task() == ASK_ONE {
            if ask.pending_tool.is_none() {
                return Reply::Call {
                    tool: "memory_store",
                    args: json!({ "title": "small-case table", "body": FACT }),
                };
            }
            return Reply::Say(format!(
                "!propose #table ^{grounds} Work the small cases out once and write them down."
            ));
        }
        if ask.task() == ASK_TWO {
            if ask.pending_tool.is_none() {
                return Reply::Call {
                    tool: "memory_recall",
                    args: json!({ "query": "small-case table for the recurrence" }),
                };
            }
            // Cite what memory actually handed back, not a constant: if the
            // recall came back empty this line cannot be written.
            let recalled = ask
                .pending_tool
                .as_deref()
                .filter(|output| output.contains(FACT_KEY))
                .map_or_else(
                    || "nothing came back from memory".to_owned(),
                    |_| FACT_KEY.to_owned(),
                );
            return Reply::Say(format!(
                "!evidence #table ^{grounds} From the desk's own memory: {recalled}."
            ));
        }
        Reply::Say(format!("!question {} has nothing to add.", ask.who()))
    })
}

/// Short episodes, so two of them fit inside one test without a long run.
const SHORT: &str = "{ enabled = true, turn_budget = 3, quorum = 2, blind_round = true }";

/// Every tool result the endpoint was shown for the episode answering `task`.
fn tool_results_for(script: &Script, task: &str) -> Vec<String> {
    script
        .hive_asks()
        .into_iter()
        .filter(|ask| ask.task() == task)
        .flat_map(|ask| ask.tool_outputs)
        .collect()
}

/// **Agents reason with memory.**
///
/// The default `store` engine: what `memory_store` wrote in episode one is what
/// `memory_recall` reads in episode two, and the line the room journals is
/// written from what came back.
#[tokio::test]
async fn a_desk_reasons_with_what_it_stored_in_an_earlier_episode() {
    let home = tempfile::tempdir().unwrap();
    let (base_url, script) = spawn_script(remembering_script()).await;
    let (address, runtime) = boot(home.path(), &base_url, SHORT, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client.say(DESK, ASK_ONE).await;
    client.say(DESK, ASK_TWO).await;

    // Episode one really wrote: the tool's own success echo came back into the
    // turn, which only happens once the chunk is in the store.
    let stored = tool_results_for(&script, ASK_ONE);
    assert!(
        stored.iter().any(|result| result.contains("Remembered as")),
        "no memory_store result reached a turn in episode one: {stored:?}"
    );

    // Episode two really read it back.
    let recalled = tool_results_for(&script, ASK_TWO);
    assert!(
        recalled.iter().any(|result| result.contains(FACT_KEY)),
        "memory_recall did not serve the fact episode one stored: {recalled:?}"
    );

    // The retrieve→inject half of the loop ran around these turns too: every
    // deliberating turn carries the preamble, above the episode prompt.
    //
    // What it is NOT asserted to contain is the fact above. The loop's query is
    // the whole incoming message — here, a multi-kilobyte episode prompt — and
    // `store::lexical` ranks candidates by term rarity against it, so which
    // memories surface is the ranker's business and it does not reliably pick
    // this one out. That is why the deliberate `memory_recall` above is the
    // load-bearing assertion: it is the path an agent controls.
    let injected = script.bodies().iter().any(|body| {
        body.get("messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages.iter().any(|message| {
                    message
                        .get("content")
                        .and_then(Value::as_str)
                        .is_some_and(|content| content.contains("## Relevant prior work"))
                })
            })
            .unwrap_or(false)
    });
    assert!(
        injected,
        "no deliberating turn ran through the retrieve→inject memory loop"
    );

    // And the room's own line used it. This is the part a store-level test
    // cannot reach: the fact has to survive the tool, the turn, `marker_line`
    // and the journal to end up here.
    let rows = replies(&runtime, DESK).await;
    let used: Vec<_> = turns(&rows)
        .into_iter()
        .filter(|(_, text)| text.contains(FACT_KEY))
        .collect();
    assert!(
        !used.is_empty(),
        "no journaled line cites what the desk remembered: {rows:?}"
    );
    assert!(used[0].1.starts_with("!evidence"), "{used:?}");
}

// ---------------------------------------------------------------------------
// 4b: the same claim, with memory held in a remote engine
// ---------------------------------------------------------------------------

/// What the CortexDB mock was asked to do, so the test can say *when*.
#[derive(Default)]
struct CortexMock {
    writes: AtomicUsize,
    reads: AtomicUsize,
    events: Mutex<Vec<Value>>,
}

/// A CortexDB instance, in process, speaking the wire shapes the driver relies
/// on — the same shapes `src/store/memory/cortexdb_test.rs` pins.
async fn spawn_cortexdb() -> (String, Arc<CortexMock>) {
    /// The credential the driver is configured with. Not a JWT, so the actor
    /// falls back to the driver's documented default.
    const TOKEN: &str = "cortex-test-token";
    /// `type:id`, which is the only shape CortexDB accepts.
    const ACTOR: &str = "service:opencompany";

    let state = Arc::new(CortexMock::default());
    let authorized = |headers: &axum::http::HeaderMap| {
        let bearer = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let actor = headers
            .get("x-cortex-actor")
            .and_then(|value| value.to_str().ok());
        bearer == Some(TOKEN) && actor == Some(ACTOR)
    };

    let write_state = Arc::clone(&state);
    let read_state = Arc::clone(&state);
    let events_state = Arc::clone(&state);
    let scopes_state = Arc::clone(&state);
    let app = axum::Router::new()
        .route(
            "/v1/admin/ready",
            get(move |headers: axum::http::HeaderMap| async move {
                if authorized(&headers) {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .route(
            "/v1/experience",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let state = Arc::clone(&write_state);
                    async move {
                        assert!(
                            authorized(&headers),
                            "the driver must carry both the bearer and the actor"
                        );
                        let id = format!("evt_{}", state.writes.fetch_add(1, Ordering::SeqCst) + 1);
                        let observed_at = body
                            .pointer("/context/observed_at")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        state.events.lock().unwrap().push(json!({
                            "id": id,
                            "scope": body.get("scope").cloned().unwrap_or(Value::Null),
                            "content": body.get("content").cloned().unwrap_or(Value::Null),
                            "observed_at": observed_at,
                        }));
                        Json(json!({ "event_id": id, "duplicate": false }))
                    }
                },
            ),
        )
        .route(
            "/v1/recall",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let state = Arc::clone(&read_state);
                    async move {
                        assert!(authorized(&headers), "recall must carry the actor too");
                        state.reads.fetch_add(1, Ordering::SeqCst);
                        let scope = body
                            .get("scope")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        // Ranked retrieval is the engine's job; the mock returns
                        // everything filed under the asked-for scope and lets the
                        // host's own ranking do the rest.
                        let items: Vec<Value> = state
                            .events
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|event| {
                                event.get("scope").and_then(Value::as_str) == Some(scope)
                            })
                            .cloned()
                            .collect();
                        Json(json!({ "layers": { "events": items } }))
                    }
                },
            ),
        )
        .route(
            "/v1/forget",
            post(|Json(_body): Json<Value>| async move {
                Json(json!({ "deleted": { "events": 0 }, "matched": 0 }))
            }),
        )
        .route(
            // The driver's exhaustive reads (`get`/`list`/`namespace_summaries`,
            // and `recall`'s stale-hit correction) walk this instead of
            // `/v1/recall`, which cannot page a raw listing — see
            // `src/store/memory/cortexdb.rs::scope_events`. Without this route
            // every one of those calls 404s and the driver reports nothing, even
            // though `/v1/experience` accepted the write.
            "/v1/events",
            get(
                move |headers: axum::http::HeaderMap,
                      Query(params): Query<std::collections::HashMap<String, String>>| {
                    let state = Arc::clone(&events_state);
                    async move {
                        if !authorized(&headers) {
                            return (
                                axum::http::StatusCode::UNAUTHORIZED,
                                Json(json!({ "error": "unauthorized" })),
                            );
                        }
                        let scope = params.get("scope").cloned().unwrap_or_default();
                        let items: Vec<Value> = state
                            .events
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|event| {
                                event.get("scope").and_then(Value::as_str) == Some(scope.as_str())
                            })
                            .cloned()
                            .collect();
                        // One page always covers this test's event volume, so
                        // `has_more: false` and no `next_cursor` — the mock does
                        // not need to exercise the driver's paging loop.
                        (
                            axum::http::StatusCode::OK,
                            Json(json!({ "items": items, "has_more": false })),
                        )
                    }
                },
            ),
        )
        .route(
            "/v1/scopes/list",
            get(move |headers: axum::http::HeaderMap| {
                let state = Arc::clone(&scopes_state);
                async move {
                    if !authorized(&headers) {
                        return (
                            axum::http::StatusCode::UNAUTHORIZED,
                            Json(json!({ "error": "unauthorized" })),
                        );
                    }
                    let mut scopes: Vec<String> = state
                        .events
                        .lock()
                        .unwrap()
                        .iter()
                        .filter_map(|event| {
                            event.get("scope").and_then(Value::as_str).map(str::to_owned)
                        })
                        .collect();
                    scopes.sort();
                    scopes.dedup();
                    let items: Vec<Value> = scopes
                        .into_iter()
                        .map(|scope| json!({ "path": scope }))
                        .collect();
                    (
                        axum::http::StatusCode::OK,
                        Json(json!({ "items": items, "has_more": false })),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

/// **The same claim with the memory ports bound to a remote engine.**
///
/// The engine is selected exactly as a deployment selects it — through
/// `StorageSettings`, which is what `OPENCOMPANY_MEMORY*` parses into — so the
/// binding under test is the real one and no process environment is mutated.
#[tokio::test]
async fn a_desk_reasons_with_memory_held_in_a_remote_engine() {
    use opencompany::store::{MemoryBackend, StorageSettings, open_memory_overlay};

    let home = tempfile::tempdir().unwrap();
    let (cortex_url, cortex) = spawn_cortexdb().await;
    let overlay = open_memory_overlay(&StorageSettings {
        memory_backend: MemoryBackend::Remote,
        memory_driver: Some("cortexdb".to_owned()),
        memory_url: Some(cortex_url),
        memory_api_key: Some("cortex-test-token".to_owned()),
        ..StorageSettings::default()
    })
    .expect("the cortexdb engine binds")
    .expect("`remote` yields an overlay");

    let (base_url, script) = spawn_script(remembering_script()).await;
    let (address, runtime) = boot(home.path(), &base_url, SHORT, Some(overlay)).await;
    let client = Client::new(address);
    client.sign_in().await;

    client.say(DESK, ASK_ONE).await;
    let wrote = cortex.writes.load(Ordering::SeqCst);
    assert!(
        wrote > 0,
        "episode one stored nothing through /v1/experience, so the engine was not on the path"
    );

    client.say(DESK, ASK_TWO).await;
    assert!(
        cortex.reads.load(Ordering::SeqCst) > 0,
        "episode two never read /v1/recall"
    );

    // The engine served the fact, and the room's line was written from it.
    let recalled = tool_results_for(&script, ASK_TWO);
    assert!(
        recalled.iter().any(|result| result.contains(FACT_KEY)),
        "the remote engine did not serve back what episode one wrote to it: {recalled:?}"
    );
    let rows = replies(&runtime, DESK).await;
    assert!(
        turns(&rows).iter().any(|(_, text)| text.contains(FACT_KEY)),
        "no journaled line cites what the remote engine remembered: {rows:?}"
    );
}

// ---------------------------------------------------------------------------
// 9: a desk asks another desk, and only the information crosses
// ---------------------------------------------------------------------------

/// A desk of three that may put one question to `front`.
///
/// `quorum = 2` rather than three: the point of this episode is the crossing,
/// and a room that needs every seat spends its budget proving the earlier
/// tests' claim again.
const REFERRING: &str = "{ enabled = true, turn_budget = 12, quorum = 2, blind_round = false, \
                         referral = { enabled = true } }";

/// What the far desk says when it is asked.
const FAR_ANSWER: &str = "The front desk's own log shows the recurrence closing at 42 twice.";

/// The script for the referral episode.
///
/// Two shapes of request reach it now, and telling them apart is the whole
/// fixture: a **hive turn** carries `You are @<id>` and the attributed
/// transcript, and a **referred turn** carries neither, because the far
/// teammate is answering a colleague rather than taking a seat in this room.
fn referring_script() -> Responder {
    Arc::new(|ask: &Ask| {
        // The referred turn. Identified by the referral prompt's own opening,
        // which no episode prompt contains.
        if ask.speaker.is_none() {
            let last = ask
                .messages
                .last()
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if last.contains("has asked you a question") {
                return Reply::Say(FAR_ANSWER.to_owned());
            }
            return Reply::Say("Acknowledged.".to_owned());
        }
        let propose = format!("!propose #{TOPIC} The closed form of the recurrence is 42.");
        let grounds = ask.seq_of(&format!("!propose #{TOPIC}"));
        // The theorist opens by asking the other desk — early, before anybody
        // has backed anything, which is the timing the mechanism turns on.
        let line = match (ask.who(), grounds) {
            (THEORIST, None) if !ask.i_said("@#front") => format!(
                "!question #{TOPIC} Has the front desk seen this recurrence before? @#front"
            ),
            (THEORIST, None) => propose,
            (who, None) => format!("!question {who} is waiting for the opening position."),
            (who, Some(seq)) if ask.prompt.contains("The room has reached quorum") => {
                format!("!commit #{TOPIC} ^{seq} {who} records the room's decision.")
            }
            (THEORIST, Some(seq)) => format!(
                "!evidence #{TOPIC} ^{seq} theorist checked base cases 1..5 and each closes at 42."
            ),
            (who, Some(seq)) if !ask.i_said("!support") => {
                format!("!support #{TOPIC} ^{seq} {who} checked the derivation and it holds.")
            }
            (who, Some(_)) => format!("!question {who} has nothing further."),
        };
        Reply::Say(line)
    })
}

/// **A desk asks another desk, and the answer comes home without a vote.**
///
/// The claim the unit tests cannot make: the far turn goes through the *real*
/// harness turn path on the *far desk's* channel, its answer is journaled
/// there under the teammate that took it, and what returns to the asking desk
/// is a row the room authored — so a teammate on `front` can inform `lab`
/// without ever being able to carry a topic on it.
#[tokio::test]
async fn a_desk_asks_another_desk_and_only_the_information_crosses() {
    let home = tempfile::tempdir().unwrap();
    let (base_url, _script) = spawn_script(referring_script()).await;
    let (address, runtime) = boot(home.path(), &base_url, REFERRING, None).await;
    let client = Client::new(address);
    client.sign_in().await;

    client
        .say(DESK, "Settle the closed form of the recurrence.")
        .await;

    // The far desk ran a real turn, journaled under its own member.
    let far = replies(&runtime, SOLO_DESK).await;
    let answered: Vec<_> = far
        .iter()
        .filter(|(_, _, text)| text.contains(FAR_ANSWER))
        .collect();
    assert_eq!(
        answered.len(),
        1,
        "exactly one turn ran on the far desk — a desk mention is not a fan-out: {far:?}"
    );
    assert_eq!(
        answered[0].1, "greeter",
        "and it is authored by the teammate that took it, on its own desk: {far:?}"
    );

    // The answer came home, under the room and not under the answerer. This is
    // the property the whole design turns on: a row authored by a roster id
    // folds as a trace and can be counted as a supporter, so an answer that
    // crossed under `@greeter` would let one supporter count on two desks.
    let rows = replies(&runtime, DESK).await;
    let carried: Vec<_> = rows
        .iter()
        .filter(|(_, _, text)| text.contains(FAR_ANSWER))
        .collect();
    assert_eq!(carried.len(), 1, "the answer came home once: {rows:?}");
    assert_eq!(
        carried[0].1, HIVE_REFERRAL_AUTHOR,
        "carried by the room, never by the far teammate: {rows:?}"
    );
    assert!(
        carried[0].2.contains("@greeter") && carried[0].2.contains("Front"),
        "and it says who answered and where: {}",
        carried[0].2
    );

    // `greeter` never becomes a member of this desk's fold. Asserted over the
    // raw rows rather than over `turns`, which already filters to the three
    // seats and so could not fail: the claim is that nothing on this desk is
    // authored by the far teammate at all.
    assert!(
        rows.iter().all(|(_, author, _)| author != "greeter"),
        "a far teammate authored a row in the asking room: {rows:?}"
    );

    // The room still settles, and the closing report tells the operator it
    // went outside — which is the one thing an operator reading this desk
    // cannot otherwise see, because the far turn happened somewhere else.
    let reports = reports(&rows);
    assert_eq!(reports.len(), 1, "{rows:?}");
    assert!(
        reports[0].contains("asked 1 question of another desk"),
        "{}",
        reports[0]
    );
    assert!(reports[0].contains("@greeter on front"), "{}", reports[0]);
}
