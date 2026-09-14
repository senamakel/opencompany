# Provider contracts

What each shipped provider actually accepts, and where our defaults came from.
Compiled 2026-09-12 from a documentation audit of all 29 catalogue rows.

**This page exists because five separate defects had the same root cause**: one
provider's dialect treated as universal. A 403 read as one vendor's meaning, a
tier name sent to vendors who never published it, `temperature: 0.0` sent to
models that reject it, a local runtime's fallback pointing at OpenRouter, and a
catalogue query that only ever ran on one code path. Writing the contracts down
is what stops the sixth.

## How to read the verification marks

| Mark | Means |
|---|---|
| **V** | Read in the vendor's own documentation. |
| **S** | Secondary source only — an integrator's docs, an issue tracker. **A lead, not a fact.** Do not build behaviour on one. |
| **I** | Inferred from a response we observed rather than from anything published. Weaker than **S**: it is one endpoint on one day. |
| **ND** | Not documented anywhere reachable. Not "probably fine" — unknown. |

Where a cell would be a guess it says ND. Three vendors we ship
(`orcarouter`, `kilocode`, and `sumopod`'s catalogue path) have **no
first-party API reference we could fetch**, which is itself a finding: no defect
in them can be diagnosed from documentation, and any fix would be a guess.

## The rule this module now follows

**Code knows mechanisms. Data knows vendors.**

No vendor name and no parameter name belongs in translation logic. A vendor
quirk is a row in [`dialect::RULES`](../../../src/company/inference/dialect.rs);
a provider is a row in
[`catalogue.rs`](../../../src/company/inference/catalogue.rs). Adding either
must never mean editing a function.

The corollary matters as much: **a table is an optimisation, not a dependency.**
Everything here can be wrong or go stale, so the request path learns from a
model's own rejection and corrects itself without a release. See
[Learning from the 400](#learning-from-the-400).

## Base URLs

Endpoints are per-row presets, never derived. `https://{host}/v1` is wrong for
about a third of the list — the paths include `/openai/v1`, `/inference/v1`,
`/v1beta/openai`, `/v3/openai`, `/api/paas/v4`, `/api/gateway`, and DeepSeek's
bare host with no version segment at all.

The cloud category deliberately never lets an operator type a URL, so **a wrong
preset is not a bad default — it is unfixable from the console.**

### Corrected in this change

| Provider | Was | Now | Evidence |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `https://api.deepseek.com` | Landing page documents exactly two base URLs, neither with `/v1`; listing reference shows `GET /models`. The old "you may also use `/v1`" sentence is gone. **V** |
| `together` | `https://api.together.xyz/v1` | `https://api.together.ai/v1` | Every current page uses `.ai`; `.xyz` appears on no live page. Whether `.xyz` is deprecated is **ND** in both directions. |
| `stepfun` | `https://api.stepfun.ai/step_plan/v1` | `https://api.stepfun.ai/v1` | Platform docs show `/v1` **V**; an OpenCode issue reports `/step_plan/v1` as the only path a Step Plan key accepts **S**. Vendor doc wins over secondary source. |

### Verified correct, left alone

`openai`, `anthropic`, `google`, `groq`, `mistral`, `xai`, `cerebras`,
`openrouter`, `vercel-ai-gateway`, `huggingface`, `nvidia`, `deepinfra`,
`novita`, `moonshot`, `minimax`, `venice`, `gmi` — all exact matches to the
vendor's documented base URL **V**.

`modelscope` **S** (CN-only host), `orcarouter` **S**, `kilocode` **S**,
`sumopod` **S** — corroborated only by integrator documentation.

### Unverified, deliberately not changed

- **`zai`** ships `https://api.z.ai/api/paas/v4`, the general endpoint **V**. A
  GLM **Coding Plan** key reportedly needs `https://api.z.ai/api/coding/paas/v4`
  **S**. These are two products, not two regions. Swapping a documented endpoint
  for a secondary-sourced one would strand general-plan keys to rescue
  coding-plan ones, so the row is unchanged and **a Coding Plan subscriber has
  nowhere to go today.**
- **`stepfun` region split** — `api.stepfun.ai` (global) vs `api.stepfun.com`
  (China); the account's registration domain must match **S**.
- **`orcarouter`, `kilocode`** — first-party docs returned 403/404 to every
  fetch on 2026-09-12. Paths, auth, error codes and alias behaviour are all
  inferred from third parties.
- **`sumopod`** — base URL corroborated **S**, but its catalogue lives on a
  *different host* (`api-gate.sumopod.com/webhook/sumopod/ai/models`), which
  suggests `ai.sumopod.com/v1/models` may not exist at all.

### Regional and alternate endpoints we cannot serve

A preset is one value, so a vendor running two products or two regions behind
different paths is reachable for at most one of them. OpenAI publishes ten data
residency hosts (`us. eu. au. ca. jp. …api.openai.com`) plus an mTLS EU host;
Mistral has `api.eu.` and `api.us.` at 1.1× list price; Fireworks has a US host
and an Azure Foundry host taking an Azure key. **V** for all three. An
EU-residency customer's key fails against our hardcoded host and reads as a bad
key.

Anthropic is the exception that confirms the shape: it has **no** regional
hostname — region is the `inference_geo` request parameter — so our default is
right **V**.

## `temperature`, and what a caller actually means

`temperature: Some(0.0)` is not a temperature. It is **"be deterministic"**
written in one vendor's dialect. Callers now state
[`Sampling`](../../../src/company/inference/dialect.rs) intent and the table
spells it per model.

| Provider | `temperature` | Evidence |
|---|---|---|
| anthropic | ⛔ **rejected** unless `1.0` on post-Opus-4.6 — the entire current lineup | **V** |
| openai | ⛔ **rejected** on current flagships, all reasoning models | **V** migration guide; error string **ND** |
| groq | accepted, but `0` is rewritten to `1e-8` | **V** |
| deepseek | accepted, **silently ignored in thinking mode** | **V** |
| together | accepted, range **0–1** not 0–2 | **V** |
| google, mistral, xai, fireworks, cerebras | accepted | **V** |
| minimax, novita, stepfun, gmi, deepinfra, zai | accepted | **V** |
| orcarouter, kilocode, sumopod, modelscope, moonshot, venice, huggingface, nvidia, vercel-ai-gateway | **ND** | — |

Anthropic's notice, verbatim: *"Models released after Claude Opus 4.6 do not
support setting temperature. A value of 1.0 … will be accepted for backwards
compatibility, all other values will be rejected with a 400 error."* `top_p`
carries the same notice (≥ 0.99 accepted); **`top_k` is rejected at any value.**

⚠️ **Anthropic's OpenAI-compat page contradicts its own Messages reference**,
still claiming *"Most unsupported fields are silently ignored rather than
producing errors"*. The 400 in our bug report says the model-level rejection
wins downstream of the translation layer. **Treat the compat table as stale.**

**Together, Fireworks and Cerebras reject `temperature` on no model at all** —
a clean negative **V**. This is why the fix is per-model translation and not
stripping the field everywhere.

### Gateways are not a safe harbour

Five gateways (`openrouter`, `orcarouter`, `vercel-ai-gateway`, `huggingface`,
`kilocode`) forward to upstreams that *do* reject these fields, and **not one of
them documents what it does with a parameter the chosen upstream rejects.**
OpenRouter documents only the *absent*-parameter case. A widely-quoted sentence
saying unsupported parameters are ignored could not be found on OpenRouter's own
page — **treat it as S**. Planning around it is how this defect returns.

## Token limits

| Provider | Field | Evidence |
|---|---|---|
| openai | `max_completion_tokens`; `max_tokens` deprecated **and rejected** on reasoning models | **V** |
| xai | `max_completion_tokens`; `max_tokens` deprecated | **V** |
| groq | `max_tokens` deprecated | **V** |
| mistral, deepseek, together | `max_tokens` only | **V** |
| anthropic (compat), fireworks | both accepted | **V** |
| cerebras | aliases — *"Do not send both parameters in the same request."* | **V** |
| ollama | `max_tokens`; **`max_completion_tokens` silently dropped → no cap applied** | **V** |

`max_tokens` → `max_completion_tokens` is a `RenameTo` row, applied per model.
Cerebras is why sending both "for compatibility" would be a regression.

## Authentication

`Authorization: Bearer` on the chat path for **every** provider including
Anthropic, whose `/v1/chat/completions` is its OpenAI-compat layer **V**.
`AuthStyle::Anthropic` (`x-api-key` + `anthropic-version`) applies to its
**native** endpoints, and the only native call we make is `GET /v1/models`.

This is the one place in the codebase that gets the two-styles problem right.
Do not "simplify" it.

Anthropic now documents Bearer as the **primary** scheme with `x-api-key` as a
*"legacy fallback … still supported"* **V**, so the real requirement is the
`anthropic-version` header rather than the key header.

### Local runtimes

| Runtime | Requires a key | Accepts one |
|---|---|---|
| ollama | no — *"No authentication is required … locally"*; `OLLAMA_API_KEY` is Cloud-only and sending it locally is a documented cause of spurious 401s **V** | no |
| lmstudio | no **V** | opt-in toggle exists; **we offer no path to it** |
| omlx | no — see below | yes, if the operator enabled it; **we offer no path to it** |

**"omlx" is ambiguous and our row does not say which project it means.** Three
candidates, three ports, three auth stories, all **V** by repository:

| Project | Port | Auth |
|---|---|---|
| `ml-explore/mlx-lm` (`mlx_lm.server`) | 8080 | none, no mechanism at all |
| `madroidmaq/mlx-omni-server` | 10240 | none, no mechanism at all |
| `jundot/omlx` | 8000 | optional `--api-key`, off unless passed |

`default_endpoint: None` is the honest answer to three different ports, but it
offers the operator no help. **Resolving which project we mean is outstanding.**

## Model listing

Our probe is `GET {base_url}/models` with the same credential as chat.

**On the paths we actually call, no cloud provider in the audit is documented as
answering without auth** **V**. Two things to keep in view:

- ⚠️ **Cerebras ships a keyless twin at a different path** —
  `GET https://api.cerebras.ai/public/v1/models`, *"public and does not require
  an API key"* **V**. Our `{base}/models` reaches the authed one. "Fixing" the
  path to `/public/v1/…` would manufacture the Venice defect below.
- **Venice and Hugging Face cannot fail a key check.** Venice documents
  `/models` as *"readable without a key"* **V**; Hugging Face's own curl sends
  no `Authorization` header **V**. A revoked or typo'd key returns 200 with a
  full catalogue, so the provider reads as connected and every turn fails later.
  **Outstanding — not fixed in this change.**

### OpenRouter's catalogue query

`limit` defaults to **500** (max 1000) and `output_modalities` defaults to
**`text`** **V**. Both parameters are properties of OpenRouter's catalog API,
not of the authenticated `/models/user` path, and are now applied to every
catalogue read via `catalogue::catalog_query`. Without them, vision models were
silently absent from the picker.

**Known limitation:** `links.next` is still not followed, so a catalogue past
1000 entries — the API maximum — would truncate its tail.

### Alias-shaped ids are a live hazard

- **xAI returns `{"id": "latest"}`** **V** — a tier-shaped name from the vendor,
  exactly the shape that produced the `agentic-v1` → 404 defect.
  `GET /v1/language-models` separates canonical id from aliases. **Outstanding.**
- **DeepSeek's `deepseek-flash` is a moving pointer** **V**.
- **Mistral publishes an explicit `aliases` field** and uses `-latest` ids in its
  own examples **V**.

## What a bad key actually returns

**Match the status and the vendor's words. Never match text we wrote ourselves.**

That is not a style preference. `probe_models` used to build the classifier's
input as `"{status} {reason}: {body}"`, and `canonical_reason()` for 403 is the
literal word `Forbidden` — which the auth branch tested for. The guard read as
"a 403 counts only with credential wording" and behaved as "every 403 deletes
the key", for every provider, on causes as ordinary as a long prompt.

### The 403 table — why a blanket rule is wrong in both directions

| Provider | Documented 403 | Credential bad? |
|---|---|---|
| together | **context-length overflow** — *"Input token count + `max_tokens` … must be less than the context length"*, which Together itself labels "Bad Request" | **no** |
| openai | geography — *"Country, region, or territory not supported"* | **no** |
| anthropic | `permission_error` — *"Your API key does not have permission to use the specified resource."* | **no** |
| google | `PERMISSION_DENIED` | **no** |
| groq | *"not allowed due to permission restrictions"* | **no** |
| xai | team blocked — *"Ask your team admin for permission."* | **no** |
| cerebras | `PermissionDeniedError`, cause **ND** | **no** |
| openrouter | *"Forbidden (insufficient permissions, guardrail block, or moderation flag)"* | **no** |
| nvidia | org lacks "Public API Endpoints", or free-tier overload **S** | **no** |
| **fireworks** | data residency, wrong key *type*, **and genuine auth** — *"Authentication issues … Verify you have the correct API key"* | **sometimes** |

Anthropic's wording is why matching the bare word `key` was never safe: it names
the API key in the refusal of a key that is perfectly valid.

**The resolution needs no per-provider hint.** The discriminator is the vendor's
own wording, not the status: Together's 403 body matches no credential phrase
and keeps the key; Fireworks' two documented bad-key messages are matched
explicitly. A provider-keyed rule would be *worse* — Fireworks returns
non-credential 403s too, and "Fireworks 403 = auth" would delete keys on those.

### Bad-key bodies

- **anthropic V** — top-level `{"type":"error","error":{"type":"authentication_error",…}}`, not OpenAI's shape.
- **deepseek V** status, body **I** — *"Authentication Fails (no such user)"*.
- **openai V** status, body **I** — the auth signal is in `code`
  (`invalid_api_key`), while `type` is `invalid_request_error`. The trap is
  reading `type`.
- **fireworks V** — *"You must provide an API key"* and *"The API key you
  provided is invalid"*. **Neither matches `invalid api key`,
  `invalid_api_key` or `incorrect api key`**, so before this change a genuinely
  dead Fireworks key was kept as a transient failure and every turn failed
  silently. Both strings are now matched explicitly.
- **xai, mistral, together, cerebras** — publish no bad-key body at all **ND**.
  Mistral has no error page of any kind. **For these, match status, not body.**

Together says so itself: *"`type` and `code` values are Together's. Match on
HTTP status … for portable handling."* **V**

### Out of credit

Every out-of-credit state separates from a bad key **by status code**. 402 exists
on five providers — Anthropic `billing_error`, DeepSeek *Insufficient Balance*,
Together spend cap, Fireworks unpaid, Cerebras `PaymentRequired` **V**. OpenAI
uses **429** `credit_balance_exhausted` instead **V**. Fireworks adds **412** for
a suspended account, which is *also* what it returns when a LoRA model fails to
load — one code, two unrelated causes.

### Proxy and WAF

**ND** for every vendor. Anthropic and Together both confirm a Cloudflare edge
exists **V**. An edge rejection is HTML, not the documented JSON, and its text
routinely contains "Forbidden", "denied", "blocked".

`classify` checks proxy/WAF markers **first**, and that ordering is load-bearing:
it is what keeps a Cloudflare-fronted SumoPod from deleting a key, and what stops
*"407 Proxy Authentication Required"* reaching the auth branch. **Keep it ahead
of the auth branch.**

## Learning from the 400

The layer that makes the tables above an optimisation rather than a dependency.

On a **400** whose body names a parameter we actually sent, the request path
drops that one parameter, remembers the omission for that model, and retries
**once**. A 400 bills nothing, so being wrong about a model costs one round-trip
and then works; without it, being wrong costs a release.

Bounded deliberately:

- **Only a 400.** A 5xx, 429 or 401 is about the service or the credential;
  narrowing the body over one would drop a parameter for a problem it did not
  cause.
- **Only one retry**, so a model rejecting two parameters fails the second time
  with a real error rather than looping.
- **Only a parameter in `RequestPlan::tunable_fields`** — what actually went on
  the wire after any rename. A rejection naming a field we never sent cannot
  talk us into removing one. Same lesson as the 403: act on the vendor's words
  about our request, never on text we supplied.

## Known limitations

Carried deliberately, each with what it would take to close.

| # | Limitation | What it needs |
|---|---|---|
| 1 | **OpenAI tool calling requires `/v1/responses`.** Vendor-confirmed: *"GPT-6 Astra supports Chat Completions, but tool calling requires Responses"* **V**. The exact 400 string and its extension to the gpt-5.6 family come from Microsoft Learn, a **mirror**. Our URL builder can only produce `/chat/completions`, so OpenAI-direct works for bare chat and fails the moment an agent has a tool belt — which is always. | A second request shape and response parser. A routing difference, not a parameter one, so the dialect table cannot express it. |
| 2 | **Fireworks can never pass the connect probe.** `{base}/models` resolves to `api.fireworks.ai/inference/v1/models`; the inference OpenAPI spec has only `/v1/completions` and `/v1/chat/completions` **V**. The real listing is `api.fireworks.ai/v1/accounts/{account_id}/models` — account-scoped, needing an id we never collect. The 404 is classified `Endpoint` and advises checking a base URL nobody can edit. | Collecting an account id, or a per-provider catalogue path. Fireworks also has **no free probe at all** and a 10 RPM account-wide envelope without a payment method **V**. |
| 3 | **A caller's explicit `Exact(n)` can still be refused.** `FixedAt`/`Omit` rules cover the models we know; an operator-supplied value on an unknown model costs one round-trip via the retry. They should eventually be *told* "this model does not accept a temperature" rather than having it silently rewritten. | An operator-facing control and a way to report a rewrite. `Exact(n)` already arrives through the same path, so the seam exists. |
| 4 | **Venice and Hugging Face cannot fail a key check** (see above). | A probe that is not a catalogue read for these two. |
| 5 | **xAI offers `"latest"` as a model id** (see above). | `GET /v1/language-models`. |
| 6 | **`links.next` is not followed** on catalogue reads. | A paging loop in `fetch_catalog`. |
| 7 | **A GLM Coding Plan key and a StepFun Step Plan key have nowhere to go.** | Letting the cloud category accept an endpoint override, or a second row per product. |
| 8 | **`parallel_tool_calls: false` reaches only proxied endpoints and OpenRouter.** The gate is a payer test, not a capability test, so the turn-boundary promise is not enforced on the wire for most BYOK endpoints. Whether each gateway accepts the field is **ND**. | Per-endpoint capability discovery. |
| 9 | **Which project `omlx` means is unresolved** (see above). | An operator decision. |
| 10 | **ModelScope's free tier is 2,000 calls/day, ≤200/model/day** **S**, and our own probes spend it. | A rate note in the UI, or fewer probes. |
| 11 | **The managed brain never learns from a 400.** The retry-and-remember layer is keyed on `RequestPlan::tunable_fields`, and `HostedProvider` sends its body with no plan, so an unknown or changed managed model keeps failing where a BYOK one would correct itself after one round-trip. | Routing the hosted path through the shared send logic, or giving it the same bounded retry. |
| 13 | **A credential over plain `http` is refused by the probe, not by the turn.** `check_endpoint_with_credential` stops us presenting a key to an `http` endpoint off this host, but the stored row survives — an endpoint-class refusal is non-destructive — and `send_body` applies no guard, so turns still reach it. Refusing at the write path would also refuse an intranet gateway that works today. | A decision about whether to refuse the configuration outright, and the same predicate on the turn path if so. |
| 12 | **The console offers no way to give a local runtime an optional key.** `credentialAsk` models whether a key is *required*, so an `omlx` started with `--api-key` (and LM Studio with its server toggle on) cannot be authenticated from this surface even though the host would accept it. | Separating "accepts a key" from "requires one", through the dialog, the row menu and the host's own check. |

## Sources

Vendor documentation read 2026-09-12. Full per-claim citations, including the
URLs behind every **V**, are in the audit documents this page consolidates:
`provider-research-cloud.md`, `provider-research-gateways.md` and
`provider-research-ourcode.md`.

All quoted strings reached the audit through a summarising fetch layer. Status
codes, paths and parameter names were consistent across independent pages and
are solid; **exact punctuation inside a quotation is worth re-checking before it
lands in a code comment.**
