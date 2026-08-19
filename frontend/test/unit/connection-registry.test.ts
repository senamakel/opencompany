// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addConnection,
  adoptEmbeddedHost,
  getConnection,
  listConnections,
  probe,
  removeConnection,
  resetConnections,
  restoreConnections,
} from "@/connections/registry";
import type { Transport } from "@/api/transport";
import { findProfile, readProfiles } from "@/connections/profileStore";
import { scopedKey } from "@/connections/types";

/**
 * The connection registry, and the two properties that make it safe to key
 * everything else on.
 *
 * The console holds N hosts at once. Every browser-local key — tour progress,
 * last-read channel, mail draft, workspace migration flag — is namespaced by a
 * connection id, so these tests are really about that namespace: it must be
 * stable for one host over time, and distinct between hosts.
 */

beforeEach(() => {
  resetConnections();
  window.localStorage.clear();
});

describe("connection ids", () => {
  it("stay the same for a host across reloads", () => {
    // THE regression this store exists to prevent. Ids are minted randomly, so
    // without persistence a reload re-mints — and every scoped key moves to a
    // fresh namespace, orphaning the state silently. No error, just a console
    // with amnesia and a cause nowhere near the symptom.
    const first = addConnection({ baseUrl: "https://acme.test" });

    // A reload: the module's in-memory entries are gone, `localStorage` is not.
    resetConnections();
    const second = addConnection({ baseUrl: "https://acme.test" });

    expect(second).toBe(first);
    expect(scopedKey("oc-tour", { connection: second, company: "acme" })).toBe(
      scopedKey("oc-tour", { connection: first, company: "acme" }),
    );
  });

  it("differ between hosts, so their local state cannot collide", () => {
    const a = addConnection({ baseUrl: "https://a.test" });
    const b = addConnection({ baseUrl: "https://b.test" });

    expect(a).not.toBe(b);
    // Same company name on two hosts: the case buzz gets wrong.
    expect(scopedKey("oc-tour", { connection: a, company: "acme" })).not.toBe(
      scopedKey("oc-tour", { connection: b, company: "acme" }),
    );
  });

  it("differ per addressed company on one host", () => {
    // `?company=a` and `?company=b` against one host are two consoles, and
    // their view state should not be shared.
    const a = addConnection({ baseUrl: "https://acme.test", defaultCompany: "one" });
    const b = addConnection({ baseUrl: "https://acme.test", defaultCompany: "two" });
    expect(a).not.toBe(b);
  });

  it("never contain the scoped-key separator", () => {
    // `scopedKey` splits on `::`. An id containing it would make the split
    // ambiguous, and two different scopes could render the same key.
    for (let i = 0; i < 50; i += 1) {
      resetConnections();
      window.localStorage.clear();
      const id = addConnection({ baseUrl: `https://host-${i}.test` });
      expect(id).not.toContain(":");
    }
  });
});

