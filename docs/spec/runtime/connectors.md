# Connectors — where the runtime runs

A **connector** is the answer to one question an operator has to answer before
anything else works: *where does my company actually run?* Today the console
answers it twice, in two unrelated places — the desktop's "Add a host" screen
offers a local instance or a typed URL, and the hosted platform is reached by
being handed a link. Neither is a choice presented as a choice.

This document defines the connector as a first-class thing: a named way of
reaching a runtime, with its own setup flow, its own credential, and its own
failure modes, selected per host rather than per application.

Prior art is [`nousresearch/hermes-agent`](https://github.com/nousresearch/hermes-agent),
which separates the *gateway* an operator talks to from the *terminal backend*
the agent executes on, and asks at setup which of local, its own cloud, a remote
gateway, or an SSH target it should be. OpenCompany has the same split already —
the console is one codebase, the host is one binary, and
[`desktop.md`](desktop.md) is the seam between them — so what is missing is not
architecture but the chooser and two of the four destinations.

Read [`desktop.md`](desktop.md) and [`desktop-instances.md`](desktop-instances.md)
first: connections, the proxy and the local roster are the machinery this builds
on. [`hub-console.md`](hub-console.md) carries the cross-origin session rules
that the cloud and remote connectors inherit.

## The four

| | who starts the process | where the data root is | credential | available in |
|---|---|---|---|---|
| **`local`** — on this computer | this application | `<data-dir>/instances/<id>` | none (`auth_mode = none`) | desktop only |
| **`cloud`** — TinyHumans Cloud | the `opencompany-manager` control plane | the tenant volume at `/data` | carried session | desktop, browser, hub |
| **`remote`** — a gateway you run | you, on a box you own | that box's `OPENCOMPANY_DATA_DIR` | paired device or carried session | desktop, browser, hub |
| **`ssh`** — over SSH | you, on a box you own; this application opens the tunnel | that box's `OPENCOMPANY_DATA_DIR` | paired device over loopback | desktop only |

Two of these exist. `local` is `crates/opencompany-app/src/local.rs` and the "On this
computer" tab; `remote` is the "Somewhere else" tab, which is a URL field and
nothing else. `cloud` and `ssh` are new, and `remote` grows a setup flow rather
than a text input.

## A connector is a property of a connection, not a mode of the app

The rule that governs everything below is already written down in
`frontend/src/connections/registry.ts`: **N connections, and no active one.**
Selecting a host is a rendering choice, not a state change.

A connector chooser that sets "the app is in cloud mode" would undo that. There
is no application-wide answer to "where does it run", because the honest answer
for a real operator is *several places at once* — a scratch company on the
laptop, the real one in the cloud, a customer's on a VPS reached over SSH. All
four connectors must be holdable simultaneously, each with its own status row,
each failing on its own.

So the connector is a field on `Connection`, chosen once when the host is added,
and the chooser is the "Add a host" screen growing from two tabs to four.

### It extends `ConnectionOrigin`, and turns it into a tagged union

`frontend/src/connections/types.ts` has the seed of this already:

```ts
export type ConnectionOrigin = "embedded";
```

with a comment explaining why the marker has to be *durable* — the embedded
host's address is regenerated on every launch, so recognising last launch's row
as *this* host is what stops a dead one accumulating per run.

That argument generalises exactly, and it is the reason the connector cannot be
inferred from the URL at read time. An SSH tunnel's local port is chosen at
open time and differs every launch, so `http://127.0.0.1:49221` is *this*
connector's address today and nobody's tomorrow. A cloud tenant and a
self-hosted gateway are both `https://…` and are told apart by nothing in the
address. The connector is therefore persisted, and carries the kind-specific
configuration needed to re-establish the connection:

```ts
export type Connector =
  /** The host inside this application, over a data root it owns. */
  | { kind: "local" }
  /** A tenant of the hosted control plane. */
  | { kind: "cloud"; tenant: string }
  /** A host someone else's process is serving, addressed directly. */
  | { kind: "remote" }
  /** A host bound to loopback on another machine, reached through a tunnel. */
  | { kind: "ssh"; target: SshTarget };
```

`local` carries no instance id: the host's own identity already reaches the
connection through `/spec` and through `oc_embedded`, and a second copy of it
inside the connector would be a field that can disagree with itself.

Three vintages of `localStorage` have to be read forward, and `connectorOf` in
`profileStore.ts` is the one place that does it: a `connector`, or
`origin: "embedded"` from the version before it, or — for the oldest — the
signature the bug left behind, this client's own label at a loopback address.
The guess happens once, because the first save after a restore writes a real
connector. `origin` is still written *beside* it for one release, so a build
someone rolls back to still recognises a local host and still prunes last
launch's address.

`Connection.baseUrl` stays what it is — the address this client uses *right
now* — and for `local` and `ssh` it is derived at launch rather than restored.
The connector is what survives; the address is what is rebuilt from it.

## `local` — on this computer

Unchanged, and described in [`desktop-instances.md`](desktop-instances.md): a
roster in `<data-dir>/instances.json`, one host per data root, `oc_embedded` and
the `oc_*_local_instance` commands. What the connector chooser adds is framing —
this is one of four answers rather than the tab that happens to be first.

Keep the ordering. The desktop leads with the local half because starting a host
is the thing it can do that a browser cannot, and because a person who has just
installed the application has no URL to type and no account yet.

## `cloud` — TinyHumans Cloud

The destination that exists in production and has no client-side front door.
The control plane is `opencompany-manager` (the superproject at
`tinyhumansai/opencompany-microservices`, where this repo is the `opencompany/`
submodule). It builds this crate into a per-tenant container and injects
`OPENCOMPANY_COMPANY`, `OPENCOMPANY_BIND=0.0.0.0:8080`,
`OPENCOMPANY_DATA_DIR=/data`, `OPENCOMPANY_PUBLIC_URL` and
`OPENCOMPANY_ADMIN_EMAIL`; storage is per-tenant MongoDB or the shared-single-DB
mode described in [`storage.md`](storage.md).

What the connector has to do:

1. **Sign in to the control plane**, not to a host. This is the one connector
   where the operator's account is with TinyHumans rather than with the runtime,
   and the first credential obtained is a control-plane one.
2. **List the tenants that account owns**, and let the operator pick one — or
   provision a new one, which is the manager's job and the point at which the
   company template is chosen.
3. **Register a connection** at the tenant's `OPENCOMPANY_PUBLIC_URL`, and sign
   in to *that host* as a person. The admin invite is already standing:
   `OPENCOMPANY_ADMIN_EMAIL` is the address that provisioned the instance, which
   is why a provisioned company whose manifest names nobody still has somebody
   eligible ([`users.md`](users.md)).

Two consequences fall out of the platform's own shape and both are load-bearing
for the client.

**The credential is a carried session, not a cookie.** A cloud tenant is on a
different origin from the console — its own subdomain — so the host's
`SameSite=Lax` cookie is withheld from every request the console makes, and
`SameSite=None` merely turns it into a third-party cookie Safari discards. This
is the hub console's situation exactly, and it takes the hub's answer:
`{ kind: "session", value }` in `x-opencompany-session`, with the cost stated in
[`hub-console.md`](hub-console.md). On the desktop the proxy sidesteps the whole
question — see *CORS* below — but the browser and hub builds do not, so each
tenant must allow-list the console origin in `OPENCOMPANY_CORS_ORIGINS`.
Provisioning should write that, because an operator cannot: they have no shell
in the container.

**A hibernating tenant is not a down tenant.** The manager runs a
wake-on-request proxy that blocks on `/healthz` and gives up after its startup
timeout. A tenant that has been idle therefore answers its first request in
seconds, not milliseconds — the same hibernation Hermes gets from Modal and
Daytona, and the reason serverless hosting costs nearly nothing when idle.

The console's probe budget today assumes a host that is either listening or
gone. Applied to a cold tenant it reports `down`, which is wrong in the way
that matters: it tells the operator their company is broken when it is asleep.
The connector therefore carries the patience, not the prober:

- a `cloud` connection that fails its probe keeps trying, and stays
  `connecting` while it does. `waking.ts` holds the two decisions: `keepWaking`
  (only `cloud`, only `down`, only inside the window) and `wakeRetryDelay`, an
  exponential backoff capped at eight seconds. Retrying is not optional — the
  console has no periodic re-probe, so a row parked on `connecting` with
  nothing behind it would simply hang.
- the row says *Waking…* for that window. Not a fifth `ConnectionStatus`:
  waking is a connecting host and ranks exactly like one on the trigger, so a
  new status would need a place in the severity ordering and a branch in every
  `switch` for a state that behaves identically. `statusCopy` in
  `host-switcher.tsx` takes the *connection* and supplies the word.

`unauthenticated` is excluded deliberately. It is an answer — the tenant is
awake and refusing this credential — and retrying it would hide the sign-in the
operator has to do behind a spinner.

The window is a ceiling this client imposes (90s), not one the manager reports:
nothing surfaces its startup timeout. Being too patient costs a row that says
"Waking…" for longer than it had to; being too impatient costs telling somebody
their company is gone.

**What has not landed** is the front door. The tab asks for the address the
platform gave you, because an account-scoped tenant listing is the manager's
surface to expose and it does not exist yet. Control-plane sign-in, the tenant
list, and provisioning from the chooser all wait on it — the connector, and the
patience it carries, do not.

## `remote` — a gateway you run

The `$5 VPS` case, and the one that half-exists: `RemoteHost` in the switcher is
a URL field, an Add button, and no notion of how the console is going to
authenticate once it gets there.

What it needs beyond the field:

- **A probe before commit.** `/spec` answers with the host's identity and
  capabilities and is unauthenticated; asking it before the row is written turns
  a typo into an error message on the chooser rather than a permanently red row
  in the switcher. Note that `capabilities` being absent means *assume REST
  only* — an older host omits the field — so `undefined` and `[]` must not be
  conflated.
- **A sign-in step**, choosing by address. `needsCarriedSession` already
  decides between the cookie and the carried header from the address, and the
  desktop has a third option the browser does not: `oc_pair_device` mints a
  paired device session whose token lives in the OS keychain and is referenced,
  never held, by the connection record (`{ kind: "device"; ref }`).
- **The address rule.** `isAddressableBaseUrl()` — `http:` or `https:` with an
  authority. On the desktop a base url is absolute or it is nothing: the proxy
  concatenates it with a path, and `localhost:8080` or `/api` yields a relative
  url that `reqwest` refuses at `send`, so the request never reaches a socket
  and the console reports a failure about a host it never addressed
  ([#613](https://github.com/tinyhumansai/opencompany/issues/613)).

The honest limitation to print on the chooser: **from a browser, a remote gateway
must allow-list this console's origin.** There is no wildcard, because the
session is a credential and `Access-Control-Allow-Origin: *` is forbidden with
credentials. An operator adding a host from the web build and getting nothing
but CORS failures is the most likely support question this connector generates,
and the chooser is where it is cheapest to answer.

## `ssh` — over SSH

The genuinely new capability, and the reason the desktop earns its existence a
second time.

The case it serves is the one where `remote` is wrong: a host on a box that has
no public address, no TLS, and no business having either — a homelab machine, a
work VM behind a bastion, a cloud instance whose only open port is 22. Today
that operator's options are to expose the host to the internet or to run
`ssh -L` in a terminal and add `http://127.0.0.1:<port>` by hand. Both work.
Neither is a product.

The connector makes the tunnel the application's job:

```
console ──▶ ProxyTransport ──▶ 127.0.0.1:<local> ═══ssh═══▶ remote 127.0.0.1:8080
```

The host stays bound to loopback on the far side and is never reachable from
anywhere else. That is the security argument for this connector over `remote`,
and it is a strong one: an OpenCompany host holds a company's credentials, its
repositories and its journal, and the smallest number of ways to reach it is the
right number.

### What the operator supplies

```ts
interface SshTarget {
  /** `user@host`, or a `Host` alias out of `~/.ssh/config`. */
  destination: string;
  port?: number;
  /** Where the host is listening on the far side. Defaults to 8080. */
  remotePort: number;
}
```

An alias out of `~/.ssh/config` is the field to lead with. Anyone with a
bastion, a jump host or a non-default key has already written that file, and a
form that re-asks for its contents is a form they will fill in wrong.

No secret, and no keychain handle for one. The child has no terminal, so a
passphrase or password prompt would block forever with nothing on screen;
`BatchMode=yes` refuses prompts outright and the connection fails immediately
with what `ssh` printed instead. **The key has to be one `ssh` can use without
asking** — an agent key, or one with no passphrase. That is a real limit, and
it is the honest one: a legible refusal an operator can act on beats a spinner
that never stops.

The destination is validated before it becomes an argument. A value starting
with `-` reads as an ssh *option* rather than a host — `-oProxyCommand=…` being
the memorable one — and there is no legitimate destination of that shape, so it
is refused rather than escaped. No shell is involved either way; the child is
spawned with an argv.

### What the shell has to do

The tunnel is a resource with a lifetime, which makes it the local host's
sibling rather than the remote host's: something `crates/opencompany-app` starts, supervises,
and tears down, alongside `local.rs`. The command surface mirrors the roster's:

- `oc_open_ssh_tunnel(target) -> SshTunnelInfo` — bind an ephemeral loopback
  port, open the forward, **wait for the local end to actually accept a
  connection**, and answer with the address the connection should use. Waiting
  is the part that matters: an address handed back before the tunnel forwards
  goes straight to the proxy, whose first request fails and parks the row on
  "unreachable" — blaming the host for a tunnel that was still being built.
  Idempotent per target, because the console asks on every probe.
- `oc_close_ssh_tunnel(target)` — by target, not by the id the info carries, so
  the roster key stays derived in exactly one place. The console persists the
  target and has never seen the id; a second copy of that derivation in
  TypeScript would be a rule two languages have to keep in step.
- `oc_ssh_tunnels()` — the roster, so a tunnel that dropped is a row carrying
  its reason rather than a connection that silently went `down`.

**A failed open leaves nothing behind.** The child is killed and no row is
kept: a roster entry for a tunnel that is not forwarding is a host the console
would probe forever and never reach.

### Who opens it, and when

Not a startup pass. `probe` opens the tunnel for an `ssh` connection before it
contacts anything, and re-seats the connection if the address moved — which it
does on every launch. That is what makes the ephemeral port harmless, and it
needs no separate idea of which tunnels are up, because opening is idempotent
on the core's side.

The chooser is the exception, and deliberately: adding a host opens the tunnel
there so that a destination `ssh` refuses is reported in the form the operator
is standing in front of, rather than becoming a red row they have to go and
read.

An `ssh` connection is also recognised by its **target** rather than by its
address (`findSshProfile`). Matching on `http://127.0.0.1:49221` would mint a
fresh id every launch and orphan the tour state, the last-read channel and the
mail draft with it — [#615](https://github.com/tinyhumansai/opencompany/issues/615)
reached through a different connector.

Three rules carry over from the local roster, for the same reasons stated there:

- **One failed tunnel is a row, not a launch failure.** A bastion that is down
  must not stop the other connectors from coming up.
- **Bind the local port ephemerally and record it nowhere.** It is regenerated
  per launch, exactly like the embedded host's address, which is why the
  connector rather than the URL is what persists.
- **Autostart is a record of the last explicit action.** A tunnel the operator
  closed is not silently reopened by the next launch.

### Which SSH

Two implementations, and the choice is not obvious.

**Shelling out to the system `ssh`** inherits `~/.ssh/config`, `ProxyJump`, the
agent, hardware keys, and the operator's `known_hosts` — including its
`StrictHostKeyChecking` prompt, which is a security control this application
must not reimplement worse. It costs a child process to supervise and is absent
on a stock Windows install predating OpenSSH's inclusion.

**An in-process client** (`russh`) has no dependency and no process to babysit,
but owns host-key verification, agent negotiation and config parsing itself —
each of which is a way to be subtly less safe than the tool the operator already
trusts.

Ship the system `ssh`. The failure mode of the in-process client is "we
accepted a host key the operator's own config would have refused", and that is
not a trade to make for a Windows dependency that ships in the OS today.

## Where the choice is offered

Two places, and neither of them is a dialog.

**"Add a host"** is the ordinary one: four tabs, `local` and `ssh` present only
where a process can be started. It is reached from the switcher, which means it
is reached by someone who already has a console on screen.

It is a **screen**, not a popup
([#1531](https://github.com/tinyhumansai/opencompany/issues/1531)). It was a
`Dialog` while it was an afterthought on the switcher's last menu item, and that
dialog is 24rem wide: four tabs clipped their own labels in it, and the card
scrolled its own title away to make room for the form. The deeper reason is that
adding a host is the *first* step of onboarding rather than a confirmation —
nothing else on the host is reachable until it is done — so it is drawn in the
same `OnboardingShell` card as the setup wizard, and reads as one flow with it.
`App` renders it beside the console and hides the console behind it rather than
unmounting it, so cancelling out does not tear down a live connection's streams.

**The first-host screen** is the one that matters more, and it used to be a
dead end. A console holding no connection at all rendered "the host on this
computer didn't start … or add a host from the switcher above" — a sentence
that names a control instead of being one, and that describes the wrong
situation entirely on a hub, whose own origin serves assets and nothing else
(`hub-console.md`). A hub nobody has added a host to yet holds zero connections
and always did: nothing went wrong, and telling somebody on their first run
that a host failed to start is how a working state reads as a fault.

So `firstHostCopy` splits the two — "No host to show" and what to do about it
for a desktop, "No company connected yet" and what the choice *is* for a hub —
and both carry a button that opens the chooser. The switcher stays above it,
because that is where an operator will look next time.

### Modifying one afterwards

Adding a host was long the only thing that could be done to one, and the missing
half is not cosmetic: a host's address changes — a gateway gets a domain, a VPS
moves, a tenant is renamed — and the only recourse was to forget it and add it
again. That mints a **new connection id**, and every browser-local key is scoped
by it, so re-adding a host that merely moved silently resets its tour progress,
its last-read channel and its drafts.

So the switcher offers **"Manage hosts"** beside "Add a host", and it opens a
page rather than a menu of row-level buttons: a switcher row is a *filter*, so
hanging a rename and a delete off it makes a control whose click targets
disagree about what a row is for. That menu now opens on **any** host rather
than only on two (`hostSwitcherMenu`): one host was furniture while the menu held
nothing but the roster, but it is the only route to this page now, and a
single-connection browser console was getting a nameplate with nothing behind it.

The page does three things; `editConnection` in `registry.ts` does the first two:

- **rename**, which is the only edit a host reached over `ssh` accepts. A
  `local` host is not renamed here at all: its name and its address are
  re-applied from the local instance roster on every refresh, so the page
  offers it no edit control rather than one that would not survive;
- **re-address**, offered for `remote` and `cloud` only. `local` and `ssh`
  addresses are assigned by this application — an ephemeral port and a loopback
  port this client chose — so an address typed here would be overwritten by the
  next launch. A move drops the identity, the company list and the error — all of
  which describe the host that *was* there — and re-probes, discarding any probe
  still in flight against the old address rather than letting it answer for the
  new one. Moving onto an address another row already holds is refused, over
  `canonicalAddress` values: the same-origin row's `""`, a trailing slash,
  hostname case and a default port must not mint a second id for one host;
- **forget**, which is `removeConnection`: local to this client, closing an
  `ssh` tunnel opened for it, and confirmed — the connection id goes with it,
  and with it every scoped key underneath. Not offered for a `local` host,
  which the instance roster would re-adopt under a fresh id.

The **setup wizard is deliberately not** one of these places. It is served by a
host that is already running, so by the time anyone sees it the question has
been answered; a connector step there would be a decision that cannot be acted
on.

## Cross-cutting

### CORS is not the desktop's problem, and is everyone else's

The desktop's `ProxyTransport` issues requests from Rust, so no browser origin
is involved and no preflight happens. This is why the desktop can add any host
that answers, and the web build cannot.

The consequence for the chooser: `cloud` and `remote` are offered everywhere,
`local` and `ssh` are desktop-only, and the browser build must not render a tab
it cannot honour. `isDesktopRuntime()` is the existing predicate, already used
to decide whether the "On this computer" tab appears at all.

### Secrets go in the keychain, references go in the record

Uniformly, across all four: `crates/opencompany-app/src/keychain.rs` holds the secret and the
connection record holds a handle. The rule and its reason are already stated for
device tokens in `types.ts` — connection records are persisted and passed around
the UI, so a token in one ends up in `localStorage` and in every React devtools
inspection.

The single exception stays the carried session, which is a secret that lives in
the page because the alternative is signing in on every reload. It is bounded
by being a *session* — revocable from the host's device list, expiring on its
own — and by being chosen only where a cookie could not have worked.

### Browser-local state is still keyed by `(connection, company)`

`scopedKey` does not change, and no connector may be tempted to key on its
address instead. Two SSH tunnels to two machines that both serve `acme`, or a
cloud tenant and a laptop copy of the same company, are precisely the collisions
that key exists to prevent.

### Moving between connectors is export/import, not a toggle

The chooser picks where a *new* host lives. It does not migrate an existing
one, and the UI must not imply it does. The data root is on the machine the
runtime runs on; moving a company between connectors is the tar export/import of
the company bundle, and it belongs to the company, not to the connection.

## What has landed, and what has not

Landed:

- the `Connector` union, persisted per connection, with every older vintage of
  the profile store read forward;
- the four-tab chooser, offering `local` and `ssh` only where a process can be
  started;
- `cloud`'s waking behaviour — the retry loop, the window, and the row that
  says so;
- `ssh` end to end: the supervised tunnel roster in `crates/opencompany-app/src/ssh.rs` over
  the system `ssh`, opened from the chooser and re-opened by every probe;
- the first-host screen offering the choice rather than describing it;
- "Manage hosts": renaming, re-addressing and forgetting a connection without
  minting a new id.

Not yet:

- **the cloud front door.** Control-plane sign-in, the tenant list, and
  provisioning from the chooser, all gated on the manager exposing an
  account-scoped tenant listing. Until then the tab takes the address the
  platform gave you.
- **`remote`'s probe-before-commit and sign-in step.** Adding a gateway still
  writes the row first and discovers the typo as a red row rather than as an
  error on the chooser.
- **a tunnel roster in the UI.** `oc_ssh_tunnels` reports a tunnel that
  dropped; nothing renders it yet, so a dropped tunnel currently reads as an
  unreachable host until the next probe re-opens it.

Each of the four is a connection the console already knows how to hold. Nothing
here changes the runtime, the API, or what a host is — which is the point: the
connector is a client-side answer to a client-side question, and the day it
starts reaching into the kernel is the day it has been designed wrong.
