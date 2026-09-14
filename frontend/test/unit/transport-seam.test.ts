import { afterEach, describe, expect, it } from "vitest";

import { OpenCompanyClient } from "@/api/client";
import type {
  StreamHandlers,
  Transport,
  TransportRequest,
  TransportResponse,
} from "@/api/transport";
import {
  BrowserTransport,
  ProxyTransport,
  defaultTransport,
  isAddressableBaseUrl,
  isDesktopRuntime,
  mayCarryACredential,
} from "@/api/transport";
import { ApiError } from "@/api/types";

/**
 * The transport seam's contract.
 *
 * `OpenCompanyClient` used to call `fetch` and `EventSource` directly. It now
 * calls a `Transport`, so that a desktop shell can route the same client
 * through its own core — where neither CORS nor the `SameSite=Lax` cookie rule
 * applies — without the console knowing which wire it is on.
 *
 * These are not tests of `fetch`. They pin the part a second implementation has
 * to reproduce exactly: what the client hands down, and what it does with what
 * comes back. The desktop's proxy transport is only correct if a client on top
 * of it behaves identically to one on top of the browser, and "identically"
 * means these assertions.
 */

/** Records what it was asked for and answers with whatever the test staged. */
class StubTransport implements Transport {
  /** Test double: an abort stops the caller; there is no real work to cancel. */
  readonly cancelsInFlight = true;

  readonly seen: TransportRequest[] = [];
  readonly subscribed: string[] = [];
  handlers: StreamHandlers | null = null;
  unsubscribed = 0;

  constructor(
    private readonly reply: (req: TransportRequest) => Partial<TransportResponse> | Error,
  ) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.seen.push(req);
    const staged = this.reply(req);
    if (staged instanceof Error) throw staged;
    return {
      status: staged.status ?? 200,
      statusText: staged.statusText ?? "",
      url: staged.url ?? req.url,
      text: staged.text ?? "",
      header: staged.header ?? (() => null),
    };
  }

  subscribe(url: string, handlers: StreamHandlers): () => void {
    this.subscribed.push(url);
    this.handlers = handlers;
    return () => {
      this.unsubscribed += 1;
    };
  }
}

/**
 * The `ApiError` `run` threw.
 *
 * Typed rather than a bare `.catch(e => e)`: `client.get<T>` infers `T` as
 * `unknown` when the caller does not name it, so awaiting the catch yields
 * `unknown` and every assertion below would need its own cast.
 */
async function caught(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the call to reject");
}

function clientOn(
  transport: Transport,
  config: { baseUrl?: string; company?: string | null; operatorToken?: string | null } = {},
): OpenCompanyClient {
  return new OpenCompanyClient(
    {
      baseUrl: config.baseUrl ?? "",
      company: config.company ?? null,
      operatorToken: config.operatorToken ?? null,
      sessionHeader: null,
    },
    transport,
  );
}