describe("registering a host", () => {
  it("does not duplicate a row for one already registered", () => {
    // The web build adds its bootstrap connection from a `useMemo`, which
    // StrictMode double-invokes.
    const first = addConnection({ baseUrl: "https://acme.test" });
    const second = addConnection({ baseUrl: "https://acme.test" });

    expect(second).toBe(first);
    expect(listConnections()).toHaveLength(1);
  });

  it("normalises a trailing slash, so one host is one connection", () => {
    const bare = addConnection({ baseUrl: "https://acme.test" });
    const slashed = addConnection({ baseUrl: "https://acme.test/" });
    expect(slashed).toBe(bare);
  });

  it("starts out connecting, with nothing claimed about the host yet", () => {
    const id = addConnection({ baseUrl: "https://acme.test" });
    const connection = getConnection(id);
    expect(connection?.status).toBe("connecting");
    // `null`, not an empty identity: nothing has been asked yet, which is a
    // different thing from a host that answered with nothing.
    expect(connection?.identity).toBeNull();
    expect(connection?.companies).toEqual([]);
  });

  it("labels a host by its authority until it says otherwise", () => {
    expect(getConnection(addConnection({ baseUrl: "https://acme.test:9000" }))?.label).toBe(
      "acme.test:9000",
    );
    // Same-origin, which is how the web build is configured. Named by the
    // origin serving the page rather than by a constant: issue #1167, where two
    // such rows in the host switcher came out with identical names and only a
    // dot colour between them.
    expect(getConnection(addConnection({ baseUrl: "" }))?.label).toBe(window.location.host);
    expect(window.location.host).not.toBe("");
  });

  it("re-derives the name a version before #1167 wrote down", () => {
    // The durability half. Every console that has already run wrote "This host"
    // into `oc.connections.v1`, and a remembered label outranks a derived one —
    // so without this the indistinguishable name outlives the fix on exactly
    // the machines that reported it.
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        {
          id: "conn-legacy-origin",
          baseUrl: "",
          label: "This host",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );

    const [id] = restoreConnections();

    expect(id).toBe("conn-legacy-origin");
    expect(getConnection(id)?.label).toBe(window.location.host);
    // And written back, so the next load reads the new name rather than
    // re-deriving it forever.
    expect(findProfile("", null)?.label).toBe(window.location.host);
  });

  it("keeps a name an operator's host reported for itself", () => {
    // The rule only reaches the constant. A host that named itself, or one
    // someone typed an address for, is untouched.
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        {
          id: "conn-named",
          baseUrl: "",
          label: "Acme",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );

    expect(getConnection(restoreConnections()[0])?.label).toBe("Acme");
  });
});

/**
 * One same-origin row, not one per company ever opened here (issue #1167).
 *
 * Profiles are keyed on `(baseUrl, defaultCompany)`, so a link carrying
 * `?company=` writes a second durable profile at the *same* (empty) address.
 * Restoring all of them put an identical row in the host switcher for every
 * company ever visited — same host, same name, nothing that expired them.
 */
describe("the same-origin console", () => {
  const profiles = [
    {
      id: "conn-origin-alias",
      baseUrl: "",
      label: "This host",
      defaultCompany: null,
      credential: { kind: "cookie" },
    },
    {
      id: "conn-origin-acme",
      baseUrl: "",
      label: "This host",
      defaultCompany: "acme",
      credential: { kind: "cookie" },
    },
    {
      id: "conn-remote",
      baseUrl: "https://remote.test",
      label: "Remote",
      defaultCompany: null,
      credential: { kind: "cookie" },
    },
  ];

  beforeEach(() => {
    window.localStorage.setItem("oc.connections.v1", JSON.stringify(profiles));
  });

  it("restores only the one this page load is, plus every other host", () => {
    expect(restoreConnections(undefined, { defaultCompany: "acme" })).toEqual([
      "conn-origin-acme",
      "conn-remote",
    ]);
  });

  it("keeps the profile it skipped, so its scoped state survives", () => {
    restoreConnections(undefined, { defaultCompany: "acme" });

    // Skipped, not forgotten — the distinction `retireConnection` exists for.
    // Opening `?company=` again must land on the same connection id, because
    // every browser-local key is named after it (`scopedKey`).
    expect(findProfile("", null)?.id).toBe("conn-origin-alias");
  });

  it("restores every remembered host when the bootstrap is not same-origin", () => {
    // A desktop, or a console pointed elsewhere with `?api=`: neither makes any
    // claim about what lives at its own origin, so nothing is filtered.
    expect(restoreConnections()).toEqual([
      "conn-origin-alias",
      "conn-origin-acme",
      "conn-remote",
    ]);
  });
});

