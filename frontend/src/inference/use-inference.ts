// The inference page's data: one read, one set of writes, one place they land.
//
// Both tabs render from this. Two hooks would be two reads of the same status,
// and the first thing that goes wrong with two reads is that one of them is
// stale — the Providers tab showing a provider the Routing tab has no target
// for, or the reverse.
//
// **No decisions here either.** This is fetching, in-flight state, and where a
// response lands. Which provider a category offers, what a probe class means,
// what a removal orphans — all of that is in `connect.ts`, `classify.ts` and
// `routing.ts`, as functions over plain data.

import { useCallback, useEffect, useState } from "react";

import { toast } from "sonner";

import { ApiError } from "@/api/types";
import type { OpenCompanyClient } from "@/api/client";
import {
  addProvider,
  deleteProvider,
  editProvider,
  getInferenceStatus,
  getRoutes,
  probeDraft,
  putRoutes,
  restartInference,
  setDefaultProvider,
  setManagedEnabled,
  setManagedKey,
  setProviderEnabled,
  testManaged,
  testProvider,
} from "@/api/inference";
import type {
  AddProviderInput,
  EditProviderInput,
  InferenceStatus,
  ProbeResult,
  ProviderMutation,
} from "@/api/inference";
import { WORKLOADS, WORKLOAD_TIER, inferRoutingMode, parseRef } from "./routing";
import type { Provider, RoutingMap, RoutingMode } from "./types";

/** What the page is doing. */
export type InferenceLoad = "loading" | "ready" | "unavailable" | "error";

/** What the page holds. */
export interface InferenceState {
  load: InferenceLoad;
  status: InferenceStatus | null;
  providers: Provider[];
  /** Tier → route string. */
  routes: Record<string, string>;
  mode: RoutingMode;
  /** Routes naming a provider this company does not hold. */
  orphaned: [string, string][];
  /** The slug currently mid-request, so one row's controls settle rather than the page. */
  busySlug: string | null;
}

/** The mutations the page can perform. */
export interface InferenceActions {
  reload: () => Promise<void>;
  add: (input: AddProviderInput) => Promise<ProviderMutation>;
  edit: (slug: string, input: EditProviderInput) => Promise<ProviderMutation>;
  remove: (slug: string) => Promise<ProviderMutation>;
  setEnabled: (slug: string, enabled: boolean) => Promise<ProviderMutation>;
  makeDefault: (slug: string) => Promise<ProviderMutation>;
  saveManagedKey: (key: string) => Promise<ProviderMutation>;
  setManagedOn: (enabled: boolean) => Promise<ProviderMutation>;
  testManagedChain: () => Promise<ProbeResult>;
  /**
   * Ask an endpoint what it publishes, **before** anything is written.
   *
   * The add dialog needs this to offer a model: an endpoint whose catalog
   * resolves no tier name cannot serve a workload until one is named, and the
   * only honest moment to ask is with that endpoint's own list in hand. Nothing
   * is stored — the draft's key travels one way and is never written by this.
   */
  probeDraftEndpoint: (draft: { baseUrl: string; key?: string; kind?: string }) => Promise<ProbeResult>;
  test: (slug: string, model?: string) => Promise<ProbeResult>;
  saveRoutes: (routes: Record<string, string>) => Promise<void>;
  restart: () => Promise<void>;
}

/**
 * The inference page's state and its writes.
 *
 * Every mutation re-reads the status from its own response rather than firing a
 * second GET: the host answers each write with the whole status precisely so
 * that the console never has to reconcile a partial update against what it
 * already had. A second read would also be a second chance to race.
 */