describe("the transport seam", () => {
  it("hands the transport a fully resolved request", async () => {
    const t = new StubTransport(() => ({ text: '{"ok":true}' }));
    const client = clientOn(t, { baseUrl: "https://host.test", operatorToken: "tok" });

    await client.post("/api/v1/company/chat", { message: "hi" });

    expect(t.seen).toHaveLength(1);
    const [req] = t.seen;
    // Absolute URL, not a base plus a path: a transport that runs in another
    // process cannot be expected to re-derive the join.
    expect(req.url).toBe("https://host.test/api/v1/company/chat");
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.authorization).toBe("Bearer tok");
    // Already serialized. The transport never sees an object to stringify, so
    // two transports cannot disagree about how a body is encoded.
    expect(req.body).toBe('{"message":"hi"}');
  });

  it("sends no content-type and no body for a bodyless request", async () => {
    const t = new StubTransport(() => ({ text: "" }));
    await clientOn(t).get("/healthz");

    const [req] = t.seen;
    expect(req.body).toBeUndefined();
    expect(req.headers["content-type"]).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
  });

  it("treats any 2xx as success and everything else as an error", async () => {
    for (const status of [200, 201, 204]) {
      const t = new StubTransport(() => ({ status, text: "" }));
      await expect(clientOn(t).get("/healthz")).resolves.toBeUndefined();
    }
    for (const status of [300, 400, 500]) {
      const t = new StubTransport(() => ({ status, text: "" }));
      await expect(clientOn(t).get("/healthz")).rejects.toBeInstanceOf(ApiError);
    }
  });

  it("reads the host's error envelope, and keeps an unrecognised body as detail", async () => {
    const enveloped = new StubTransport(() => ({
      status: 409,
      text: '{"error":"already running","code":"conflict"}',
    }));
    const err = await caught(() => clientOn(enveloped).get("/api/v1/company"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("conflict");
    expect(err.message).toBe("already running");

    // A proxy's HTML error page is the only clue to which hop gave up, so it is
    // kept rather than discarded — the property #380 established.
    const proxied = new StubTransport(() => ({
      status: 502,
      statusText: "Bad Gateway",
      text: "<html>nginx</html>",
    }));
    const gateway = await caught(() => clientOn(proxied).get("/api/v1/company"));
    expect(gateway.code).toBe("http_502");
    expect(gateway.message).toBe("Bad Gateway");
    expect(gateway.detail).toBe("<html>nginx</html>");
  });

  it("falls back to HTTP <status> when the transport reports no status text", async () => {
    // A proxy transport crossing a process boundary may not carry one; the
    // message must still say something.
    const t = new StubTransport(() => ({ status: 503, statusText: "", text: "" }));
    const err = await caught(() => clientOn(t).get("/api/v1/company"));
    expect(err.message).toBe("HTTP 503");
  });

  it("turns an unreachable host into a network_error, whatever the transport threw", async () => {
    const t = new StubTransport(() => new Error("ECONNREFUSED"));
    const err = await caught(() => clientOn(t, { baseUrl: "https://host.test" }).get("/healthz"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
    // The transport's own message is deliberately not surfaced: it is a
    // different string per transport, and this one is shown to a person.
    expect(err.message).toContain("https://host.test");
  });

  it("notifies on a 401, except from the auth routes", async () => {
    const t = new StubTransport(() => ({ status: 401, text: "" }));
    const client = clientOn(t);
    let notified = 0;
    client.onUnauthorized = () => {
      notified += 1;
    };

    await client.get("/api/v1/company").catch(() => {});
    expect(notified).toBe(1);

    // A failed sign-in 401s as its normal answer; treating that as an expired
    // session would loop the login view.
    await client.post("/api/v1/company/auth/verify", { code: "x" }).catch(() => {});
    expect(notified).toBe(1);
  });

  it("reads the document filename through the transport's header accessor", async () => {
    const t = new StubTransport(() => ({
      text: "<h1>export</h1>",
      header: (name: string) =>
        name.toLowerCase() === "content-disposition"
          ? 'attachment; filename="task-42.html"'
          : null,
    }));
    const doc = await clientOn(t).getDocument("/api/v1/company/tasks/42/export");
    expect(doc.text).toBe("<h1>export</h1>");
    expect(doc.filename).toBe("task-42.html");
  });

  it("subscribes to the addressed company's event stream", () => {
    const single = new StubTransport(() => ({}));
    clientOn(single).subscribeToEvents(null, { onMessage: () => {} });
    expect(single.subscribed).toEqual(["/api/v1/company/events"]);

    const scoped = new StubTransport(() => ({}));
    const client = clientOn(scoped, { baseUrl: "https://host.test", company: "acme" });
    const stop = client.subscribeToEvents(undefined, { onMessage: () => {} });
    expect(scoped.subscribed).toEqual(["https://host.test/api/v1/companies/acme/events"]);

    stop();
    expect(scoped.unsubscribed).toBe(1);
  });

  it("delivers stream payloads as raw text for the caller to parse", () => {
    const t = new StubTransport(() => ({}));
    const seen: string[] = [];
    clientOn(t).subscribeToEvents(null, { onMessage: (data) => seen.push(data) });

    t.handlers?.onMessage('{"type":"agent_reply"}');
    expect(seen).toEqual(['{"type":"agent_reply"}']);
  });
});

describe("picking a transport", () => {
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  });

  it("stays on the browser transport when only the internals global is present", () => {
    // The two globals answer different questions. `__TAURI_INTERNALS__` is
    // injected by the runtime unconditionally; `__TAURI__` exists only under
    // `app.withGlobalTauri`, and it is the one `tauriCore()` reads.
    // Probing the former selected a proxy transport whose every request then
    // threw "the desktop bridge is unavailable" — a desktop that could not
    // complete a single call.
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isDesktopRuntime()).toBe(false);
    expect(defaultTransport("conn-1")).toBeInstanceOf(BrowserTransport);
  });

  it("uses the proxy transport when the bridge it calls is really there", () => {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {},
      __TAURI__: { core: { invoke: () => Promise.resolve(), Channel: class {} } },
    };
    expect(isDesktopRuntime()).toBe(true);
    expect(defaultTransport("conn-1")).toBeInstanceOf(ProxyTransport);
    // No connection id: the bootstrap probe, which has no host to address yet.
    expect(defaultTransport()).toBeInstanceOf(BrowserTransport);
  });

  /**
   * Which base urls each transport can actually address.
   *
   * The same decision as the one above, and deliberately in the same place: the
   * empty base url means "same origin", which `BrowserTransport` resolves
   * against a document origin that serves a host and `ProxyTransport` hands to
   * Rust, where it joins to a *relative* url `reqwest` refuses. One string,
   * addressable in one runtime and not the other (issue #613).
   */
  it("lets a browser address anything, including its own origin", () => {
    // The web build's whole discovery mechanism. Nothing here may narrow.
    (globalThis as { window?: unknown }).window = {};
    for (const base of ["", "https://acme.test", "/api", "localhost:8080"]) {
      expect(isAddressableBaseUrl(base)).toBe(true);
    }
  });

  it("holds the desktop to an absolute http(s) host", () => {
    (globalThis as { window?: unknown }).window = {
      __TAURI__: { core: { invoke: () => Promise.resolve(), Channel: class {} } },
    };

    expect(isAddressableBaseUrl("http://127.0.0.1:65364")).toBe(true);
    expect(isAddressableBaseUrl("https://acme.example.com")).toBe(true);

    // Every one of these joins to a relative url in Rust and dies at `send()`
    // with the same opaque "could not be reached". The empty string is the one
    // #613 reported; it is not the only one, and `localhost:8080` is what a
    // person actually types into "Add a host".
    for (const relative of ["", "/", "/api/v1", "localhost:8080", "acme.example.com"]) {
      expect(isAddressableBaseUrl(relative)).toBe(false);
    }

    // Parseable is not addressable: `URL` accepts both of these, and a company
    // host is neither.
    expect(isAddressableBaseUrl("tauri://localhost")).toBe(false);
    expect(isAddressableBaseUrl("file:///Users/someone/console")).toBe(false);
  });

  /**
   * Which hosts may be sent a secret, as opposed to merely reached.
   *
   * The console's copy of `may_carry_a_credential` in
   * `crates/opencompany-app/src/proxy/mod.rs`; the Rust one enforces, this one explains. The
   * two must agree, or the console offers a connection the core will refuse —
   * which is the shape of the confusion #613 was about, and #731 asked not to
   * repeat.
   */
  it("lets a secret travel over https, or to this machine, and nowhere else", () => {
    expect(mayCarryACredential("https://acme.example.com")).toBe(true);
    // Loopback: how the embedded host is reached, on a port that changes every
    // launch and so can never have a certificate.
    expect(mayCarryACredential("http://127.0.0.1:65364")).toBe(true);
    expect(mayCarryACredential("http://127.0.0.2:8080")).toBe(true);
    expect(mayCarryACredential("http://[::1]:8080")).toBe(true);
    expect(mayCarryACredential("http://localhost:8080")).toBe(true);
    expect(mayCarryACredential("http://sub.localhost:8080")).toBe(true);

    // The hosts this exists for. A LAN is precisely where someone else is on
    // the path, so the private ranges are the target rather than an exception.
    expect(mayCarryACredential("http://192.168.1.20:8080")).toBe(false);
    expect(mayCarryACredential("http://10.0.0.4:8080")).toBe(false);
    expect(mayCarryACredential("http://acme.example.com")).toBe(false);
    // A name is not an address: either of these is a host someone else's DNS
    // answers for, and neither is this machine.
    expect(mayCarryACredential("http://localhost.acme.example.com")).toBe(false);
    expect(mayCarryACredential("http://127.0.0.1.acme.example.com")).toBe(false);
    // Not a url, and so not a host to trust with anything.
    expect(mayCarryACredential("")).toBe(false);
    expect(mayCarryACredential("acme.example.com")).toBe(false);
  });

  /**
   * A shorthand spelling of loopback is still loopback, and nothing else is.
   *
   * `URL` normalises `127.1` and `0177.0.0.1` to `127.0.0.1` before this sees
   * them — asserted because that is the parser's property rather than this
   * module's, and losing it would silently widen the rule to whatever the
   * shorthand happens to parse as.
   */
  it("reads a host as an address rather than as a string", () => {
    expect(mayCarryACredential("http://127.1:8080")).toBe(true);
    expect(mayCarryACredential("http://0177.0.0.1:8080")).toBe(true);
    expect(mayCarryACredential("http://[::ffff:127.0.0.1]:8080")).toBe(true);
    // Digits and dots are not an address. `URL` keeps this one as a name, and
    // a name that is not `localhost` resolves wherever DNS says.
    expect(mayCarryACredential("http://127.0.0.1.example.com")).toBe(false);
  });

  /**
   * The rule does not depend on the runtime, unlike its sibling above.
   *
   * `isAddressableBaseUrl` widens in a browser because a browser genuinely can
   * address its own origin. Nothing equivalent is true here: an unencrypted
   * wire is unencrypted on either transport. The web build simply does not
   * consult this — its credential is a cookie, and `Secure` is the browser's
   * own version of this decision (see `insecurelyCredentialed`).
   */
  it("answers the same in a browser as in the desktop", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(mayCarryACredential("http://192.168.1.20:8080")).toBe(false);
    (globalThis as { window?: unknown }).window = {
      __TAURI__: { core: { invoke: () => Promise.resolve(), Channel: class {} } },
    };
    expect(mayCarryACredential("http://192.168.1.20:8080")).toBe(false);
  });
});

