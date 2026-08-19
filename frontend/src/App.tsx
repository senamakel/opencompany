import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";

import { signInWithHubToken, verifyCode } from "@/api/auth";
import { isAddressableBaseUrl, isDesktopRuntime } from "@/api/transport";
import {
  createLocalInstance,
  embeddedHost,
  localInstances,
  startLocalInstance,
  stopLocalInstance,
  type LocalInstance,
} from "@/api/transport/desktop";
import { ApiError } from "@/api/types";
import { AddHostDialog, ConsoleChrome } from "@/components/host-switcher";
import { resolveConfig } from "@/config";
import {
  addConnection,
  adoptLocalHosts,
  clientFor,
  listConnections,
  probe,
  restoreConnections,
  useConnections,
} from "@/connections/registry";
import { HostsProvider, type HostsValue } from "@/connections/HostsContext";
import type { ConnectionId } from "@/connections/types";
import { ConnectionConsole } from "@/views/ConnectionConsole";

/**
 * Reads `?company=&code=` off a magic-link landing.
 *
 * **Pure.** It must stay that way: this runs in a `useMemo`, and StrictMode
 * double-invokes those. Stripping the URL here — as this once did — meant the
 * second invocation read an already-cleaned URL and returned nothing, silently
 * dropping the code and the company. Clearing is a side effect, so it lives in
 * an effect: see `clearMagicLinkFromUrl`.
 */
function readMagicLink(): { company: string | null; code: string } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;
  return { company: params.get("company"), code };
}

/**
 * Reads `?token=&key=auth` off a hub sign-in landing.
 *
 * The hub appends these to the redirect URI it was given, so they arrive on a
 * plain top-level navigation back to this console. `key=auth` is the hub's own
 * marker for that redirect and is what distinguishes this token from the
 * `?token=` the console config uses for a platform bearer — see `config.ts`.
 *
 * **Pure**, for the same reason `readMagicLink` is: StrictMode double-invokes
 * the `useMemo` this runs in, so stripping the URL here would make the second
 * invocation read a cleaned URL and silently drop the token.
 *
 * A failed sign-in comes back as `?error=` instead, which is not read here —
 * the hub's error text is its own wording about its own flow, and this console
 * says its piece in `hubNotice`.
 */
function readHubToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("key") !== "auth") return null;
  return params.get("token");
}

/** Whether the hub bounced the sign-in back with a failure rather than a token. */
function readHubError(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("key") === "auth" && params.get("error") !== null;
}

/**
 * Strips the magic link out of the address bar.
 *
 * The code is a single-use credential, so it must not linger in the URL, the
 * history, or a `Referer` header once we hold it.
 */
function clearMagicLinkFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code")) return;
  params.delete("code");
  params.delete("company");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
}

/**
 * Strips the hub's sign-in result out of the address bar.
 *
 * `replaceState` rather than a push, so the token is gone from the history
 * entry as well as from the bar — a back button that restored it would hand a
 * live ecosystem credential to a reload, and a `Referer` carrying it would hand
 * it to whatever the console links out to next.
 *
 * `company` is deliberately kept. It is not a credential, and dropping it would
 * un-scope the console on a reload of a multi-company host.
 */
function clearHubResultFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get("key") !== "auth") return;
  params.delete("token");
  params.delete("error");
  params.delete("key");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
}

/**
 * The styleguide answers before anything else does.
 *
 * It reads no company and holds no client — it renders the stylesheet and
 * nothing else — so putting it behind the sign-in gate would only mean that
 * reviewing the design system required credentials for a running host. This
 * way `#/styleguide` works against any build, including a static one.
 *
 * Checked before `resolveConfig()` so a console with no reachable host still
 * serves it.
 */