export function useInference(
  client: OpenCompanyClient,
  company: string | null,
): InferenceState & InferenceActions {
  const [load, setLoad] = useState<InferenceLoad>("loading");
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<RoutingMode>("managed");
  const [orphaned, setOrphaned] = useState<[string, string][]>([]);
  const [busySlug, setBusySlug] = useState<string | null>(null);


  const reload = useCallback(async () => {
    try {
      const next = await getInferenceStatus(client, company);
      setStatus(next);
      setLoad("ready");
      try {
        const table = await getRoutes(client, company);
        setRoutes(table.routes);
        setMode(table.mode);
        setOrphaned(table.orphaned);
      } catch (err) {
        // A member rather than an admin reads the status fine and is refused
        // the routing table, which is an authority answer rather than a broken
        // page. Leaving the state alone was the wrong answer twice over: the
        // read-only Routing tab then showed every workload on its default and
        // the mode as Managed, which is a claim about this company nobody
        // made — and on a company switch it showed the *previous* company's
        // routes, which is worse than showing none.
        //
        // The status carries the same table, so the honest fill is the one the
        // caller already has. The mode is derived from it here rather than read
        // off a second response, for the same reason the host derives it: a
        // stored mode is a fifth thing that can disagree with the four routes.
        if (!(err instanceof ApiError && err.status === 403)) throw err;
        const readable = next.routes ?? {};
        setRoutes(readable);
        setMode(
          inferRoutingMode(
            Object.fromEntries(
              WORKLOADS.map((w) => [w, parseRef(readable[WORKLOAD_TIER[w]] ?? "")]),
            ) as RoutingMap,
            next.managed?.configured === true,
          ),
        );
        // Orphans are an admin's to clear, and this reader cannot. Saying
        // nothing is right; carrying the last company's list is not.
        setOrphaned([]);
      }
    } catch (err) {
      // A host that does not serve this route at all is not an error worth a
      // banner — the page simply is not available on that build.
      setLoad(err instanceof ApiError && err.status === 404 ? "unavailable" : "error");
    }
  }, [client, company]);

  useEffect(() => {
    setLoad("loading");
    void reload();
  }, [reload]);

  /**
   * Runs a provider write, parking the row it touches and landing the result.
   *
   * **The outcome is a toast, and a failure is never silent.** These used to
   * land as one line of grey prose under the card — including "Anthropic is
   * disconnected and its key is cleared", which is the most destructive thing
   * this page does — while the callers invoked them as bare `void`, so a
   * rejection went nowhere at all. An action's result belongs beside the action
   * in time, not folded into the page as though it were a standing fact about
   * the company.
   *
   * The error is re-thrown as well as toasted: a form that is still open shows
   * its own failure inline, where the field the operator has to correct is.
   */
  const write = useCallback(
    async (slug: string | null, run: () => Promise<ProviderMutation>) => {
      setBusySlug(slug);
      try {
        const result = await run();
        setStatus(result.status);
        // The host's own sentence, which already names the provider it is about.
        toast.success(result.note);
        // A delete or a disable can move routes, so the table is re-read rather
        // than assumed unchanged. It is the one thing a provider write can
        // change that the write's own response does not carry *in full* — the
        // orphan list is only on the routing route.
        try {
          const table = await getRoutes(client, company);
          setRoutes(table.routes);
          setMode(table.mode);
          setOrphaned(table.orphaned);
        } catch {
          // Refused (a member) or simply failed. Either way the write itself
          // succeeded, and the status it answered with carries the persisted
          // table — so the routing state follows the write rather than staying
          // at its pre-write value. Leaving it alone showed routes to a
          // provider the Providers tab had just removed, and the next edit
          // would have been computed from that stale table.
          const persisted = result.status.routes ?? {};
          setRoutes(persisted);
          setMode(
            inferRoutingMode(
              Object.fromEntries(
                WORKLOADS.map((w) => [w, parseRef(persisted[WORKLOAD_TIER[w]] ?? "")]),
              ) as RoutingMap,
              result.status.managed?.configured === true,
            ),
          );
          // Orphans are only known to the routing route, and we did not get it.
          setOrphaned([]);
        }
        return result;
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "That change could not be saved.");
        throw err;
      } finally {
        setBusySlug(null);
      }
    },
    [client, company],
  );

  return {
    load,
    status,
    providers: status?.providers ?? [],
    routes,
    mode,
    orphaned,
    busySlug,
    reload,
    add: (input) => write(null, () => addProvider(client, company, input)),
    edit: (slug, input) => write(slug, () => editProvider(client, company, slug, input)),
    remove: (slug) => write(slug, () => deleteProvider(client, company, slug)),
    setEnabled: (slug, enabled) =>
      write(slug, () => setProviderEnabled(client, company, slug, enabled)),
    makeDefault: (slug) => write(slug, () => setDefaultProvider(client, company, slug)),
    saveManagedKey: (key) => write(null, () => setManagedKey(client, company, key)),
    setManagedOn: (enabled) => write(null, () => setManagedEnabled(client, company, enabled)),
    probeDraftEndpoint: (draft) => probeDraft(client, company, draft),
    testManagedChain: async () => {
      const result = await testManaged(client, company);
      // The test records health against the managed slug, and the row renders
      // it — so the status has to be re-read or the row keeps showing what it
      // knew before the operator asked.
      setStatus(await getInferenceStatus(client, company));
      // Same rule as a provider's test: the answer is the row's, not the page's.
      return result;
    },
    test: async (slug, model) => {
      setBusySlug(slug);
      try {
        const result = await testProvider(client, company, slug, model);
        // The test writes a health record, and the row renders it — so the
        // status has to be re-read or the row keeps showing what it knew before
        // the operator asked.
        setStatus(await getInferenceStatus(client, company));
        // **No page-level note.** A test's answer belongs to the row that asked
        // — with two providers connected, a line under the card says nothing
        // about which one was tested, which is the bug moving the control fixed.
        return result;
      } finally {
        setBusySlug(null);
      }
    },
    saveRoutes: async (next) => {
      const table = await putRoutes(client, company, next);
      setRoutes(table.routes);
      setMode(table.mode);
      setOrphaned(table.orphaned);
      toast.success("Routing saved. It takes effect on the next turn.");
    },
    restart: async () => {
      const result = await restartInference(client, company);
      setStatus(result.status);
      toast.success(result.note);
    },
  };
}