describe("persistence", () => {
  it("stores no secret, whatever credential the connection holds", () => {
    // Written to `localStorage`, which any script in the page can read. A
    // device token must live in the OS keychain, and only a handle to it here.
    addConnection({
      baseUrl: "https://acme.test",
      credential: { kind: "device", ref: "keychain-handle" },
    });
    const raw = window.localStorage.getItem("oc.connections.v1") ?? "";
    expect(raw).toContain("keychain-handle");
    expect(raw).not.toContain("oc_dev_");
  });

  it("forgets a removed host rather than resurrecting it on reload", () => {
    const id = addConnection({ baseUrl: "https://acme.test" });
    removeConnection(id);

    expect(findProfile("https://acme.test", null)).toBeUndefined();
    resetConnections();
    expect(addConnection({ baseUrl: "https://acme.test" })).not.toBe(id);
  });

  it("ignores a corrupt entry instead of registering a connection with no id", () => {
    // Hand-edited or half-written storage. An entry whose `id` is `undefined`
    // would collapse every scoped key onto one shared namespace.
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([{ baseUrl: "https://acme.test" }, "nonsense", null]),
    );
    expect(readProfiles()).toEqual([]);
    expect(addConnection({ baseUrl: "https://acme.test" })).toBeTruthy();
  });

  it("survives storage it cannot parse at all", () => {
    window.localStorage.setItem("oc.connections.v1", "{not json");
    expect(readProfiles()).toEqual([]);
  });
});

describe("credentials", () => {
  it("never writes a platform bearer to local storage", () => {
    // A platform bearer is a machine credential. It arrives in `?token=` and
    // `stripAuthParams` deletes it from the address bar immediately, so that it
    // does not linger anywhere readable — persisting it here would undo that
    // and go further, since `localStorage` has no expiry and any injected
    // script can read it.
    const token = "platform-bearer-do-not-persist";
    addConnection({
      baseUrl: "https://acme.test",
      credential: { kind: "platform", token },
    });

    expect(window.localStorage.getItem("oc.connections.v1")).not.toContain(token);
    // The kind survives as a marker — "this host authenticates as the
    // platform" — while the secret does not. The live token is re-derived from
    // the URL on the next load.
    expect(readProfiles()[0]?.credential).toEqual({ kind: "platform" });
    // In memory it is still the live credential — only the written form is
    // redacted.
    expect(getConnection(listConnections()[0].id)?.credential).toEqual({
      kind: "platform",
      token,
    });
  });

  it("re-applies the live bearer to a restored connection", () => {
    // The consequence of not persisting it, and the reason `addConnection`
    // cannot simply return early. `restoreConnections` runs first on every
    // load and can only supply what was written down; the bootstrap add that
    // follows carries the token from `?token=`. Returning the existing entry
    // without adopting it would leave the connection permanently
    // unauthenticated after one reload.
    const token = "fresh-bearer";
    const first = addConnection({
      baseUrl: "https://acme.test",
      credential: { kind: "platform", token: "stale" },
    });

    // A reload: memory is gone, storage is not.
    resetConnections();
    const restored = restoreConnections();
    expect(getConnection(restored[0])?.credential).toEqual({ kind: "platform" });

    const bootstrap = addConnection({
      baseUrl: "https://acme.test",
      credential: { kind: "platform", token },
    });
    expect(bootstrap).toBe(first);
    expect(getConnection(bootstrap)?.credential).toEqual({ kind: "platform", token });
  });

  it("leaves a device credential alone, because a ref is not a secret", () => {
    // `device.ref` names a keychain entry rather than holding the token, which
    // is the whole reason the type is shaped that way. Redacting it would lose
    // the handle and there would be nothing to look the secret up with.
    addConnection({
      baseUrl: "https://acme.test",
      credential: { kind: "device", ref: "keychain-handle-1" },
    });
    expect(readProfiles()[0]?.credential).toEqual({ kind: "device", ref: "keychain-handle-1" });
  });
});

/**
 * The host running inside this application (#615).
 *
 * The one connection whose address is *expected* to differ from last launch's:
 * it binds an ephemeral port on purpose, so recognising it the way every other
 * host is recognised — by address — read each launch as a first meeting and
 * left the previous one's row behind, dead, durable and identically labelled.
 *
 * A relaunch is modelled the way the app performs one: memory cleared,
 * `localStorage` kept, `restoreConnections` first, then the embedded host
 * arriving over IPC at whatever port the OS gave it this time.
 */