function isStyleguideRoute(): boolean {
  return window.location.hash.replace(/^#\/?/, "").split("?")[0] === "styleguide";
}

export function App() {
  /**
   * Tracked rather than read once, so `#/styleguide` typed into the address
   * bar of a *running* console switches to it. Without the listener the shell
   * below would keep the screen, and its own router — which does not know
   * this route — would canonicalize the unknown hash straight back to
   * `#/overview`, making the styleguide reachable only by a full reload.
   */
  const [styleguide, setStyleguide] = useState(isStyleguideRoute);
  useEffect(() => {
    const onHash = () => setStyleguide(isStyleguideRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (styleguide) {
    return (
      <Suspense fallback={null}>
        <StandaloneStyleguide />
      </Suspense>
    );
  }
  return <Console />;
}

const StandaloneStyleguide = lazy(() =>
  import("@/views/StyleguideView").then((m) => ({ default: m.StyleguideView })),
);

function Console() {
  const config = useMemo(() => resolveConfig(), []);
  /**
   * The bootstrap connection.
   *
   * The web build resolves exactly one, from the same `resolveConfig()` it
   * always did — nothing about how a browser finds its host has changed. What
   * changed is that the host is now a *record* rather than an implicit global,
   * so a second one is an addition rather than a rewrite.
   */
  const bootstrapId = useMemo(
    () => {
      // Hosts added in a previous session come back first, so the bootstrap add
      // below finds its own profile already registered and reuses that entry
      // rather than creating a duplicate row for one host.
      //
      // Told which same-origin console this load is, so the rows a *previous*
      // one left behind stay out of the switcher. A link carrying `?company=`
      // writes its own profile at the same (empty) address, so restoring every
      // one of them put an identical row in the menu for every company ever
      // opened here — issue #1167. Only when the bootstrap is same-origin: a
      // console pointed elsewhere with `?api=` claims nothing about what lives
      // at its own origin.
      restoreConnections(
        undefined,
        config.baseUrl === "" ? { defaultCompany: config.company } : undefined,
      );
      // `null` in the desktop, which has no host at its own origin and never
      // will — see `isAddressableBaseUrl`. Adding one anyway is what made the
      // packaged app open on a connection that could not work and select it,
      // presenting a failure on every launch while the embedded host added
      // below sat healthy and unselected (issue #613).
      //
      // Only the same-origin *default* is refused, not the config path: a
      // desktop given an explicit host through `?api=` or an injected
      // `OPENCOMPANY_CONFIG` still gets its bootstrap connection.
      if (!isAddressableBaseUrl(config.baseUrl)) return null;
      // A hub's own origin serves this bundle and nothing else — there is no
      // host there and there never will be. Adding one anyway reproduces #613
      // in the browser exactly: a connection that cannot work, selected on
      // load, presenting a failure in front of the hosts that are healthy. The
      // hosts a hub knows are the remembered ones, which `restoreConnections`
      // above has already put back.
      //
      // As with the desktop, only the same-origin *default* is refused: a hub
      // opened with an explicit `?api=` still gets its bootstrap connection,
      // which is how a link to one specific host is shared.
      if (config.hub && config.baseUrl === "") return null;
      return addConnection({
        baseUrl: config.baseUrl,
        defaultCompany: config.company,
        credential: config.operatorToken
          ? { kind: "platform", token: config.operatorToken }
          : { kind: "cookie" },
      });
    },
    [config],
  );
  /**
   * The host running inside this application, when there is one.
   *
   * Asked for rather than assumed: the embedded host binds an ephemeral port,
   * so only the core knows its address — and it may not be running at all,
   * most often because another instance holds the data root. `null` then, and
   * the desktop still shows every remote host, which is the point of holding
   * several.
   *
   * Added after the first paint because the address arrives over IPC; the probe
   * effect below picks it up from the id list, so nothing here has to drive it.
   *
   * Registered through `adoptEmbeddedHost` rather than `addConnection`, because
   * this is the one host whose address is *expected* to have changed since last
   * launch — recognising it by that address is what left a dead row behind on
   * every run (#615).
   *
   * Its id is kept because two things need it and neither can find it by
   * sorting: it is what the desktop selects on launch, and — through
   * `resolved` — what tells "not asked yet" apart from "there is no embedded
   * host". Both leave `id` null and they read as opposite things on screen, one
   * a spinner and the other a failure someone has to act on (#613).
   */
  const [embedded, setEmbedded] = useState<EmbeddedState>(() => ({
    // A browser has nothing to ask, so it is resolved before it starts.
    resolved: !isDesktopRuntime(),
    id: null,
    instances: [],
    operatorEmails: {},
  }));

  /**
   * Asks the core what it is running, and reconciles the connection list.
   *
   * Called on launch and after every start, stop, create and removal, rather
   * than each of those patching a local copy of the roster. The core holds the
   * sockets, so it is the only thing that knows which instances are actually
   * listening — a roster mirrored in React is one that disagrees the first time
   * a start fails.
   */
  const refreshLocal = useCallback(async (): Promise<void> => {
    const instances = await localInstances();
    if (instances === null) {
      // A shell predating the roster. It runs exactly one host and answers only
      // `oc_embedded`, so ask that instead — the degrade is exact, not partial.
      const host = await embeddedHost();
      // Adopted once. A second call would re-run the prune against a set it has
      // already reconciled, for a value this one already has.
      const id = host ? adoptLocalHosts([host])[0] : null;
      setEmbedded({
        resolved: true,
        id,
        instances: [],
        operatorEmails: id && host?.operatorEmail ? { [id]: host.operatorEmail } : {},
      });
      return;
    }

    // Only the running ones become connections. A stopped instance has no
    // address, so a row for it could do nothing but fail its probe forever; it
    // is visible — and startable — in the roster instead.
    const running = instances.filter(
      (instance): instance is LocalInstance & { baseUrl: string } =>
        instance.running && typeof instance.baseUrl === "string",
    );
    const ids = adoptLocalHosts(
      running.map((instance) => ({
        baseUrl: instance.baseUrl,
        instanceId: instance.instanceId,
        label: instance.label,
      })),
      // The whole roster, not just the running half. Without it a stopped
      // instance is indistinguishable from a data root this application no
      // longer serves, and the prune forgets its profile — which is the
      // connection id every `scopedKey` under it is named after.
      instances
        .map((instance) => instance.instanceId)
        .filter((id): id is string => id !== undefined),
    );
    const operatorEmails: Record<ConnectionId, string> = {};
    running.forEach((instance, index) => {
      if (instance.operatorEmail) operatorEmails[ids[index]] = instance.operatorEmail;
    });

    setEmbedded({
      resolved: true,
      // The first running instance, which is the one rooted at the data dir on
      // every machine that has not deliberately stopped it. What the desktop
      // opens on when nothing else is selected.
      id: ids[0] ?? null,
      instances,
      operatorEmails,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refreshLocal().catch((error: unknown) => {
      console.error("[desktop] could not read the local hosts", error);
      if (!cancelled) setEmbedded((prior) => ({ ...prior, resolved: true }));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshLocal]);

  const connections = useConnections();
  /**
   * Which console is on screen.
   *
   * Local UI state, deliberately not in the registry. Every connection stays
   * registered and probed regardless of what is selected — selection changes
   * what is *rendered* and nothing else. A selected-connection field in the
   * registry is the single-valued thing that stops buzz from holding two
   * workspaces, and it would undo this slice.
   *
   * `null` until someone chooses, which is the desktop's ordinary state: it has
   * no bootstrap connection to seed this with. What is on screen then is
   * decided by `active` below, not by leaving this pointing at a host that does
   * not exist.
   */
  const [selected, setSelected] = useState<ConnectionId | null>(bootstrapId);

  // A pure read, so StrictMode's double render is harmless.
  const magicLink = useMemo(() => readMagicLink(), []);
  const hubToken = useMemo(() => readHubToken(), []);
  const hubFailed = useMemo(() => readHubError(), []);
  /**
   * The in-flight redemption, so a link is redeemed exactly once.
   *
   * StrictMode double-invokes effects, and a login code is single-use: the
   * second call would spend nothing and 401, bouncing a perfectly good sign-in
   * to the login screen. Both runs await this one promise instead.
   */
  const redemption = useRef<Promise<unknown> | null>(null);
  const [auth, setAuth] = useState<{ ready: boolean; notice?: string; failed?: boolean }>({
    // Nothing to redeem is the common case, and it must not cost a frame.
    ready: !magicLink && !hubToken && !hubFailed,
  });

  // Now that any credential is captured in state, take it out of the URL.
  useEffect(() => {
    if (magicLink) clearMagicLinkFromUrl();
    if (hubToken || hubFailed) clearHubResultFromUrl();
  }, [magicLink, hubToken, hubFailed]);

  /**
   * Redeem a landing credential before any console asks for data.
   *
   * Stays in `App` rather than moving into the console: a magic link arrives on
   * the document URL, which belongs to the app, and it always names the
   * bootstrap connection — there is no way to land on a link for the second
   * host you added yesterday.
   */
  useEffect(() => {
    if (auth.ready) return;
    if (bootstrapId === null) {
      // A landing credential names the bootstrap host, and this runtime has
      // none to redeem it against. Opening the console beats sitting on
      // "Signing in…" forever, waiting on a client that will never exist.
      setAuth({ ready: true });
      return;
    }
    const client = clientFor(bootstrapId);
    if (!client) return;
    let cancelled = false;

    async function redeem() {
      if (hubFailed) {
        if (!cancelled)
          setAuth({
            ready: true,
            failed: true,
            notice: "That sign-in didn't complete. Try again, or use a link below.",
          });
        return;
      }
      if (hubToken) {
        try {
          redemption.current ??= signInWithHubToken(client!, config.company, hubToken);
          await redemption.current;
        } catch (err) {
          if (!cancelled) setAuth({ ready: true, failed: true, notice: hubNotice(err) });
          return;
        }
      }
      if (magicLink) {
        try {
          redemption.current ??= verifyCode(client!, magicLink.company ?? config.company, magicLink.code);
          await redemption.current;
        } catch {
          // A dead link is not fatal — fall through to sign-in and let them ask
          // for another. The reason stays vague on purpose.
          if (!cancelled) setAuth({ ready: true, failed: true });
          return;
        }
      }
      if (!cancelled) setAuth({ ready: true });
    }

    void redeem();
    return () => {
      cancelled = true;
    };
  }, [auth.ready, bootstrapId, config.company, hubFailed, hubToken, magicLink]);

  // Probe every registered connection, independently: one host being slow or
  // unreachable must not hold up another's console.
  //
  // Keyed on the *ids*, not the connection objects. Every status change emits a
  // fresh array, so depending on the array would re-run this on each one — and
  // `probe` itself sets `connecting`, which is a status change. The registry's
  // in-flight guard makes that safe regardless; this keeps it from happening.
  const connectionIds = connections.map((c) => c.id).join(",");
  useEffect(() => {
    // Redemption must land first: a probe before it would read a session that
    // does not exist yet and park the bootstrap row on `unauthenticated`.
    if (!auth.ready) return;
    for (const id of connectionIds.split(",").filter(Boolean)) {
      void probe(id);
    }
  }, [auth.ready, connectionIds]);

  if (!auth.ready) {
    return (
      <FullScreen>
        <Waiting>Signing in…</Waiting>
      </FullScreen>
    );
  }

  /**
   * Which connection is rendered, in the order these questions get answers.
   *
   * The embedded host comes before "whichever is first" deliberately. Restored
   * hosts are added before it — its port only arrives over IPC — so position in
   * the list is a record of when a host was learned about, not of which one a
   * person opening the desktop means. A launch that lands on someone's remote
   * host because they added it last Tuesday is the same bug as #613 wearing
   * different clothes.
   *
   * Which is also why the last fall-through waits for `resolved`. Until the
   * core answers, "no embedded host" and "not asked yet" are indistinguishable
   * from the list alone, and taking the first entry in the meantime opens a
   * remembered host — mounting its console and issuing its requests — only to
   * replace it a moment later. A brief wrong host is a smaller version of the
   * same bug, so the desktop holds its startup state instead. A browser never
   * waits: `resolved` starts `true` there, because there is nothing to ask.
   */
  const active =
    connections.find((c) => c.id === selected) ??
    connections.find((c) => c.id === embedded.id) ??
    (embedded.resolved ? connections[0] : undefined);
  const client = active ? clientFor(active.id) : undefined;

  // Everything the switcher needs, assembled once and carried down by context.
  //
  // Context rather than props because the switcher now lives in the sidebar
  // header — two layers below here, inside `ConnectionConsole` — and threading
  // eight fields through a component whose job is a phase machine would put the
  // whole roster in the way of every one of its states.
  const hosts: HostsValue = {
    connections,
    selected: active?.id ?? null,
    onSelect: setSelected,
    onAdd: (baseUrl) => {
      const id = addConnection({ baseUrl });
      setSelected(id);
      void probe(id);
    },
    localInstances: embedded.instances,
    // Only offered where a host can actually be started: the browser build has
    // no core to start one in, and passing handlers it cannot honour would put
    // a button on screen that always fails.
    onAddLocal: isDesktopRuntime()
      ? async (label) => {
          const created = await createLocalInstance(label);
          await refreshLocal();
          // Selected straight away: someone who just created a company means to
          // open it, and the alternative is a new row they have to find.
          if (created.instanceId) {
            const opened = listConnections().find(
              (c) => c.identity?.instanceId === created.instanceId,
            );
            if (opened) setSelected(opened.id);
          }
        }
      : undefined,
    onStartLocal: isDesktopRuntime()
      ? async (id) => {
          await startLocalInstance(id);
          await refreshLocal();
        }
      : undefined,
    onStopLocal: isDesktopRuntime()
      ? async (id) => {
          await stopLocalInstance(id);
          await refreshLocal();
        }
      : undefined,
    hub: Boolean(config.hub),
  };

  return (
    <HostsProvider value={hosts}>
      <div className="min-h-svh">
        {active && client ? (
          // Keyed by connection: switching hosts remounts rather than
          // reconciling, so no view can carry one host's in-flight state into
          // another's render.
          <ConnectionConsole
            key={active.id}
            connectionId={active.id}
            client={client}
            defaultCompany={active.defaultCompany}
            notice={active.id === bootstrapId ? auth.notice : undefined}
            forceLogin={active.id === bootstrapId && auth.failed === true}
            // Only ever the embedded host's own operator. Offering it on a
            // remote connection would put a local address in front of someone
            // signing in to a server that has never heard of it.
            suggestedEmail={embedded.operatorEmails[active.id]}
          />
        ) : (
          // The switcher rides along, because an operator whose local host is
          // gone still has somewhere else to connect to — and "Add a host" is
          // the only way out of a desktop that holds none.
          <ConsoleChrome>
            <NoConnection starting={!embedded.resolved} />
          </ConsoleChrome>
        )}
      </div>
      {/* Beside the console rather than inside it: creating a host on this
          computer selects it, and that remounts the console. A dialog mounted
          within would take itself off screen at the moment it succeeded. */}
      <AddHostDialog />
    </HostsProvider>
  );
}

/** Where the hosts on this machine got to, and what they turned into. */
interface EmbeddedState {
  /** Whether the core has answered. `false` only ever means "still asking". */
  resolved: boolean;
  /**
   * The connection the *first running* local instance became, or `null` when
   * none is running. What the desktop opens on.
   */
  id: ConnectionId | null;
  /**
   * Every local instance the core knows about, running or not.
   *
   * The stopped ones are here and nowhere else: they have no address, so they
   * cannot be connections. The switcher's "Add a host" dialog is where they
   * are startable.
   */
  instances: LocalInstance[];
  /**
   * The address each local connection signs a person in as (#632), by
   * connection id.
   *
   * Per connection rather than one field, because with a roster there are
   * several — and offering one host's operator address on another host's login
   * form is how a person signs in to the wrong company.
   */
  operatorEmails: Record<ConnectionId, string>;
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh place-items-center bg-background p-6 text-center">
      {children}
    </div>
  );
}

function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {children}
    </div>
  );
}

/**
 * What to show when there is no connection at all.
 *
 * The browser build cannot reach this: its bootstrap connection exists whether
 * or not the host answers, and an unreachable one is a *console* rendering an
 * error rather than an absence. The desktop genuinely can — it holds only the
 * hosts it was told about, and the embedded one may not have started.
 *
 * The host switcher stays on screen above this (see `ConsoleChrome`), because
 * an operator whose local host is gone still has somewhere else to connect to,
 * and this is the state in which that matters most.
 */
function NoConnection({ starting }: { starting: boolean }) {
  return (
    <FullScreen>
      {starting ? (
        <Waiting>
          <span data-testid="no-connection-starting">Starting the host on this computer…</span>
        </Waiting>
      ) : (
        <div className="max-w-sm space-y-2" data-testid="no-connection">
          <p className="text-sm font-medium">No host to show</p>
          <p className="text-sm text-muted-foreground">
            The host on this computer didn't start — another copy of OpenCompany may be
            holding its data. Quit the other copy and reopen this one, or add a host from
            the switcher above.
          </p>
        </div>
      )}
    </FullScreen>
  );
}

/**
 * What to tell someone whose ecosystem sign-in did not work.
 *
 * Each line is about the *credential* or the *host*, never about the person:
 * "expired", "no access yet", "not connected". None of them confirms or denies
 * that any address has an account here, which is the rule the whole sign-in
 * surface is built around.
 */
function hubNotice(err: unknown): string {
  const code = err instanceof ApiError ? err.code : "";
  switch (code) {
    case "hub_rejected":
      return "That sign-in expired. Try again, or use a link below.";
    case "not_a_member":
      return "You're signed in to TinyHumans, but this company hasn't given you access yet. Ask an admin to invite you.";
    case "hub_unavailable":
      return "This host isn't connected to a TinyHumans account. Sign in with a link instead.";
    default:
      return "We couldn't complete that sign-in. Try a link below.";
  }
}

