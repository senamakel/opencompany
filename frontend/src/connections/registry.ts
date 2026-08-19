// The set of hosts this console is talking to, and their live status.
//
// A module-level store read through React 18's `useSyncExternalStore`. No state
// library, deliberately: the console has none today, and the absence of a
// global query cache is the single biggest thing protecting this refactor. A
// cache keyed on anything less than (connection, company) is exactly how two
// hosts' data gets mixed, and the way to not have that bug is to not have the
// cache.
//
// Note what is *not* here: an "active connection". Selecting a connection in
// the UI is a rendering choice, not a state change in this module — every
// connection stays probed and, later, streamed. A single-valued active
// connection is precisely what stops buzz from holding more than one relay, and
// reintroducing it here would undo the whole slice.

import { useSyncExternalStore } from "react";

import { OpenCompanyClient } from "@/api/client";
import { ApiError } from "@/api/types";
import {
  defaultTransport,
  isAddressableBaseUrl,
  isDesktopRuntime,
  mayCarryACredential,
} from "@/api/transport";
import type { Transport } from "@/api/transport";
import { forgetConnection, registerConnection } from "@/api/transport/desktop";
import {
  EMBEDDED_LABEL,
  type ConnectionProfile,
  embeddedProfiles,
  findProfile,
  forgetProfile,
  readProfiles,
  saveProfile,
} from "./profileStore";
import {
  type Connection,
  type ConnectionId,
  type ConnectionOrigin,
  type Credential,
  type InstanceIdentity,
  connectionConfig,
} from "./types";

/** The alphabet a generated connection id uses. Excludes `:` — see `scopedKey`. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function mintId(): ConnectionId {
  let out = "";
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    // Node, under the unit tests. Uniqueness within one process is all that is
    // needed there; this never runs in a browser.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

interface Entry {
  connection: Connection;
  client: OpenCompanyClient;
  /**
   * Kept beside the client because the client holds it privately, and
   * `adoptCredential` has to rebuild the client over the *same* transport — a
   * connection that silently fell back to `fetch` mid-session would bypass the
   * desktop's proxy and its CORS-free lane with it.
   */
  transport: Transport;
}

let entries: Entry[] = [];
let listeners: Array<() => void> = [];
/**
 * The snapshot handed to React.
 *
 * Cached and only replaced when something actually changes, because
 * `useSyncExternalStore` compares snapshots by identity and would loop forever
 * on a fresh array every call.
 */
let snapshot: Connection[] = [];
/**
 * Connections with a probe in flight.
 *
 * Without this, probing is self-perpetuating: `probe` sets the status to
 * `connecting`, that emits a new snapshot, and any effect watching the
 * connection list and looking for `connecting` fires again — probing forever
 * and taking the tab down with it. Making the guard a property of the registry
 * rather than of the caller means every future caller inherits it.
 */
const probing = new Set<ConnectionId>();

function emit(): void {
  snapshot = entries.map((e) => e.connection);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): Connection[] {
  return snapshot;
}

function patch(id: ConnectionId, change: Partial<Connection>): void {
  let touched = false;
  entries = entries.map((entry) => {
    if (entry.connection.id !== id) return entry;
    touched = true;
    return { ...entry, connection: { ...entry.connection, ...change } };
  });
  if (touched) emit();
}