describe("the embedded host", () => {
  const INSTANCE = "0f9d8c7b6a5e4f3d2c1b0a9988776655";

  function relaunch(): void {
    resetConnections();
    restoreConnections();
  }

  it("is one row however many times the application restarts", () => {
    const first = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65145",
      instanceId: INSTANCE,
    });

    relaunch();
    const second = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65275",
      instanceId: INSTANCE,
    });
    relaunch();
    const third = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65364",
      instanceId: INSTANCE,
    });

    expect(listConnections()).toHaveLength(1);
    // The same id throughout, so the tour state, last-read channel and mail
    // draft scoped to it survive the relaunch rather than being orphaned.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(readProfiles()).toHaveLength(1);
  });

  it("follows the port it is actually listening on", () => {
    // Keeping one row is only half of it: the row that survives has to address
    // the live port, not the closed one it was restored with.
    adoptEmbeddedHost({ baseUrl: "http://127.0.0.1:65145", instanceId: INSTANCE });
    relaunch();
    const id = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65275",
      instanceId: INSTANCE,
    });

    expect(getConnection(id)?.baseUrl).toBe("http://127.0.0.1:65275");
    expect(readProfiles()[0]?.baseUrl).toBe("http://127.0.0.1:65275");
    // Re-probed rather than left showing what the old address concluded.
    expect(getConnection(id)?.status).toBe("connecting");
  });

  it("clears the rows an older version already left behind", () => {
    // The registry is durable, so fixing the accumulation is not enough on its
    // own — an existing install starts with the pile already there. This is the
    // state from the issue, verbatim: the bootstrap host plus one dead "This
    // computer" per previous launch, none of them carrying an identity because
    // no version that wrote them reported one.
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        {
          id: "5pnbp7zfx7w6",
          baseUrl: "",
          label: "This host",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
        {
          id: "vad0klxipf59",
          baseUrl: "http://127.0.0.1:65275",
          label: "This computer",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
        {
          id: "4g4392soz5vm",
          baseUrl: "http://127.0.0.1:65364",
          label: "This computer",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );

    restoreConnections();
    const id = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65401",
      instanceId: INSTANCE,
    });

    const rows = listConnections();
    expect(rows).toHaveLength(2);
    // The bootstrap connection is not this application's host and is not
    // touched — whatever else is wrong with it belongs to #613.
    expect(rows.map((c) => c.baseUrl).sort()).toEqual(["", "http://127.0.0.1:65401"]);
    // One of the orphans is adopted rather than discarded: they were all this
    // machine's host, so its scoped local state is this host's state.
    expect(["vad0klxipf59", "4g4392soz5vm"]).toContain(id);
    // And it now carries the identity, so the next launch matches on that
    // rather than on the guess that recovered it here.
    expect(readProfiles().find((p) => p.id === id)?.instanceId).toBe(INSTANCE);
  });

  it("does not hand a different instance the previous one's row", () => {
    // A second data root — `OPENCOMPANY_DATA_DIR` pointed elsewhere, say. It is
    // a different host that happens to run in the same application, and
    // adopting the row would merge two hosts' scoped local state: exactly the
    // silent mixing `types.ts` exists to prevent.
    const first = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65145",
      instanceId: INSTANCE,
    });
    relaunch();
    const second = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65275",
      instanceId: "ffffffffffffffffffffffffffffffff",
    });

    expect(second).not.toBe(first);
    // Still one row: the host this application no longer serves has no address
    // left to be reached at, so keeping its row would only re-create the bug.
    expect(listConnections()).toHaveLength(1);
  });

  it("leaves a loopback host the operator added by hand alone", () => {
    // The margin on the recovery above. Somebody running `opencompany serve` in
    // a terminal and adding it is ordinary, and deleting their connection would
    // be a worse bug than the one being fixed. They are labelled by authority,
    // never with the name this client gives its own host.
    const theirs = addConnection({ baseUrl: "http://127.0.0.1:8080" });
    expect(getConnection(theirs)?.label).toBe("127.0.0.1:8080");

    adoptEmbeddedHost({ baseUrl: "http://127.0.0.1:65145", instanceId: INSTANCE });

    expect(getConnection(theirs)).toBeDefined();
    expect(listConnections()).toHaveLength(2);
  });

  it("does not duplicate under StrictMode's double invocation", () => {
    const first = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65145",
      instanceId: INSTANCE,
    });
    const second = adoptEmbeddedHost({
      baseUrl: "http://127.0.0.1:65145",
      instanceId: INSTANCE,
    });

    expect(second).toBe(first);
    expect(listConnections()).toHaveLength(1);
  });

  it("still collapses to one row on a shell that reports no identity", () => {
    // A `pnpm dev` console against an older `cargo` build. Without an identity
    // there is nothing to match on, but the invariant — one host inside this
    // application — holds regardless, so the row is still reused rather than
    // multiplied.
    const first = adoptEmbeddedHost({ baseUrl: "http://127.0.0.1:65145" });
    relaunch();
    const second = adoptEmbeddedHost({ baseUrl: "http://127.0.0.1:65275" });

    expect(second).toBe(first);
    expect(listConnections()).toHaveLength(1);
    expect(getConnection(second)?.baseUrl).toBe("http://127.0.0.1:65275");
  });
});