describe("a request deadline crossing the seam", () => {
  // The desktop core applies a `reqwest` timeout the console cannot see, and
  // it was flat: 30 seconds for everything. The host deliberately allows the
  // teammate design pass 90, so every slow-but-valid design on the desktop app
  // came back as a transport failure and handed the operator the full form —
  // a refusal for a pass that was working. Only the caller knows which route
  // it is asking for, so the deadline has to ride with the request.

  it("carries a caller's deadline to the transport", async () => {
    const transport = new StubTransport(() => ({ text: "{}" }));
    const client = clientOn(transport);
    await client.post("/api/v1/company/team/design", { description: "x" }, { timeoutMs: 105_000 });
    expect(transport.seen.at(-1)!.timeoutMs).toBe(105_000);
  });

  it("sends no deadline for an ordinary mutation, so each transport keeps its own default", async () => {
    // `client.post` leaves a mutation unbounded — its duration is the host's to
    // decide — and `null` is not a number any transport can act on.
    const transport = new StubTransport(() => ({ text: "{}" }));
    const client = clientOn(transport);
    await client.post("/api/v1/company/team", { name: "Nova" });
    expect(transport.seen.at(-1)!.timeoutMs).toBeUndefined();
  });

  it("carries the read default on a GET, so the two transports agree about it", async () => {
    const transport = new StubTransport(() => ({ text: "[]" }));
    const client = clientOn(transport);
    await client.listTeam("acme");
    expect(typeof transport.seen.at(-1)!.timeoutMs).toBe("number");
  });
});

