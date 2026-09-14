# Desktop hosts and authentication

## Several hosts on one machine

The desktop runs a roster of local hosts rather than exactly one, so an
operator can keep two companies side by side on one machine. How the roster is
stored, which empty root gets a starter company and which gets the first-run
wizard, and how to run the shell in development are in
[`desktop-instances.md`](desktop-instances.md).

### One row, however many launches

The ephemeral port is not free: it means the embedded host's *address* is
different on every launch, and `addConnection` recognises a host by address. So
each launch read as a first meeting — a new connection id, a new row, and the
previous launch's row left behind pointing at a closed port. They persist, so
they accumulated, and they all carry the same label; the sidebar filled with
indistinguishable "This computer" entries, all but one broken (issue #615).

Every local host therefore reports `instance_id`, read from the data root
(see [`instance.rs`](../../../src/app/instance.rs)) rather than derived from the
address, and the console registers them through `adoptLocalHosts` rather than
`addConnection`. That function matches each running instance on its identity,
re-points the remembered connection at the new port, and drops the profiles no
running instance claimed.

It takes the whole set in one call for a reason the single-host version could
not survive. `adoptEmbeddedHost` dropped *any other* embedded profile as last
launch's ghost — and with a roster, another embedded profile is ordinarily the
operator's second company. The prune has to see every live instance before it
removes anything, so it is one call rather than a loop of them.
`adoptEmbeddedHost` remains as the one-host wrapper for the degrade above.

Only **running** instances become connections. A stopped one has no address, so
a row for it could do nothing but fail its probe forever; it is visible — and
startable — on the "Add a host" screen instead.

Reusing the remembered id is what carries the tour state, the last-read channel
and the mail draft across a relaunch, all of them keyed by connection id. A
*different* `instance_id` — a second data root — is deliberately not adopted:
that is a different host, and merging its local state is the failure the
`(connection, company)` namespace exists to prevent.

Profiles written before the identity was reported carry neither it nor an
`origin` marker, so `embeddedProfiles` recognises them by the signature the bug
left: this client's own label for its host, at a loopback address. Narrow on
purpose — a host an operator added by hand is labelled by authority
(`127.0.0.1:8080`), never with that string.

### Which host the address names

Selection is a **filter over N live things** — choosing a host changes what is
rendered and tears nothing down — but it is not private state. A console holding
more than one host scopes its hash: `#/ledgers/tasks?host=<connectionId>`.

Three things follow, and each was a defect without it (issue #1358):

- **Back undoes a switch.** Selection used to be plain React state, so nothing
  was pushed and the most natural recovery from "I picked the wrong host and it
  is down" did nothing at all.
- **The address stops lying.** The hash used to keep naming a page of the host
  you had just left for the whole time the failed host's "Can't connect" screen
  was up.
- **Nothing rewinds silently.** Those two combined into the symptom that was
  actually reported: a Back pressed on the error screen popped an entry
  belonging to the *working* host. Its console is not mounted, so no pixel
  changed — and switching back landed two pages shallower than where the
  operator had been, with nothing having told them.

One host writes no scope. There is nothing ambiguous about its address, and
connection ids are minted per client, so an opaque id in a copied link means
nothing to whoever receives it. The scope appears with the second host, and
`selectHost` stamps the entry being left on the way out so even the first switch
is undoable.

The scope is a *scope*, not a page, so a view change carries it and the
transient hash flags (`?new`, see `use-hash-flag.ts`) do not. Writers that
replace the hash wholesale must carry it themselves — a `replaceState` fires no
`hashchange`, so there is no event to repair it on; `useHostAddress` covers the
writers that merely assign.

An address naming a connection this client no longer holds is not an error: it
resolves to whatever `App` would otherwise have opened, and the bar is corrected
to say so.

### What a failure may say

A host that cannot be reached renders its own full-screen error, with the
switcher over it. What that screen says depends on how many hosts this console
holds, because the two situations are not the same one.

Alone, it keeps the boot hint — *set the host with `?api=`, or run `opencompany
serve`* — which is advice for a console that has not found its host yet. With a
roster, that hint tells somebody who picked a row out of a switcher to configure
a host they already configured, so it is dropped, and **Forget this host** is
offered beside Retry instead. Forgetting is local to this client (see
`removeConnection`); it is never offered for the only host, because a console
with no connections at all is a worse place to be left than one with a host that
is down.

## Authenticating as a person

**About remote hosts.** The embedded host on this machine has no sign-in to
authenticate to at all — see [no sign-in at all](#no-sign-in-at-all) — so
everything below is about the other connections in the switcher: a colleague's
server, a hosted tenant, anything the desktop is a *client* of.

A desktop cannot hold a session cookie: `SameSite=Lax` means the browser never
sends one cross-site, and a webview is cross-site with every server. The only
other header credential was the platform bearer, which maps to `actor: None` —
every write anonymous in the journal.

So a session has a second carrier, documented in [`users.md`](users.md) →
"Two carriers, one session". Getting one is the client's own business: device
pairing left the host with the rest of the device routes.

The token lives in the OS keychain (`crates/opencompany-app/src/keychain.rs`), and the
console never sees it. `oc_connect` takes no device material: the core resolves
a paired session by connection id. Pairing runs entirely in Rust —
`oc_pair_device` performs the claim, writes the result to the keychain, and
answers with the company, device id and expiry — so the token exists for one
HTTP response that the webview is not on the path of. That is the difference
between a design where the webview *should not* hold the credential and one
where it *cannot*. The claim itself is a plain `claim()` rather than command
logic, so the rules on it can be tested without starting a GUI — see "Where a
credential may travel" for the one it enforces.

The console's `Credential { kind: "device", ref }` is therefore a record that
this machine is paired, not something the core is told. `ref` is the host's
device id, useful when deciding what to revoke from the host's device list.

Backend selection, the test store, and the Linux session-keyring caveat (a
pairing there does not survive a logout) are documented in the module.

## ACP

`crates/opencompany-app/src/acp/` is the client half: it spawns a locally-installed harness
over stdio and serves the `fs/read_text_file` and `fs/write_text_file` methods
the agent calls back with. Path confinement is enforced in Rust, below the UI —
the console renders the permission prompt but must never be the thing that
enforces the answer. A renderer decides what a person sees; it must not decide
what a model can reach.

The server half (`src/server/acp/`) is behind the `acp` feature and mounts the
authenticated HTTP JSON-RPC transport at `/acp` — the endpoint and its session
model are described in `src/server/acp/mod.rs`. `/acp` is a reserved prefix
either way, so a build without the feature answers a protocol probe with a 404
rather than the console shell with a `200`.