/**
 * The same-origin connection, which is a host in one runtime and nothing at all
 * in the other.
 *
 * An empty base url means "the origin serving this page". A browser is served
 * by its host, so that resolves; a desktop webview is served by
 * `tauri://localhost`, where no host has ever listened. Issue #613: the desktop
 * added one anyway, selected it, and reported "couldn't reach a company host at
 * this origin" on every launch with a healthy embedded host in the same rail.
 */
describe("a same-origin profile", () => {
  const desktop = (present: boolean) => {
    // `isDesktopRuntime()` asks only whether the global is there, so presence is
    // all this needs — but it is spelled the way Tauri v2 injects it anyway, so
    // that no fixture in this tree teaches the v1 shape (#616).
    if (present) {
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
        core: { invoke: () => Promise.resolve(), Channel: class {} },
      };
    } else delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  };

  // The registry is module state, so a runtime marker left set would follow the
  // suite into the next file.
  afterEach(() => desktop(false));

  it("is dropped and forgotten when the desktop restores its hosts", () => {
    // Written by a build that added the bootstrap connection unconditionally.
    // Skipping the add is not enough on its own — this store is what brings a
    // connection back, so the dead row would return on every launch forever.
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        { id: "5pnbp7zfx7w6", baseUrl: "", label: "This host", defaultCompany: null, credential: { kind: "cookie" } },
        {
          id: "4g4392soz5vm",
          baseUrl: "http://127.0.0.1:65364",
          label: "This computer",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );
    desktop(true);

    const restored = restoreConnections();

    expect(restored).toHaveLength(1);
    expect(getConnection(restored[0])?.baseUrl).toBe("http://127.0.0.1:65364");
    // Forgotten, not merely skipped: a row nothing restores is a row nothing
    // ever removes, and this store is what someone reads to see what the
    // console holds.
    expect(readProfiles().map((p) => p.baseUrl)).toEqual(["http://127.0.0.1:65364"]);
  });

  it("takes a scheme-less host down with it, because that is what people type", () => {
    // "Add a host" does no validation, so `localhost:8080` becomes a row and is
    // written down. It joins to a relative url in Rust exactly as `""` does, and
    // without this it would be restored on every launch forever — the same
    // permanence the empty-base row had, reached by a path a person can walk.
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        {
          id: "conn-typed",
          baseUrl: "localhost:8080",
          label: "localhost:8080",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
        {
          id: "conn-real",
          baseUrl: "https://acme.example.com",
          label: "Acme",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );
    desktop(true);

    expect(restoreConnections()).toEqual(["conn-real"]);
    expect(readProfiles().map((p) => p.baseUrl)).toEqual(["https://acme.example.com"]);
  });

  it("is still a host in a browser, where the origin serves one", () => {
    // The other half of the rule, and the one that must not change: this is how
    // every web deployment finds its host.
    const id = addConnection({ baseUrl: "" });
    resetConnections();

    expect(restoreConnections()).toEqual([id]);
    expect(getConnection(id)?.label).toBe(window.location.host);
  });
});

