// The Composio credential, read once for whichever page is asking.
//
// ## Why this is a hook and not two copies of an effect
//
// Apps (`OAuthView`) and Composio (`ComposioView`) are separate pages now, and
// `OAuthView`'s own header used to argue at length that they could not be —
// that `ComposioSection` only *looks* self-contained, because `ProvidersSection`
// reads the credential's `credentialSource`, `granted`, `openMode` and catalog
// warning to decide what every provider tile renders.
//
// That dependency is real and it is unchanged. What the argument got wrong is
// that it is a **data** dependency rather than a layout one: what the provider
// grid needs is the credential's *state*, not the credential's *form* sitting
// above it in the same scroll. So the two surfaces split and the state lifts
// here, where there is exactly one implementation of the read and both pages
// mount it. A page that fetched this for itself is precisely the failure the
// old comment was guarding against — two surfaces disagreeing about whether the
// company has a credential (issue #582, and #586 for the re-probe below).
//
// A hook rather than a container above both: they are separate routes, so only
// one is ever mounted, and a provider in `ConnectionsSection` would probe
// Composio on MCP Servers, Hosting and Search as well — four pages paying for a
// read that two of them need.

import { useCallback, useEffect, useState } from "react";

import { me as fetchMe } from "@/api/auth";
import type { OpenCompanyClient } from "@/api/client";
import {
  CATALOG_READ_TIMEOUT_MS,
  getComposioStatus,
  type ComposioStatus,
} from "@/api/composio";
import { classifyLoadFailure } from "@/lib/section-load";

export interface ComposioCredential {
  /**
   * The host's Composio answer, or `null` while unknown / not reachable.
   *
   * The whole status, not the routing facts it could be narrowed to: the
   * provider grid is built from `effectiveCatalog` (issue #582) and the
   * catalog's honesty markers (`catalogSource`, `catalogNotice`) travel with it.
   * Narrowing here and re-fetching the same call elsewhere for the rest is how
   * the Apps page once came to have two provider lists.
   */
  status: ComposioStatus | null;
  /**
   * Whether this instance carries a platform-projected identity, as Composio
   * reports it. A second witness for the same host-level fact the connection
   * rows carry — and the only one available when the manifest declares no
   * connections, which is exactly when the #319 guard used to go dark.
   */
  attested: boolean;
  /**
   * Whether the probe has answered at all. The grid must not paint before it
   * has: the connections read routinely resolves first, and a tile rendered on
   * a null reach reads "Not available on this host" — so every tile would flash
   * that and then flip to Connect a moment later.
   */
  settled: boolean;
  /**
   * Whether the probe could not be answered. Distinct from `status === null`,
   * which is also what a genuine "no Composio surface" answer sets — collapsing
   * the two renders "we could not check" as a confident "this host has no
   * providers to offer yet".
   */
  failed: boolean;
  /**
   * Whether this viewer may change what the company connects through (issue
   * #403). A connection belongs to the company, so changing one is an admin's
   * call; reading it is everyone's.
   *
   * **Courtesy, not enforcement.** The host refuses every write on either page
   * with a 403 whatever this says. All hiding the controls prevents is offering
   * an operator a button that cannot work — which here would be a particularly
   * poor greeting, since the failure arrives only after they have pasted a live
   * credential into a form that could never submit it.
   */
  canManage: boolean;
  /**
   * Bumped on every credential change, to remount the sections whose reported
   * tier is downstream of it (issue #586).
   */
  generation: number;
  /** Say the credential changed: re-probes, and bumps {@link generation}. */
  changed: () => void;
}

/** The Composio credential as both pages under Connections read it. */
export function useComposioCredential(
  client: OpenCompanyClient,
  company: string | null,
): ComposioCredential {
  const [status, setStatus] = useState<ComposioStatus | null>(null);
  const [attested, setAttested] = useState(false);
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [generation, setGeneration] = useState(0);

  const changed = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    setSettled(false);
    setFailed(false);
    void (async () => {
      try {
        // Bounded and cancellable through the client itself. The bound must
        // outlast the host's own upstream-catalog budget, or a cold catalog is
        // abandoned at exactly the moment the host is about to answer with its
        // flagged fallback — and the grid renders "couldn't check" for a host
        // that could have explained itself.
        const probed = await getComposioStatus(client, company, {
          timeoutMs: CATALOG_READ_TIMEOUT_MS,
          signal: abort.signal,
        });
        if (!live) return;
        setStatus(probed);
        setAttested(probed?.credentialSource === "attested");
      } catch (err) {
        // A read the page tore down itself — a company switch, an unmount —
        // says nothing about the host, so it must not leave a warning behind.
        if (err instanceof Error && err.name === "AbortError") return;
        // A 404 is the honest "no Composio surface on this host": leave the
        // page in its no-route state. Anything else — a 5xx, an offline
        // network, an expired session, a host that did not answer in time — is
        // UNKNOWN, not absent, and says so.
        if (live) {
          setStatus(null);
          setAttested(false);
          if (classifyLoadFailure(err) === "error") setFailed(true);
        }
      } finally {
        if (live) setSettled(true);
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
    // `generation` is load-bearing, not decoration: this probe feeds the grid's
    // route and `attested`, both of which are downstream of the company
    // credential. Setting a key flips `credentialSource` from `none` to
    // `company`, and without a re-probe the grid would keep every tile on the
    // "no credential" route while the Composio page correctly reported the
    // opposite (issue #586). It is also what makes the split safe: the Apps
    // page re-reads this on mount, so a key set on the Composio page is already
    // true of the tiles by the time the operator arrives back at them.
  }, [client, company, generation]);

  useEffect(() => {
    let live = true;
    void (async () => {
      let admin = false;
      try {
        admin = (await fetchMe(client, company)).role === "admin";
      } catch {
        // No user plane on this host, or not signed in — treat as non-admin.
      }
      if (live) setCanManage(admin);
    })();
    return () => {
      live = false;
    };
  }, [client, company]);

  return { status, attested, settled, failed, canManage, generation, changed };
}