/** Every connection, for rendering. */
export function useConnections(): Connection[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** One connection, or `undefined` once it has been removed. */
export function useConnection(id: ConnectionId | null): Connection | undefined {
  const all = useConnections();
  return id === null ? undefined : all.find((c) => c.id === id);
}

export function listConnections(): Connection[] {
  return snapshot;
}

export function getConnection(id: ConnectionId): Connection | undefined {
  return entries.find((e) => e.connection.id === id)?.connection;
}

/**
 * The client for a connection.
 *
 * One per connection and reused, so that `useEffect` dependencies keyed on the
 * client do not re-fire on every render — and so a connection's `onUnauthorized`
 * hook belongs to that connection alone.
 */
export function clientFor(id: ConnectionId): OpenCompanyClient | undefined {
  return entries.find((e) => e.connection.id === id)?.client;
}

export interface AddConnection {
  baseUrl: string;
  label?: string;
  /** The company the client addresses by default; `null` for the alias form. */
  defaultCompany?: string | null;
  credential?: Credential;
  /** Injected in tests, and by the desktop shell. */
  transport?: Transport;
  /**
   * What is already known about the host, before `/spec` is asked.
   *
   * Only the embedded host has any: this client starts it, so the core can
   * hand over its identity without a round trip. A probe replaces this with
   * the host's own fuller answer.
   */
  identity?: InstanceIdentity;
  origin?: ConnectionOrigin;
}

/**
 * Registers a host, reusing its remembered id when there is one.
 *
 * **Reuse is not a nicety.** Every browser-local key is scoped by the
 * connection id, so a freshly minted id on each page load would orphan the tour
 * state, the last-read channel and the mail draft on every reload — with no
 * error anywhere. `findProfile` is what makes the id stable for a host across
 * reloads; see `profileStore.ts`.
 *
 * Does not contact the host — call {@link probe}.
 */
export function addConnection(input: AddConnection): ConnectionId {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const defaultCompany = input.defaultCompany ?? null;
  const remembered = findProfile(baseUrl, defaultCompany);

  // Already registered this session (StrictMode double-invokes, and the web
  // build adds its bootstrap connection from a `useMemo`). Hand back the
  // existing entry rather than a duplicate row for one host.
  if (remembered) {
    const existing = entries.find((e) => e.connection.id === remembered.id);
    if (existing) {
      // A caller that brought a credential wins over whatever this entry was
      // restored with. `restoreConnections` runs first and can only supply what
      // was written down — which is never a platform bearer, by design (see
      // `profileStore.persistable`). The bootstrap add that follows carries the
      // live one from `?token=`, and returning early without taking it would
      // leave the connection permanently unauthenticated on every reload.
      if (input.credential) adoptCredential(existing.connection.id, input.credential);
      return existing.connection.id;
    }
  }

  const id = remembered?.id ?? mintId();
  const connection: Connection = {
    id,
    label: input.label ?? rememberedLabel(remembered) ?? hostLabel(baseUrl),
    baseUrl,
    defaultCompany,
    credential: input.credential ?? { kind: "cookie" },
    status: "connecting",
    identity: input.identity ?? null,
    companies: [],
    origin: input.origin,
  };
  // The desktop routes this connection through its own core; the browser
  // build keeps `fetch`. `defaultTransport` decides, so neither the registry
  // nor the client has to know which shell it is in.
  const transport = input.transport ?? defaultTransport(id);
  const client = new OpenCompanyClient(connectionConfig(connection), transport);
  // Per connection, so one host refusing this client's credential marks that
  // row and leaves the other N-1 alone. The globally-fatal version of this is
  // what made a single expired session blank the whole console.
  client.onUnauthorized = () => patch(id, { status: "unauthenticated" });
  entries = [...entries, { connection, client, transport }];
  announceToDesktop(connection);
  saveProfile(profileOf(connection));
  emit();
  return id;
}

/**
 * What of a connection outlives the session.
 *
 * One function rather than a literal at each call site, because every field
 * omitted at one of them is a field silently dropped on the next write —
 * `origin` in particular, whose whole job is to survive.
 */
function profileOf(connection: Connection): ConnectionProfile {
  return {
    id: connection.id,
    baseUrl: connection.baseUrl,
    label: connection.label,
    defaultCompany: connection.defaultCompany,
    credential: connection.credential,
    instanceId: connection.identity?.instanceId,
    origin: connection.origin,
  };
}

/**
 * Registers every host remembered from a previous session.
 *
 * Without this the profile store would only ever *stabilise the id* of a
 * connection something else re-added — so the bootstrap host would come back on
 * reload and every host the operator added by hand would quietly not. Restoring
 * is what makes "connected to N hosts" a property of the client rather than of
 * one page load.
 *
 * Idempotent: `addConnection` returns the existing entry for a host already
 * registered, so calling this alongside the bootstrap add cannot double up.
 */
/**
 * Re-points an already-registered connection at a different credential.
 *
 * The client bakes the credential in at construction (`connectionConfig` reads
 * it into `operatorToken`), so this replaces the client rather than mutating
 * one — a half-updated client that kept the old bearer for requests already
 * configured would be worse than either state.
 */
function adoptCredential(id: ConnectionId, credential: Credential): void {
  const existing = entries.find((e) => e.connection.id === id);
  if (!existing) return;
  if (sameCredential(existing.connection.credential, credential)) return;
  reseat(id, { ...existing.connection, credential });
}

/**
 * Replaces a connection's record and the client built from it.
 *
 * The client reads `baseUrl` and the credential into its config at
 * construction, so anything the config is derived from is replaced rather than
 * mutated: a half-updated client that kept the old address for requests
 * already configured would be worse than either state. The core is re-told for
 * the same reason — it resolves proxied requests against its own copy.
 */
function reseat(id: ConnectionId, connection: Connection): void {
  const existing = entries.find((e) => e.connection.id === id);
  if (!existing) return;
  const client = new OpenCompanyClient(connectionConfig(connection), existing.transport);
  client.onUnauthorized = () => patch(id, { status: "unauthenticated" });
  entries = entries.map((e) =>
    e.connection.id === id ? { connection, client, transport: existing.transport } : e,
  );
  announceToDesktop(connection);
  saveProfile(profileOf(connection));
  emit();
}

function sameCredential(a: Credential, b: Credential): boolean {
  if (a.kind !== b.kind) return false;
  // A restored profile carries `{ kind: "platform" }` with no token, so this
  // comparison is what makes the bootstrap's live token count as a change.
  if (a.kind === "platform" && b.kind === "platform") return a.token === b.token;
  if (a.kind === "device" && b.kind === "device") return a.ref === b.ref;
  // Signing in again mints a *new* session, so the values differ and the client
  // has to be rebuilt around the new one. Comparing only the kind here would
  // leave the console presenting the session it just replaced — which keeps
  // working until the old one expires or is revoked, making it the kind of bug
  // that surfaces an hour later and nowhere near its cause.
  if (a.kind === "session" && b.kind === "session") return a.value === b.value;
  return true;
}

/**
 * The same-origin console this page load *is*.
 *
 * Passed by `App` when the bootstrap host is the origin serving the bundle,
 * which is every ordinary web deployment. Absent in the desktop, where a
 * same-origin profile is unreachable and dropped outright by
 * {@link keepIfReachable}, and in a console pointed elsewhere with `?api=`,
 * which makes no claim about what lives at its own origin.
 */
export interface SameOriginConsole {
  /** What `?company=` names on this load; `null` for the alias form. */
  defaultCompany: string | null;
}

export function restoreConnections(
  transport?: Transport,
  sameOrigin?: SameOriginConsole,
): ConnectionId[] {
  return readProfiles()
    .filter(keepIfReachable)
    .filter((profile) => isThisConsole(profile, sameOrigin))
    .map((profile) =>
      addConnection({
        baseUrl: profile.baseUrl,
        label: rememberedLabel(profile),
        defaultCompany: profile.defaultCompany,
        credential: profile.credential,
        identity: profile.instanceId ? { instanceId: profile.instanceId } : undefined,
        origin: profile.origin,
        transport,
      }),
    );
}

/**
 * Drops a stored profile this runtime could never reach, and forgets it.
 *
 * There is exactly one such profile in practice: the same-origin entry a
 * desktop build wrote before it stopped adding one (issue #613). Not adding it
 * any more is not enough on its own — this store is what brings a connection
 * back, so the dead row would be restored on every launch forever, and it sorts
 * ahead of the embedded host because it was written first.
 *
 * Forgotten rather than merely skipped: a row the console refuses to restore is
 * a row nothing will ever remove, and `oc.connections.v1` is a registry people
 * read when a host misbehaves. It should say what the console holds.
 */
function keepIfReachable(profile: ConnectionProfile): boolean {
  if (isAddressableBaseUrl(profile.baseUrl)) return true;
  forgetProfile(profile.id);
  return false;
}

/**
 * Whether a same-origin profile is *this* page load's console, or a past one.
 *
 * The second half of issue #1167, and the reason the duplicate row existed at
 * all. Profiles are keyed on `(baseUrl, defaultCompany)` — deliberately, so
 * `?company=a` and `?company=b` keep their view state apart (`findProfile`) —
 * but the empty base url is one host, whichever company a link named. So every
 * distinct `?company=` ever opened against this origin left a durable profile
 * behind, and this function is what used to bring all of them back: one row per
 * company ever visited, all at the same address, all with the same name, and
 * nothing that ever expired them.
 *
 * They are not extra hosts. A connection already carries every company its host
 * serves, and `switchCompany` moves between them *inside* one console
 * (`ConnectionConsole.tsx`) — so a second row for the same origin offers an
 * operator a choice that changes nothing but which of two identical rows is
 * ticked.
 *
 * Skipped rather than forgotten, which is the distinction `retireConnection`
 * exists for: the profile stays, so opening `?company=b` again lands on the
 * same connection id and the same scoped state (`scopedKey`) rather than a
 * freshly minted one.
 */
function isThisConsole(
  profile: ConnectionProfile,
  sameOrigin: SameOriginConsole | undefined,
): boolean {
  if (sameOrigin === undefined) return true;
  if (profile.baseUrl !== "") return true;
  return profile.defaultCompany === sameOrigin.defaultCompany;
}

/** Where a host running inside this application is, and who it is. */
export interface EmbeddedHostInfo {
  baseUrl: string;
  /** Absent only on a shell predating `instance_id` on `oc_embedded`. */
  instanceId?: string;
  /**
   * What to call it, when the core has a name from the operator.
   *
   * Absent for the host at the data root, which keeps {@link EMBEDDED_LABEL} —
   * and absent from a shell predating the roster, which has only that one.
   */
  label?: string;
  /** Injected in tests. */
  transport?: Transport;
}

/**
 * Registers the host running inside this application, of which there is one.
 *
 * Not `addConnection`, and the difference is the whole fix (#615). The embedded
 * host binds an ephemeral port on purpose — a fixed one collides with a dev
 * server — so its address is different on every launch, while `addConnection`
 * recognises a host *by* its address. Each launch therefore looked like a first
 * meeting: a new id, a new row, and last launch's row left behind pointing at a
 * closed port. They are durable, so they accumulated, and they carry the same
 * label as the live one — leaving an operator a sidebar of identical entries,
 * all but one broken, with nothing to tell them apart.
 *
 * So this matches on identity instead, and enforces the invariant the type
 * states: at most one embedded connection exists at a time.
 *
 * Reusing the remembered id rather than minting a fresh one is what carries the
 * tour state, the last-read channel and the mail draft across a relaunch — all
 * of them keyed by connection id (see `scopedKey`).
 */
export function adoptEmbeddedHost(host: EmbeddedHostInfo): ConnectionId {
  return adoptLocalHosts([host])[0];
}

/**
 * Registers every host running inside this application, and drops the rest.
 *
 * The generalisation of {@link adoptEmbeddedHost} to a machine running more
 * than one instance, and the reason the pruning could not stay where it was:
 * the single-host version treated *any other* embedded profile as last
 * launch's dead row and removed it. With a roster, another embedded profile is
 * ordinarily the operator's second company — so the set has to be pruned
 * against the set, not against one member of it.
 *
 * Kept as one call rather than a loop of {@link adoptEmbeddedHost} for exactly
 * that reason: the prune needs to see every live instance before it removes
 * anything, and N calls each see one.
 *
 * A **stopped** instance is not passed as a host — it has no address, so a
 * connection for it could only sit in the rail failing its probe. But its id
 * must still be passed in `knownInstanceIds`, and the difference is the whole
 * of the second bug this signature exists to prevent.
 *
 * `removeConnection` forgets the *persisted profile*, and a connection id is
 * what every browser-local key is scoped by (see `scopedKey`). So pruning a
 * stopped instance as though it were a ghost means its tour state, last-read
 * channel and mail draft are orphaned the moment it is stopped, and it comes
 * back from a restart wearing a freshly minted id — #615 again, reached by
 * pressing Stop instead of by relaunching.
 *
 * A stopped instance therefore has its live entry retired and its profile
 * kept: no row in the rail, no lost namespace. Only a profile matching *no*
 * instance the core knows about is a genuine ghost, and only that is forgotten.
 */
export function adoptLocalHosts(
  hosts: EmbeddedHostInfo[],
  /**
   * Every instance the core holds, running or not.
   *
   * Defaulted to the running set so a caller that passes one argument keeps
   * the old meaning — but `App` always passes the whole roster, because the
   * running set alone cannot tell "stopped" from "gone".
   */
  knownInstanceIds: readonly string[] = hosts
    .map((host) => host.instanceId)
    .filter((id): id is string => id !== undefined),
): ConnectionId[] {
  const known = embeddedProfiles();
  const rostered = new Set(knownInstanceIds);
  // Matched first, all of them, before anything is removed. `thisHost` falls
  // back to an id-less profile — the one an older version wrote — and two
  // hosts must not both adopt it, or two connections share one namespace.
  const claimed = new Set<ConnectionId>();
  const mine = hosts.map((host) => {
    const match = thisHost(
      known.filter((profile) => !claimed.has(profile.id)),
      host.instanceId,
    );
    if (match) claimed.add(match.id);
    return match;
  });

  for (const profile of known) {
    if (claimed.has(profile.id)) continue;
    if (profile.instanceId !== undefined && rostered.has(profile.instanceId)) {
      // A stopped instance. Its entry goes — nothing is listening, and a row
      // that cannot answer is the dead row this whole function exists to
      // prevent — but its profile stays, so starting it again lands on the
      // same connection id and the same scoped state.
      retireConnection(profile.id);
      continue;
    }
    // A genuine ghost: a previous launch's address, or a data root this
    // application no longer serves. Nothing is listening there and nothing
    // ever will be again, so it is dropped rather than left failing its probe
    // in the rail forever.
    removeConnection(profile.id);
  }

  return hosts.map((host, index) => adoptOne(host, mine[index]));
}

function adoptOne(
  host: EmbeddedHostInfo,
  mine: ConnectionProfile | undefined,
): ConnectionId {
  const baseUrl = host.baseUrl.replace(/\/$/, "");
  const identity = host.instanceId ? { instanceId: host.instanceId } : undefined;

  if (mine) {
    const registered = entries.find((e) => e.connection.id === mine.id);
    if (registered) {
      // `restoreConnections` already put it back at last launch's address.
      return reseatEmbedded(registered.connection, baseUrl, identity, host.label);
    }
    // Not registered this session. Write the new address down first, so the
    // `addConnection` below finds this profile by it and reuses the id.
    saveProfile({
      ...mine,
      baseUrl,
      label: host.label ?? mine.label,
      instanceId: host.instanceId ?? mine.instanceId,
    });
  }

  return addConnection({
    baseUrl,
    // The core's name wins over the remembered one: renaming an instance
    // happens there, and a stale label in `localStorage` would quietly outrank
    // it forever.
    label: host.label ?? mine?.label ?? EMBEDDED_LABEL,
    identity,
    origin: "embedded",
    transport: host.transport,
  });
}

/**
 * Which remembered profile, if any, is the instance now running.
 *
 * Identity decides when both ends know it: a *different* id at this address is
 * a different host — a second data root, say — and adopting its row would merge
 * two hosts' local state, which is the failure `types.ts` exists to prevent.
 *
 * A profile with no id recorded is one an older version wrote, before the core
 * reported one. There is nothing to compare, and this application had exactly
 * one embedded host then too, so it is adopted rather than orphaned.
 */
function thisHost(
  known: ConnectionProfile[],
  instanceId: string | undefined,
): ConnectionProfile | undefined {
  const byIdentity =
    instanceId === undefined
      ? undefined
      : known.find((p) => p.instanceId === instanceId);
  return byIdentity ?? known.find((p) => p.instanceId === undefined);
}

/** Moves a registered embedded connection to the address it is now serving. */
function reseatEmbedded(
  connection: Connection,
  baseUrl: string,
  identity: InstanceIdentity | undefined,
  label?: string,
): ConnectionId {
  if (
    connection.baseUrl === baseUrl &&
    connection.origin === "embedded" &&
    (label === undefined || connection.label === label)
  ) {
    // The same host at the same address: a second call in one session, which
    // StrictMode guarantees. Re-seating would throw away a probe in flight.
    return connection.id;
  }
  reseat(connection.id, {
    ...connection,
    baseUrl,
    label: label ?? connection.label,
    origin: "embedded",
    identity: identity ?? connection.identity,
    // Whatever the last probe concluded, it concluded about the old address.
    status: "connecting",
    error: undefined,
  });
  return connection.id;
}

/**
 * Tells the desktop core about a connection, so its proxy can address it.
 *
 * A no-op in a browser. Registration is awaited by `ProxyTransport` rather than
 * here, because `addConnection` is synchronous — React renders off its return
 * value — and blocking it on an IPC round trip would stall the first paint on
 * every host.
 *
 * A `device` credential is not forwarded: its `ref` names a keychain entry and
 * nothing resolves one yet, so passing the handle through as if it were a token
 * would authenticate as the literal string "keychain-handle". Such a connection
 * registers unauthenticated and the host answers 401, which the row already
 * renders.
 */
function announceToDesktop(connection: Connection): void {
  if (!isDesktopRuntime()) return;
  void registerConnection(
    connection.id,
    connection.baseUrl,
    connection.credential.kind === "platform" && connection.credential.token
      ? { platformToken: connection.credential.token }
      : {},
  );
}

/**
 * Records that this machine now holds a paired device session for `id`.
 *
 * The `ref` is the device id the host minted — a name for the pairing, useful
 * when someone is looking at the host's device list deciding what to revoke. It
 * is emphatically not the credential: the core resolves the session from the
 * keychain by connection id, and this record only says that one exists.
 */
export function pairedConnection(id: ConnectionId, deviceId: string): void {
  adoptCredential(id, { kind: "device", ref: deviceId });
}

/** Forgets a pairing locally. The host's session record is untouched. */
export function unpairConnection(id: ConnectionId): void {
  adoptCredential(id, { kind: "cookie" });
}

/**
 * Records the session a cross-origin sign-in just returned.
 *
 * Called with the `session` from a {@link SignIn}, and it must be called or the
 * sign-in is wasted: the host returns that token exactly once, keeps only its
 * hash, and — because no cookie was set — the console has no other way to prove
 * who it is. The symptom of forgetting is a login that appears to succeed and a
 * console that is anonymous from the next request onward.
 *
 * Replaces the client, through `adoptCredential`, so every request after this
 * carries the new session rather than the one it was constructed with.
 */
export function adoptSession(id: ConnectionId, session: string): void {
  adoptCredential(id, { kind: "session", value: session });
}

export function removeConnection(id: ConnectionId): void {
  entries = entries.filter((e) => e.connection.id !== id);
  forgetProfile(id);
  if (isDesktopRuntime()) forgetConnection(id);
  emit();
}

/**
 * Drops a connection from this session **without forgetting who it was.**
 *
 * The difference from {@link removeConnection} is one line — `forgetProfile` —
 * and it is the difference between "this host is gone" and "this host is not
 * running right now". A stopped local instance is the second: there is nothing
 * to talk to, so it must not hold a row, but it still owns a connection id
 * that every `scopedKey` under it is named after.
 */
function retireConnection(id: ConnectionId): void {
  const present = entries.some((e) => e.connection.id === id);
  if (!present) return;
  entries = entries.filter((e) => e.connection.id !== id);
  if (isDesktopRuntime()) forgetConnection(id);
  emit();
}

/** Drops every connection. Tests only — the app never empties the registry. */
export function resetConnections(): void {
  entries = [];
  probing.clear();
  emit();
}

/**
 * Contacts a host and records what it found.
 *
 * This is `App`'s old `boot()`, moved here so that discovering the second host
 * is the same code as discovering the first. It resolves rather than throws:
 * a connection that cannot be reached is a *state*, not an exception, because
 * the other connections carry on regardless.
 */
export async function probe(id: ConnectionId): Promise<void> {
  const client = clientFor(id);
  if (!client || probing.has(id)) return;
  const insecure = insecurelyCredentialed(getConnection(id));
  if (insecure) {
    // Refused here rather than left to fail at the core, because this is the
    // one function that owns a row's status — and the core's refusal arrives
    // as an IPC rejection that `client.ts` has already flattened into "cannot
    // reach the company host". Saying it here is what makes the row name the
    // reason instead of blaming a network that is working (issue #731).
    patch(id, { status: "down", error: insecure });
    return;
  }
  probing.add(id);
  patch(id, { status: "connecting", error: undefined });
  try {
    await runProbe(id, client);
  } finally {
    probing.delete(id);
  }
}

async function runProbe(id: ConnectionId, client: OpenCompanyClient): Promise<void> {

  const identity = await readIdentity(client);
  if (identity) patch(id, { identity, label: identity.displayName ?? labelOf(id) });

  try {
    const companies = await client.listCompanies();
    patch(id, { status: "live", companies: companies.map((c) => c.id) });
    return;
  } catch (listErr) {
    // A single-company (prosumer) host has no `/api/v1/companies`; its sole
    // company answers on the alias instead. Falling back rather than failing is
    // what lets one client hold a platform host and a prosumer host at once.
    try {
      await client.status(null);
      patch(id, { status: "live", companies: [] });
      return;
    } catch (statusErr) {
      patch(id, statusFromError(statusErr ?? listErr));
    }
  }
}

/** Reads `/spec`, tolerating a host that has no identity fields yet. */
async function readIdentity(client: OpenCompanyClient): Promise<InstanceIdentity | null> {
  try {
    const spec = await client.get<Record<string, unknown>>("/spec");
    return {
      instanceId: typeof spec.instance_id === "string" ? spec.instance_id : undefined,
      displayName: typeof spec.display_name === "string" ? spec.display_name : undefined,
      // `undefined` is meaningfully different from `[]`: an older host omits
      // the field, and the client must read that as "assume REST only" rather
      // than as "supports nothing".
      capabilities: Array.isArray(spec.capabilities)
        ? (spec.capabilities as string[])
        : undefined,
      storage: typeof spec.storage === "string" ? spec.storage : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Why this connection must not be contacted, or `null` when it may be.
 *
 * A credential over plain HTTP to a host that is not this machine, which the
 * core refuses at registration (`may_carry_a_credential`). Answering the same
 * question here is what turns that refusal into something a person can act on;
 * see the note on `mayCarryACredential`.
 *
 * Desktop only **for the ambient credentials**. A browser's cookie is one the
 * browser decides about, with `Secure` and the origin's own rules doing this
 * job — narrowing the web build there would refuse the plain-HTTP deployments
 * `opencompany serve` is built for, on the transport where the console is not
 * the thing holding the secret.
 *
 * A `session` credential is the exception, and gated everywhere: a hub console
 * holds that token itself and puts it on the wire itself, so "the browser is
 * deciding" stops being true. The runtime it happens to run in changes nothing
 * about what an unencrypted hop exposes.
 *
 * Read off the profile's credential *kind*, which is a claim about this machine
 * rather than the secret itself: a `device` entry means the keychain holds a
 * session the core will attach, and `platform` with a token means one arrived
 * in the url. `cookie` and a token-less `platform` carry nothing, so a host
 * added by hand and read anonymously stays permitted — the whole point of
 * gating on the credential rather than on the scheme.
 */
function insecurelyCredentialed(connection: Connection | undefined): string | null {
  if (!connection) return null;
  // A same-origin connection is the browser's own origin, whose rules already
  // decide this; there is no url to judge and nothing to protect it from that
  // is not already inside the page.
  if (connection.baseUrl === "") return null;
  // A session is a secret **this page holds and sends**, in every runtime — so
  // unlike the two below it is gated in the browser as well. The exposure is
  // identical to the desktop's: a person's standing authority on a company,
  // travelling in clear text past every device on the path.
  const carriesInAnyRuntime = connection.credential.kind === "session";
  const carriesOnDesktop =
    isDesktopRuntime() &&
    (connection.credential.kind === "device" ||
      (connection.credential.kind === "platform" && Boolean(connection.credential.token)));
  if (!carriesInAnyRuntime && !carriesOnDesktop) return null;
  if (mayCarryACredential(connection.baseUrl)) return null;
  // Names the credential generically: this covers a paired device session and a
  // platform bearer from `?token=`, and the person reading it needs the reason
  // rather than which of the two it was.
  return `${connection.baseUrl} is not encrypted, so this connection's credential cannot be sent to it. Use https, or a host on this machine.`;
}

function statusFromError(err: unknown): Partial<Connection> {
  if (err instanceof ApiError && err.status === 401) {
    return { status: "unauthenticated", error: "this host refused the credential" };
  }
  const message = err instanceof ApiError ? err.message : "could not be reached";
  return { status: "down", error: message };
}

function labelOf(id: ConnectionId): string {
  return getConnection(id)?.label ?? id;
}

/**
 * The name every same-origin connection used to carry, and no longer earns.
 *
 * Kept as a constant because two things still need to recognise it: the
 * fallback below, for a runtime with no address to read, and
 * {@link rememberedLabel}, which has to spot it in a profile written before
 * issue #1167 and re-derive rather than restore it.
 */
export const SAME_ORIGIN_LABEL = "This host";

/**
 * A readable name for a host before it has told us its own.
 *
 * A same-origin host has no url of its own to read, and naming it by a constant
 * is the whole of issue #1167: *every* such connection came out with the same
 * name, so a console holding two offered an operator two identical rows in the
 * host switcher with nothing but the hue of a status dot between them — the
 * failure `adoptLocalHosts` above was written to end, resurfacing somewhere a
 * position and a hover title no longer make up for it.
 *
 * The origin serving this page is what the connection actually addresses, so it
 * is both distinguishing and honest. "This host" is only ever true of one row,
 * and survives here solely for a runtime with no location to read — Node, under
 * the unit tests — where a label is still required and there is nothing better.
 */
export function hostLabel(baseUrl: string): string {
  if (!baseUrl) return sameOriginLabel();
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function sameOriginLabel(): string {
  const host = typeof window === "undefined" ? "" : (window.location?.host ?? "");
  return host || SAME_ORIGIN_LABEL;
}

/**
 * The remembered name for a host, or `undefined` when it is not worth keeping.
 *
 * Installs are durable, so dropping the constant from {@link hostLabel} does
 * nothing on its own: every console that has already run wrote "This host" into
 * `oc.connections.v1`, and a remembered label outranks a derived one — so the
 * indistinguishable name would outlive the fix on exactly the machines that
 * reported it. A profile still carrying it is therefore treated as carrying
 * none. Only the same-origin row is treated this way; a host someone typed is
 * named by its address and could never have been given this label.
 */
function rememberedLabel(profile: ConnectionProfile | undefined): string | undefined {
  if (!profile) return undefined;
  if (profile.baseUrl === "" && profile.label === SAME_ORIGIN_LABEL) return undefined;
  return profile.label;
}