/**
 * A credential is not sent to a host anyone on the path can read.
 *
 * Issue #731. The core is what enforces this — `may_carry_a_credential` in
 * `src-tauri/src/proxy/mod.rs`, which a console-side check cannot be a
 * substitute for, since anything invoking `oc_connect` directly bypasses this
 * module entirely. What is under test here is the *other* half: that the
 * console asks the question before it contacts anything, so the row names the
 * reason instead of reporting a network fault. The core's refusal arrives as an
 * IPC rejection that `client.ts` has already flattened into "cannot reach the
 * company host at …", which is indistinguishable from a host being switched off.
 */
describe("a credentialed host on plain http", () => {
  /** Records whether anything was sent, and answers nothing useful if it was. */
  class SilentTransport implements Transport {
    calls = 0;
    async request(): Promise<never> {
      this.calls += 1;
      throw new Error("the host answered nothing");
    }
    subscribe(): () => void {
      throw new Error("no streaming");
    }
  }

  const desktop = (present: boolean) => {
    // Presence is all `isDesktopRuntime()` asks for, but spelled the way Tauri
    // v2 injects it so no fixture in this tree teaches the v1 shape (#616).
    if (present) {
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
        core: { invoke: () => Promise.resolve(), Channel: class {} },
      };
    } else delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  };

  afterEach(() => desktop(false));

  it("is refused before a request is made, by name", async () => {
    desktop(true);
    const transport = new SilentTransport();
    const id = addConnection({
      baseUrl: "http://192.168.1.20:8080",
      credential: { kind: "device", ref: "dev-1" },
      transport,
    });

    await probe(id);

    const connection = getConnection(id);
    expect(connection?.status).toBe("down");
    // The words matter as much as the status: "could not be reached" about a
    // host that is answering fine sends an operator to debug their network.
    expect(connection?.error).toContain("not encrypted");
    // Refused *before* contact, not labelled after it. A credential that
    // travelled once has already been read.
    expect(transport.calls).toBe(0);
  });

  it("does not refuse the same host when nothing is attached", async () => {
    // The narrow rule, and its whole point: an unencrypted home-lab or staging
    // box stays readable. Nothing is exposed that a passer-by could not have
    // asked the host for themselves.
    desktop(true);
    const transport = new SilentTransport();
    const id = addConnection({ baseUrl: "http://192.168.1.20:8080", transport });

    await probe(id);

    // Down because the stub answers nothing, which is the point: it was asked.
    expect(transport.calls).toBeGreaterThan(0);
    expect(getConnection(id)?.error).not.toContain("not encrypted");
  });

  it("permits loopback and https, which is where a credential belongs", async () => {
    desktop(true);
    for (const baseUrl of [
      // The embedded host, on a port that changes every launch and so can
      // never carry a certificate.
      "http://127.0.0.1:65364",
      "http://localhost:8080",
      "https://acme.example.com",
    ]) {
      const transport = new SilentTransport();
      const id = addConnection({
        baseUrl,
        credential: { kind: "device", ref: "dev-1" },
        transport,
      });
      await probe(id);
      expect(transport.calls, `${baseUrl} must be contacted`).toBeGreaterThan(0);
      expect(getConnection(id)?.error).not.toContain("not encrypted");
    }
  });

  it("leaves the web build alone, where the credential is the browser's", async () => {
    // A cookie is the browser's to send, with `Secure` and the origin's own
    // rules doing this job. Narrowing here would refuse the plain-http
    // deployments `opencompany serve` exists for, on the transport where the
    // console is not the thing holding the secret.
    desktop(false);
    const transport = new SilentTransport();
    const id = addConnection({
      baseUrl: "http://192.168.1.20:8080",
      credential: { kind: "platform", token: "a-bearer" },
      transport,
    });

    await probe(id);

    expect(transport.calls).toBeGreaterThan(0);
    expect(getConnection(id)?.error).not.toContain("not encrypted");
  });
});