describe("graphqlRequest against a host predating the company-scoped route", () => {
  it("retries bare /graphql when the scoped route 404s", async () => {
    const t = new StubTransport((req) =>
      req.url.endsWith("/api/v1/company/graphql")
        ? { status: 404, text: "" }
        : { text: '{"data":{"company":{"id":"acme"}}}' },
    );
    const client = clientOn(t, { baseUrl: "https://host.test" });

    await expect(client.graphqlRequest("{ company { id } }")).resolves.toEqual({
      data: { company: { id: "acme" } },
    });
    expect(t.seen.map((r) => r.url)).toEqual([
      "https://host.test/api/v1/company/graphql",
      "https://host.test/graphql",
    ]);
  });

  it("carries the addressed company on the scoped attempt only", async () => {
    const t = new StubTransport((req) =>
      req.url.endsWith("/api/v1/companies/acme/graphql")
        ? { status: 404, text: "" }
        : { text: '{"data":{"company":{"id":"acme"}}}' },
    );
    const client = clientOn(t, { baseUrl: "https://host.test" });

    await client.graphqlRequest("{ company { id } }", undefined, "acme");
    expect(t.seen.map((r) => r.url)).toEqual([
      "https://host.test/api/v1/companies/acme/graphql",
      "https://host.test/graphql",
    ]);
  });

  it("does not retry a refusal that is not a 404", async () => {
    const t = new StubTransport(() => ({ status: 401, text: "" }));
    const client = clientOn(t, { baseUrl: "https://host.test" });

    await expect(client.graphqlRequest("{ company { id } }")).rejects.toMatchObject({
      status: 401,
    });
    expect(t.seen).toHaveLength(1);
  });
});
